/**
 * Vault — encrypted secrets for the agent (OAuth tokens, Firebase service
 * account, site passwords for `browser_fill_secret`).
 *
 * AES-256-GCM, one record per secret, stored in `~/.codiby/agent/vault.json`
 * (0600). The data key comes from, in order:
 *   1. `CODIBY_VAULT_KEY` (base64, 32 bytes) — for containers;
 *   2. the macOS Keychain (service "codiby-agent-vault") on darwin;
 *   3. `~/.config/codiby/vault.key` (0600) elsewhere, when the Keychain is
 *      off (`CODIBY_VAULT_NO_KEYCHAIN=1`) or a Keychain write failed.
 * Under `bun test` the key lives in the sandbox data dir.
 *
 * Values never leave the server: there is no route or tool that returns a
 * secret's value, only its name and timestamps.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { CODIBY_DIR } from '../config/config';
import { log, logError } from '../lib/logger';
import { agentDataDir, readJson, writeJsonAtomic } from './store';

interface VaultRecord {
  iv: string;
  tag: string;
  data: string;
  updatedAt: number;
}

interface VaultFile {
  version: 1;
  entries: Record<string, VaultRecord>;
}

const VAULT_FILE = agentDataDir('vault.json');
const KEYCHAIN_SERVICE = 'codiby-agent-vault';
const KEYCHAIN_ACCOUNT = 'codiby';

let cachedKey: Buffer | null = null;

/** Tests only: a private vault, key file and `security` stand-in (see `_setVaultTestHooks`). */
interface VaultTestHooks {
  vaultFile?: string;
  keyFile?: string;
  /** Pretend this is a Mac that uses the Keychain (still overridden by CODIBY_VAULT_NO_KEYCHAIN). */
  keychain?: boolean;
  spawn?: SecuritySpawn;
}
let testHooks: VaultTestHooks | null = null;

function vaultFile(): string {
  return testHooks?.vaultFile ?? VAULT_FILE;
}

function keyFilePath(): string {
  if (testHooks?.keyFile) return testHooks.keyFile;
  if (process.env.NODE_ENV === 'test') return join(CODIBY_DIR, 'vault.key');
  return join(homedir(), '.config', 'codiby', 'vault.key');
}

function decodeKey(b64: string): Buffer | null {
  try {
    const buf = Buffer.from(b64.trim(), 'base64');
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

/** `security` exits with errSecItemNotFound (44) when there is no such item. */
const SEC_ITEM_NOT_FOUND = 44;

/**
 * `security` runs synchronously, so while it waits — on a Keychain prompt
 * nobody is there to answer, a locked login keychain, a wedged securityd —
 * the whole bridge waits with it. Five seconds is far more than a healthy
 * lookup takes.
 */
export const SECURITY_TIMEOUT_MS = 5_000;

/** The slice of `Bun.spawnSync`'s result the vault reads. */
export interface SecuritySpawnResult {
  exitCode: number | null;
  stdout: { toString(): string };
  stderr: { toString(): string };
  signalCode?: string | null;
  exitedDueToTimeout?: boolean;
}
export type SecuritySpawn = (cmd: string[], opts: { timeout: number; stdout: 'pipe'; stderr: 'pipe' }) => SecuritySpawnResult;

const defaultSpawn: SecuritySpawn = (cmd, opts) => Bun.spawnSync(cmd, opts);

type SecurityOutcome =
  | { ok: true; stdout: string }
  /** `notFound` only for errSecItemNotFound; every other failure (timeout included) may hide an existing item. */
  | { ok: false; notFound: boolean; reason: string };

function runSecurity(args: string[]): SecurityOutcome {
  let res: SecuritySpawnResult;
  try {
    res = (testHooks?.spawn ?? defaultSpawn)(['security', ...args], { timeout: SECURITY_TIMEOUT_MS, stdout: 'pipe', stderr: 'pipe' });
  } catch (err) {
    return { ok: false, notFound: false, reason: `could not run security: ${err instanceof Error ? err.message : err}` };
  }
  // Checked before the exit code: a killed process has none, and a timed-out
  // lookup says nothing about whether the item exists.
  if (res.exitedDueToTimeout) return { ok: false, notFound: false, reason: `timed out after ${SECURITY_TIMEOUT_MS / 1000}s` };
  if (res.exitCode === 0) return { ok: true, stdout: res.stdout.toString() };
  if (res.exitCode === SEC_ITEM_NOT_FOUND) return { ok: false, notFound: true, reason: 'not found' };
  const detail = res.exitCode == null ? `killed by ${res.signalCode || 'a signal'}` : `exit ${res.exitCode}`;
  const stderr = res.stderr.toString().trim();
  return { ok: false, notFound: false, reason: stderr ? `${detail}: ${stderr}` : detail };
}

/**
 * `unreadable` — the item may exist but could not be read (keychain locked,
 * access denied, `security` timed out…). Only "not found" means there is no
 * key yet.
 */
function keychainRead(): { key: Buffer | null; unreadable: boolean } {
  const res = runSecurity(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w']);
  if (res.ok) return { key: decodeKey(res.stdout), unreadable: false };
  if (!res.notFound) logError(`[vault] Keychain read failed (${res.reason})`);
  return { key: null, unreadable: !res.notFound };
}

function keychainWrite(key: Buffer): { ok: boolean; reason?: string } {
  const res = runSecurity(['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w', key.toString('base64')]);
  return res.ok ? { ok: true } : { ok: false, reason: res.reason };
}

function fileKeyRead(): Buffer | null {
  const p = keyFilePath();
  if (!existsSync(p)) return null;
  try { return decodeKey(readFileSync(p, 'utf-8')); } catch { return null; }
}

function fileKeyWrite(key: Buffer): void {
  const p = keyFilePath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, key.toString('base64'), { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch {}
}

/**
 * The one gate for every `security` call. `CODIBY_VAULT_NO_KEYCHAIN` is
 * checked first so nothing — not even a test hook — reaches the Keychain
 * when it is set (throwaway bridges, CI, containers on a Mac).
 */
function useKeychain(): boolean {
  if (process.env.CODIBY_VAULT_NO_KEYCHAIN) return false;
  if (testHooks?.keychain !== undefined) return testHooks.keychain;
  return process.platform === 'darwin' && process.env.NODE_ENV !== 'test';
}

/** Store a freshly minted key; returns where it really went (for the log). */
function storeNewKey(key: Buffer): string {
  if (useKeychain()) {
    const res = keychainWrite(key);
    if (res.ok) return `macOS Keychain, service "${KEYCHAIN_SERVICE}"`;
    logError(`[vault] Keychain write failed (${res.reason}) — keeping the key in ${keyFilePath()} instead`);
  }
  fileKeyWrite(key);
  return keyFilePath();
}

function dataKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.CODIBY_VAULT_KEY ? decodeKey(process.env.CODIBY_VAULT_KEY) : null;
  if (process.env.CODIBY_VAULT_KEY && !fromEnv) throw new Error('CODIBY_VAULT_KEY must be 32 bytes, base64-encoded');
  const keychain = !fromEnv && useKeychain() ? keychainRead() : { key: null, unreadable: false };
  let key = fromEnv ?? keychain.key ?? fileKeyRead();
  if (!key) {
    // Minting a key now would overwrite the Keychain item (`-U`) or orphan
    // every stored secret — OAuth tokens, channel credentials — for good.
    // Fail this call instead (nothing is cached) so a later one can retry.
    if (keychain.unreadable || Object.keys(load().entries).length > 0) {
      throw new Error('Vault key unavailable (Keychain locked or not answering, or key file missing) — refusing to create a new one over existing secrets');
    }
    key = randomBytes(32);
    log(`[vault] Created a new data key (${storeNewKey(key)})`);
  }
  cachedKey = key;
  return key;
}

function load(): VaultFile {
  const raw = readJson<VaultFile | null>(vaultFile(), null);
  if (!raw || raw.version !== 1 || typeof raw.entries !== 'object') return { version: 1, entries: {} };
  return raw;
}

function save(v: VaultFile): void {
  writeJsonAtomic(vaultFile(), v, 0o600);
}

const NAME_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

function checkName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`Invalid secret name "${name}" (letters, digits, . _ : -; max 128)`);
}

export function setSecret(name: string, value: string): void {
  checkName(name);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey(), iv);
  // Bind the ciphertext to its name so records can't be swapped between names.
  cipher.setAAD(Buffer.from(name));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const v = load();
  v.entries[name] = {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
    updatedAt: Date.now(),
  };
  save(v);
}

/** Own records only: `entries` is a plain object, so `toString` or `constructor` would otherwise "exist". */
function entry(v: VaultFile, name: string): VaultRecord | null {
  return Object.hasOwn(v.entries, name) ? v.entries[name]! : null;
}

/** Server-side only. Never return this value to a model, a log or an HTTP response. */
export function getSecret(name: string): string | null {
  const rec = entry(load(), name);
  if (!rec) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', dataKey(), Buffer.from(rec.iv, 'base64'));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(Buffer.from(rec.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(rec.data, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    logError(`[vault] Could not decrypt "${name}" (wrong key or tampered record)`);
    return null;
  }
}

export function getSecretJson<T>(name: string): T | null {
  const raw = getSecret(name);
  if (raw == null) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export function setSecretJson(name: string, value: unknown): void {
  setSecret(name, JSON.stringify(value));
}

export function hasSecret(name: string): boolean {
  return !!entry(load(), name);
}

export function deleteSecret(name: string): boolean {
  const v = load();
  if (!entry(v, name)) return false;
  delete v.entries[name];
  save(v);
  return true;
}

/** Names and timestamps only. `prefix` filters, e.g. 'site:' for browser logins. */
export function listSecrets(prefix = ''): { name: string; updatedAt: number }[] {
  return Object.entries(load().entries)
    .filter(([name]) => name.startsWith(prefix))
    .map(([name, rec]) => ({ name, updatedAt: rec.updatedAt }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Tests only. */
export function _resetVaultKeyCache(): void {
  cachedKey = null;
}

/** Tests only: `null` restores the real files and `security`. Drops the cached key either way. */
export function _setVaultTestHooks(hooks: VaultTestHooks | null): void {
  testHooks = hooks;
  cachedKey = null;
}
