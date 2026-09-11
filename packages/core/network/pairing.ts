import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Remote } from '../types';
import type { HostIdentity } from './host-identity';
import { isPeerWrite, type PeerRequest } from './peer-protocol';
import { publicKey } from './pairing-keys';

type Permission = 'read' | 'write';
export type PairOptions = { returnAlias: string; sshPort: number; permission: Permission };
type PairRecord = {
  id: string; token: string; role: 'initiator' | 'receiver';
  peer: HostIdentity; status: 'pending' | 'ready' | 'paired' | 'revoked';
  permission: Permission; createdAt: number; remoteId?: string;
  previousRemote?: Remote; publicKey?: string; options?: PairOptions; cleanupComplete?: boolean;
};
type Connection = { baseUrl: string; release(): void };
export type PairDependencies = {
  directory: string;
  identity(): HostIdentity;
  port(): number;
  hostKeys(): string[];
  createKey(directory: string): Promise<string>;
  grantKey(id: string, key: string, port: number, expires?: number): void;
  revokeKey(id: string): void;
  remotes(): Remote[];
  putRemote(remote: Remote): void;
  removeRemote(id: string): void;
  disconnect(id: string): Promise<void>;
  connect(id: string): Promise<Connection>;
  changed(): void;
};

export function validatePairOptions(value: unknown): PairOptions {
  const input = value as Partial<PairOptions> | null;
  if (!input || typeof input.returnAlias !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(input.returnAlias)) {
    throw new Error('Return SSH address must be a host alias or user@hostname, without spaces or SSH options');
  }
  if (!Number.isInteger(input.sshPort) || input.sshPort! < 1 || input.sshPort! > 65535) throw new Error('Invalid return SSH port');
  if (input.permission !== 'read' && input.permission !== 'write') throw new Error('Choose read or read/write coordination');
  return input as PairOptions;
}

/** A journal for the two-step enrollment. No secrets are returned to Electron. */
export class PairingManager {
  private records = new Map<string, PairRecord>();
  private locks = new Map<string, Promise<unknown>>();
  private path: string;
  constructor(private deps: PairDependencies) {
    this.path = join(deps.directory, 'pairings.json');
    try {
      for (const record of JSON.parse(readFileSync(this.path, 'utf8')) as PairRecord[]) this.records.set(record.id, record);
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  private save(record: PairRecord) {
    const previous = this.records.get(record.id);
    this.records.set(record.id, record);
    try {
      mkdirSync(this.deps.directory, { recursive: true, mode: 0o700 });
      writeFileSync(`${this.path}.tmp`, JSON.stringify([...this.records.values()]), { mode: 0o600 });
      renameSync(`${this.path}.tmp`, this.path);
    } catch (error) {
      if (previous) this.records.set(record.id, previous); else this.records.delete(record.id);
      throw error;
    }
    this.deps.changed();
  }
  private async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.locks.has(key)) throw new Error('Pairing operation already in progress; wait for it to finish');
    const promise = Promise.resolve().then(work);
    this.locks.set(key, promise);
    try { return await promise; } finally { this.locks.delete(key); }
  }
  list() {
    return [...this.records.values()].map(({ id, role, peer, status, permission, remoteId }) => ({ id, role, peer, status, permission, remoteId }));
  }
  private record(id: unknown, token: unknown): PairRecord {
    const value = typeof id === 'string' ? this.records.get(id) : undefined;
    if (!value || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || token.length !== value.token.length
      || !timingSafeEqual(Buffer.from(token), Buffer.from(value.token))) throw new Error('Unknown or unauthorized pairing');
    return value;
  }
  credentials(remoteId: string) {
    const record = [...this.records.values()].find(r => r.remoteId === remoteId && r.status === 'paired');
    if (!record) throw new Error('Pair these hosts in Settings → Remotes before using remote MCP tools');
    return { 'x-codiby-pair-id': record.id, authorization: `Bearer ${record.token}` };
  }
  authorize(req: Request, body: PeerRequest) {
    const record = this.record(req.headers.get('x-codiby-pair-id'), req.headers.get('authorization')?.replace(/^Bearer /, ''));
    if (record.status !== 'paired' || body.source?.hostId !== record.peer.hostId) throw new Error('Pairing is inactive or source identity does not match');
    if (isPeerWrite(body.tool) && record.permission !== 'write') throw new Error('This pairing only permits reading context');
  }
  private keyDirectory(id: string) { return join(this.deps.directory, 'keys', id); }
  private async request(connection: Connection, action: string, body: unknown): Promise<any> {
    const response = await fetch(`${connection.baseUrl}/peer/pair/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Pairing endpoint returned HTTP ${response.status}; update both servers`);
    return data;
  }
  private async checkHost(connection: Connection, expected?: string): Promise<HostIdentity> {
    const response = await fetch(`${connection.baseUrl}/host`, { signal: AbortSignal.timeout(8000) });
    const host = await response.json() as HostIdentity;
    if (!response.ok || typeof host.hostId !== 'string' || !/^host_[a-zA-Z0-9-]+$/.test(host.hostId)
      || host.protocolVersion !== this.deps.identity().protocolVersion || (expected && host.hostId !== expected)) {
      throw new Error('Unexpected host identity or incompatible server version');
    }
    return host;
  }

  /** Called once in the user's Electron. The destination configures its own return route. */
  async pair(remoteId: string, input: unknown) {
    const options = validatePairOptions(input);
    return this.locked(`out:${remoteId}`, async () => {
      const remote = this.deps.remotes().find(r => r.id === remoteId);
      if (!remote) throw new Error('Remote not found');
      const active = [...this.records.values()].find(r => r.remoteId === remoteId && r.status !== 'revoked');
      if (active) {
        if (active.status === 'paired') return this.list().find(r => r.id === active.id)!;
        throw new Error('An incomplete pairing exists. Unpair it before retrying.');
      }
      const hostKeys = this.deps.hostKeys().map(publicKey);
      if (!hostKeys.length) throw new Error('Enable SSH / Remote Login on this computer first');
      const connection = await this.deps.connect(remoteId);
      let record: PairRecord | undefined;
      try {
        const destination = await this.checkHost(connection, remote.hostId);
        if (destination.hostId === this.deps.identity().hostId) throw new Error('Cannot pair a host with itself');
        record = { id: randomUUID(), token: randomBytes(32).toString('hex'), role: 'initiator', peer: destination,
          status: 'pending', permission: options.permission, createdAt: Date.now(), remoteId, previousRemote: { ...remote }, options };
        this.save(record);
        const prepared = await this.request(connection, 'prepare', { id: record.id, token: record.token,
          source: this.deps.identity(), targetHostId: destination.hostId, permission: options.permission });
        const key = publicKey(prepared.publicKey);
        record = { ...record, publicKey: key }; this.save(record);
        // A failed/crashed setup cannot leave a permanent SSH credential authorized.
        this.deps.grantKey(record.id, key, this.deps.port(), Date.now() + 10 * 60_000);
        await this.request(connection, 'configure', { id: record.id, token: record.token, options,
          hostKeys, bunPort: this.deps.port() });
        // Destination verified its independent SSH connection back to this host.
        const current = this.deps.remotes().find(r => r.id === remoteId);
        if (!current || JSON.stringify(current) !== JSON.stringify(remote)) throw new Error('Remote settings changed during pairing');
        await this.request(connection, 'commit', { id: record.id, token: record.token });
        this.deps.putRemote({ ...remote, hostId: destination.hostId, coordination: options.permission, pairingId: record.id });
        this.save({ ...record, status: 'paired' });
        this.deps.grantKey(record.id, key, this.deps.port());
        return this.list().find(r => r.id === record!.id)!;
      } catch (error) {
        if (record) {
          // Local revocation is effective even when the destination went offline.
          this.save({ ...record, status: 'revoked' });
          this.deps.revokeKey(record.id);
          await this.request(connection, 'cancel', { id: record.id, token: record.token }).catch(() => {});
          await this.rollback(record);
        }
        throw error;
      } finally { connection.release(); }
    });
  }

  /** Bootstrap calls arrive through the user's existing, authenticated SSH route. */
  async receive(action: string, body: any) {
    if (!body || !/^[a-f0-9-]{36}$/.test(body.id) || !/^[a-f0-9]{64}$/.test(body.token)) throw new Error('Invalid pairing request');
    return this.locked(`pair:${body.id}`, async () => {
      if (action === 'prepare') {
        const source = body.source as HostIdentity;
        if (!source || typeof source.name !== 'string' || !source.name || source.name.length > 200 || !/^host_[a-zA-Z0-9-]+$/.test(source.hostId) || source.protocolVersion !== this.deps.identity().protocolVersion
          || body.targetHostId !== this.deps.identity().hostId || source.hostId === body.targetHostId
          || (body.permission !== 'read' && body.permission !== 'write')) throw new Error('Invalid pairing identities or permission');
        const previous = this.records.get(body.id);
        if (previous) {
          const valid = this.record(body.id, body.token);
          if (valid.role !== 'receiver' || valid.status === 'revoked' || valid.peer.hostId !== source.hostId) throw new Error('Pairing conflict');
          if (valid.publicKey) return { publicKey: valid.publicKey };
        }
        const duplicate = [...this.records.values()].find(r => r.id !== body.id && r.peer.hostId === source.hostId && r.status !== 'revoked');
        if (duplicate) throw new Error('These hosts already have a pairing; remove it before creating another');
        const record: PairRecord = previous ?? { id: body.id, token: body.token, role: 'receiver', peer: source,
          status: 'pending', permission: body.permission, createdAt: Date.now() };
        this.save(record);
        const key = await this.deps.createKey(this.keyDirectory(record.id));
        this.save({ ...record, publicKey: key });
        return { publicKey: key };
      }
      let record = this.record(body.id, body.token);
      if (action === 'cancel') { await this.rollback(record); return { ok: true }; }
      if (record.role !== 'receiver' || record.status === 'revoked') throw new Error('Pairing is not accepting setup requests');
      if (action === 'configure') {
        if (record.status === 'paired' || record.status === 'ready') {
          if (JSON.stringify(record.options) !== JSON.stringify(validatePairOptions(body.options))) throw new Error('Return options differ from the prepared pairing');
          return { ok: true, remoteId: record.remoteId };
        }
        const options = validatePairOptions(body.options);
        if (options.permission !== record.permission || !Number.isInteger(body.bunPort) || body.bunPort < 1 || body.bunPort > 65535
          || !Array.isArray(body.hostKeys) || body.hostKeys.length === 0 || body.hostKeys.length > 4) throw new Error('Invalid return connection');
        const directory = this.keyDirectory(record.id);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const hostKeyAlias = `codiby-${record.peer.hostId}`;
        writeFileSync(join(directory, 'known_hosts'), body.hostKeys.map((key: unknown) => `${hostKeyAlias} ${publicKey(key)}\n`).join(''), { mode: 0o600 });
        const existing = this.deps.remotes().find(r => r.hostId === record.peer.hostId);
        if (existing?.pairingId && existing.pairingId !== record.id) throw new Error('The return connection belongs to another pairing');
        const remote: Remote = { id: existing?.id ?? `rmt_${randomUUID()}`, name: existing?.name ?? record.peer.name,
          alias: options.returnAlias, bunPort: body.bunPort, color: existing?.color ?? 'blue', createdAt: existing?.createdAt ?? Date.now(),
          hostId: record.peer.hostId, coordination: 'off', pairingId: record.id,
          ssh: { identityFile: join(directory, 'id_ed25519'), knownHostsFile: join(directory, 'known_hosts'), hostKeyAlias, port: options.sshPort } };
        record = { ...record, remoteId: remote.id, previousRemote: existing ? { ...existing } : undefined, options };
        this.save(record); // Journal before changing the destination registry.
        this.deps.putRemote(remote);
        await this.deps.disconnect(remote.id);
        try {
          const connection = await this.deps.connect(remote.id);
          try { await this.checkHost(connection, record.peer.hostId); } finally { connection.release(); }
          this.save({ ...record, status: 'ready' });
        } catch (error: any) {
          await this.rollback(record);
          throw new Error(`Return connection failed: ${error.message}. Check SSH / Remote Login, address and port on the first computer.`);
        }
        return { ok: true, remoteId: remote.id };
      }
      if (action === 'commit') {
        if (record.status === 'paired') return { ok: true };
        if (record.status !== 'ready' || !record.remoteId) throw new Error('The return connection has not been verified');
        const remote = this.deps.remotes().find(r => r.id === record.remoteId);
        if (!remote || remote.pairingId !== record.id) throw new Error('Return connection changed');
        this.deps.putRemote({ ...remote, coordination: record.permission });
        this.save({ ...record, status: 'paired' });
        return { ok: true };
      }
      throw new Error('Unknown pairing operation');
    });
  }
  private async rollback(record: PairRecord) {
    if (this.records.get(record.id)?.cleanupComplete) return;
    this.save({ ...record, status: 'revoked' });
    if (record.role === 'initiator') this.deps.revokeKey(record.id);
    if (record.remoteId) {
      await this.deps.disconnect(record.remoteId);
      const current = this.deps.remotes().find(r => r.id === record.remoteId);
      if (current?.pairingId === record.id) {
        if (record.previousRemote) this.deps.putRemote(record.previousRemote);
        else this.deps.removeRemote(record.remoteId);
      }
    }
    if (record.role === 'receiver') rmSync(this.keyDirectory(record.id), { recursive: true, force: true });
    this.save({ ...record, status: 'revoked', cleanupComplete: true });
  }
  async recover() {
    for (const record of this.records.values()) {
      if (this.locks.has(`pair:${record.id}`) || (record.remoteId && this.locks.has(`out:${record.remoteId}`))) continue;
      if (record.status === 'revoked' || (record.status !== 'paired' && record.createdAt + 10 * 60_000 < Date.now())) {
        await this.rollback(record);
      } else if (record.status === 'paired' && record.role === 'initiator' && record.publicKey) {
        this.deps.grantKey(record.id, record.publicKey, this.deps.port());
      }
    }
  }
  async unpair(id: string) {
    return this.locked(`pair:${id}`, async () => {
      const record = this.records.get(id);
      if (!record) throw new Error('Pairing not found');
      if (record.remoteId && this.locks.has(`out:${record.remoteId}`)) throw new Error('Pairing is still in progress; wait for it to finish');
      let notified = false;
      // Revoke MCP access before performing any network operation.
      this.save({ ...record, status: 'revoked' });
      try {
        if (record.remoteId) {
          const connection = await this.deps.connect(record.remoteId);
          try { await this.request(connection, 'cancel', { id, token: record.token }); notified = true; }
          finally { connection.release(); }
        }
      } catch { /* Local cleanup must work with an offline peer. */ }
      await this.rollback(record);
      return { ok: true, remoteNotified: notified };
    });
  }
}
