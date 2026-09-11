import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const exec = promisify(execFile);
export function publicKey(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Missing SSH public key');
  const match = value.trim().match(/^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/);
  if (!match) throw new Error('Invalid SSH public key');
  return `${match[1]} ${match[2]}`;
}

/** Keys never leave the host that will use them. Only the public half is exchanged. */
export async function createPairKey(directory: string): Promise<string> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'id_ed25519');
  try { return publicKey(readFileSync(`${path}.pub`, 'utf8')); } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
  await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'codiby-pair', '-f', path], { timeout: 10_000 });
  return publicKey(readFileSync(`${path}.pub`, 'utf8'));
}

export function localSshHostKeys(): string[] {
  const keys: string[] = [];
  for (const kind of ['ed25519', 'ecdsa', 'rsa']) {
    try { keys.push(publicKey(readFileSync(`/etc/ssh/ssh_host_${kind}_key.pub`, 'utf8'))); } catch {}
  }
  if (!keys.length) throw new Error('Enable SSH / Remote Login on this computer before pairing; no SSH host public key was found');
  return keys;
}

/** Edits only the line owned by this pairing, preserving every unrelated key. */
export class PairAuthorizedKeys {
  constructor(private path: string) {}
  private marker(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid pairing ID');
    return `codiby-pair:${id}`;
  }
  grant(id: string, key: string, port: number, expires?: number) {
    const marker = this.marker(id);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid bridge port');
    const expiry = expires ? `,expiry-time="${new Date(expires).toISOString().replace(/[-:]/g, '').replace('T', '').replace(/\.\d+Z$/, 'Z')}"` : '';
    // Shell execution is denied; this credential can forward to this Bun bridge.
    const line = `restrict,port-forwarding,permitopen="localhost:${port}",command="false"${expiry} ${publicKey(key)} ${marker}`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    let previous = '';
    try { previous = readFileSync(this.path, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const lines = previous.split('\n');
    if (lines.includes(line)) return;
    if (lines.some(value => value.endsWith(` ${marker}`))) {
      this.replace(lines.filter(value => !value.endsWith(` ${marker}`)).join('\n').replace(/\n*$/, '\n') + line + '\n');
    } else {
      appendFileSync(this.path, `${previous && !previous.endsWith('\n') ? '\n' : ''}${line}\n`, { mode: 0o600 });
    }
  }
  revoke(id: string) {
    const marker = this.marker(id);
    let previous: string;
    try { previous = readFileSync(this.path, 'utf8'); } catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
    const next = previous.split('\n').filter(line => !line.endsWith(` ${marker}`)).join('\n');
    if (next !== previous) this.replace(next);
  }
  private replace(text: string) {
    const path = `${this.path}.codiby-tmp`;
    writeFileSync(path, text, { mode: 0o600 });
    renameSync(path, this.path);
  }
}
