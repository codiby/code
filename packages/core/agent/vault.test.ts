import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomBytes } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SECURITY_TIMEOUT_MS, _setVaultTestHooks, getSecret, setSecret, type SecuritySpawn, type SecuritySpawnResult } from './vault';

/** A `security` stand-in: answers find/add from `script`, records every call. */
function fakeSecurity(script: { find?: () => SecuritySpawnResult; add?: () => SecuritySpawnResult }) {
  const calls: { args: string[]; timeout: number }[] = [];
  const spawn: SecuritySpawn = (cmd, opts) => {
    calls.push({ args: cmd.slice(1), timeout: opts.timeout });
    const verb = cmd[1];
    const answer = verb === 'find-generic-password' ? script.find : verb === 'add-generic-password' ? script.add : undefined;
    return answer ? answer() : exit(1);
  };
  return { spawn, calls };
}

const exit = (code: number, stdout = '', stderr = ''): SecuritySpawnResult => ({ exitCode: code, stdout, stderr });
// What Bun.spawnSync reports when `timeout` kills the child.
const timedOut = (): SecuritySpawnResult => ({ exitCode: null, stdout: '', stderr: '', signalCode: 'SIGTERM', exitedDueToTimeout: true });

describe('vault key and the macOS Keychain', () => {
  let dir: string;
  let logs: string[];
  let spies: { mockRestore(): void }[];
  const prevNoKeychain = process.env.CODIBY_VAULT_NO_KEYCHAIN;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codiby-vault-'));
    logs = [];
    const record = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    spies = [spyOn(console, 'log').mockImplementation(record), spyOn(console, 'error').mockImplementation(record)];
    delete process.env.CODIBY_VAULT_NO_KEYCHAIN;
  });

  afterEach(() => {
    _setVaultTestHooks(null);
    for (const s of spies) s.mockRestore();
    if (prevNoKeychain === undefined) delete process.env.CODIBY_VAULT_NO_KEYCHAIN;
    else process.env.CODIBY_VAULT_NO_KEYCHAIN = prevNoKeychain;
    rmSync(dir, { recursive: true, force: true });
  });

  const hooks = (spawn: SecuritySpawn) => ({ vaultFile: join(dir, 'vault.json'), keyFile: join(dir, 'vault.key'), keychain: true, spawn });

  test('every security call carries the 5 s timeout', () => {
    const sec = fakeSecurity({ find: () => exit(44), add: () => exit(0) });
    _setVaultTestHooks(hooks(sec.spawn));
    setSecret('test:a', 'x');
    expect(sec.calls.map(c => c.args[0])).toEqual(['find-generic-password', 'add-generic-password']);
    expect(sec.calls.every(c => c.timeout === SECURITY_TIMEOUT_MS)).toBe(true);
    expect(SECURITY_TIMEOUT_MS).toBe(5_000);
  });

  test('a lookup that times out is a failure, never "no key yet": nothing is minted', () => {
    const sec = fakeSecurity({ find: timedOut, add: () => exit(0) });
    _setVaultTestHooks(hooks(sec.spawn));
    expect(() => setSecret('test:a', 'x')).toThrow(/Vault key unavailable/);
    // No write to the Keychain (it would overwrite the real item with -U) and no key file.
    expect(sec.calls.some(c => c.args[0] === 'add-generic-password')).toBe(false);
    expect(existsSync(join(dir, 'vault.key'))).toBe(false);
    expect(logs.join('\n')).toMatch(/Keychain read failed \(timed out after 5s\)/);
    expect(logs.join('\n')).not.toMatch(/Created a new data key/);
  });

  test('a lookup killed by a signal, or security failing to start, is a failure too', () => {
    for (const find of [() => exit(null as unknown as number), () => { throw new Error('ENOENT security'); }]) {
      const sec = fakeSecurity({ find: find as () => SecuritySpawnResult, add: () => exit(0) });
      _setVaultTestHooks(hooks(sec.spawn));
      expect(() => setSecret('test:a', 'x')).toThrow(/Vault key unavailable/);
      expect(sec.calls.some(c => c.args[0] === 'add-generic-password')).toBe(false);
    }
  });

  test('a timeout after the key was minted fails the call; the next one reads the key again', () => {
    const key = randomBytes(32).toString('base64');
    let slow = false;
    const sec = fakeSecurity({ find: () => (slow ? timedOut() : exit(0, `${key}\n`)), add: () => exit(0) });
    _setVaultTestHooks(hooks(sec.spawn));
    setSecret('test:keep', 'precious');
    // A later process start finds the Keychain unresponsive.
    slow = true;
    _setVaultTestHooks(hooks(sec.spawn));
    expect(getSecret('test:keep')).toBeNull();
    expect(sec.calls.some(c => c.args[0] === 'add-generic-password')).toBe(false);
    slow = false;
    _setVaultTestHooks(hooks(sec.spawn));
    expect(getSecret('test:keep')).toBe('precious');
  });

  test('the new-key log names the Keychain only when the Keychain took it', () => {
    const sec = fakeSecurity({ find: () => exit(44), add: () => exit(0) });
    _setVaultTestHooks(hooks(sec.spawn));
    setSecret('test:a', 'x');
    expect(logs.join('\n')).toMatch(/Created a new data key \(macOS Keychain, service "codiby-agent-vault"\)/);
    expect(existsSync(join(dir, 'vault.key'))).toBe(false);
  });

  test('a Keychain write that fails or times out falls back to the key file, and the log says so', () => {
    for (const add of [timedOut, () => exit(45, '', 'security: SecKeychainItemCreateFromContent: denied')]) {
      rmSync(join(dir, 'vault.key'), { force: true });
      rmSync(join(dir, 'vault.json'), { force: true });
      logs.length = 0;
      const sec = fakeSecurity({ find: () => exit(44), add });
      _setVaultTestHooks(hooks(sec.spawn));
      setSecret('test:a', 'x');
      const keyFile = join(dir, 'vault.key');
      expect(existsSync(keyFile)).toBe(true);
      expect(logs.join('\n')).toContain(`Created a new data key (${keyFile})`);
      expect(logs.join('\n')).toMatch(/Keychain write failed/);
      expect(logs.join('\n')).not.toMatch(/Created a new data key \(macOS Keychain/);
      // The file key opens what was written with it.
      _setVaultTestHooks(hooks(fakeSecurity({ find: () => exit(44) }).spawn));
      expect(getSecret('test:a')).toBe('x');
    }
  });

  test('CODIBY_VAULT_NO_KEYCHAIN keeps every call away from security', () => {
    process.env.CODIBY_VAULT_NO_KEYCHAIN = '1';
    const sec = fakeSecurity({ find: () => exit(0, randomBytes(32).toString('base64')), add: () => exit(0) });
    _setVaultTestHooks(hooks(sec.spawn));
    setSecret('test:a', 'x');
    expect(getSecret('test:a')).toBe('x');
    expect(sec.calls).toEqual([]);
    const keyFile = join(dir, 'vault.key');
    expect(readFileSync(keyFile, 'utf-8').length).toBeGreaterThan(0);
    expect(logs.join('\n')).toContain(`Created a new data key (${keyFile})`);
  });

  test('an existing key file is used as-is when the Keychain is off', () => {
    process.env.CODIBY_VAULT_NO_KEYCHAIN = '1';
    writeFileSync(join(dir, 'vault.key'), randomBytes(32).toString('base64'), { mode: 0o600 });
    _setVaultTestHooks(hooks(fakeSecurity({}).spawn));
    setSecret('test:a', 'y');
    expect(getSecret('test:a')).toBe('y');
    expect(logs.join('\n')).not.toMatch(/Created a new data key/);
  });
});

describe('vault records', () => {
  let dir: string;
  let logs: string[];
  let spies: { mockRestore(): void }[];
  const prevNoKeychain = process.env.CODIBY_VAULT_NO_KEYCHAIN;
  const PLAIN = 'very-secret-plaintext-0123456789';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codiby-vault-rec-'));
    logs = [];
    const record = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    spies = [spyOn(console, 'log').mockImplementation(record), spyOn(console, 'error').mockImplementation(record)];
    process.env.CODIBY_VAULT_NO_KEYCHAIN = '1';
    // A spawn that fails the test if anything reaches `security`.
    _setVaultTestHooks({ vaultFile: join(dir, 'vault.json'), keyFile: join(dir, 'vault.key'), keychain: true, spawn: () => { throw new Error('security must not run'); } });
  });

  afterEach(() => {
    _setVaultTestHooks(null);
    for (const s of spies) s.mockRestore();
    if (prevNoKeychain === undefined) delete process.env.CODIBY_VAULT_NO_KEYCHAIN;
    else process.env.CODIBY_VAULT_NO_KEYCHAIN = prevNoKeychain;
    rmSync(dir, { recursive: true, force: true });
  });

  const file = () => JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf-8')) as { entries: Record<string, { iv: string; tag: string; data: string }> };

  test('AES-256-GCM with a fresh 96-bit IV on every write; no plaintext in the file', () => {
    setSecret('test:one', PLAIN);
    const first = file().entries['test:one']!;
    setSecret('test:one', PLAIN);
    const second = file().entries['test:one']!;
    expect(Buffer.from(first.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(first.tag, 'base64')).toHaveLength(16);
    expect(second.iv).not.toBe(first.iv);
    expect(second.data).not.toBe(first.data);
    const raw = readFileSync(join(dir, 'vault.json'), 'utf-8');
    expect(raw.includes(PLAIN)).toBe(false);
    expect(raw.includes(Buffer.from(PLAIN).toString('base64'))).toBe(false);
    expect(getSecret('test:one')).toBe(PLAIN);
  });

  test('a record only opens under its own name (AAD), and tampering is refused without echoing anything', () => {
    setSecret('test:a', PLAIN);
    setSecret('test:b', 'other');
    const v = file();
    v.entries['test:b'] = v.entries['test:a']!;
    writeFileSync(join(dir, 'vault.json'), JSON.stringify(v));
    expect(getSecret('test:b')).toBeNull();
    expect(getSecret('test:a')).toBe(PLAIN);
    const t = file();
    const data = Buffer.from(t.entries['test:a']!.data, 'base64');
    data[0] = data[0]! ^ 1;
    t.entries['test:a']!.data = data.toString('base64');
    writeFileSync(join(dir, 'vault.json'), JSON.stringify(t));
    expect(getSecret('test:a')).toBeNull();
    expect(logs.join('\n')).toContain('Could not decrypt "test:a"');
    expect(logs.join('\n').includes(PLAIN)).toBe(false);
  });

  test('the vault file and the key file are 0600, and no Keychain call is made', () => {
    setSecret('test:mode', PLAIN);
    expect(statSync(join(dir, 'vault.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'vault.key')).mode & 0o777).toBe(0o600);
    // Rewrites keep it 0600 too (temp file + rename).
    setSecret('test:mode', 'again');
    expect(statSync(join(dir, 'vault.json')).mode & 0o777).toBe(0o600);
  });

  test('names are validated and inherited object keys never count as secrets', () => {
    expect(() => setSecret('../escape', 'x')).toThrow(/Invalid secret name/);
    expect(() => setSecret('', 'x')).toThrow(/Invalid secret name/);
    expect(getSecret('constructor')).toBeNull();
    expect(getSecret('__proto__')).toBeNull();
  });
});
