import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PairingManager, validatePairOptions, type PairDependencies } from './pairing';
import { PairAuthorizedKeys, createPairKey, publicKey } from './pairing-keys';
import { readHostIdentity } from './host-identity';
import { createPeerHandler, PeerReceipts } from './peer-protocol';
import { PeerClient } from './peer-client';
import type { Remote } from '../types';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'codiby-pairing-test-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBgLtUgZmVCXaPLglJL44BrExRW3Om7b8NGqbciJuLTd';
const options = { returnAlias: 'me@pc-a', sshPort: 22, permission: 'write' as const };

function fixture() {
  const root = directory();
  const identities = [readHostIdentity(join(root, 'a')), readHostIdentity(join(root, 'b'))];
  const registries = [new Map<string, Remote>(), new Map<string, Remote>()];
  const initial: Remote = { id: 'rmt_b', name: 'PC B', alias: 'pc-b', bunPort: 3111, color: 'blue', createdAt: 0, coordination: 'off' };
  registries[0].set(initial.id, initial);
  const authorized = [new Map<string, string>(), new Map<string, string>()];
  const received: string[][] = [[], []];
  let failReturn = false;
  let failCommit = false;
  let connected = [0, 0];
  const servers: ReturnType<typeof Bun.serve>[] = [];
  const managers: PairingManager[] = [];
  const deps: PairDependencies[] = [];
  for (let i = 0; i < 2; i++) {
    deps[i] = { directory: join(root, String(i)), identity: () => identities[i], port: () => 3111,
      hostKeys: () => [key], createKey: async dir => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'id_ed25519'), 'PRIVATE-NOT-TRANSFERRED'); return key; },
      grantKey: (id, value) => { authorized[i].set(id, value); }, revokeKey: id => { authorized[i].delete(id); },
      remotes: () => [...registries[i].values()], putRemote: r => { registries[i].set(r.id, r); },
      removeRemote: id => { registries[i].delete(id); }, disconnect: async () => {}, changed: () => {},
      connect: async id => {
        const r = registries[i].get(id);
        if (!r) throw new Error('Route not found');
        if (i === 1) {
          if (failReturn) throw new Error('Connection refused');
          expect(r.alias).toBe(options.returnAlias);
          expect(r.ssh?.port).toBe(22);
          expect(readFileSync(r.ssh!.knownHostsFile, 'utf8')).toContain(identities[0].hostId);
          expect(authorized[0].get(r.pairingId!)).toBe(key);
        }
        connected[i]++;
        return { baseUrl: servers[1 - i].url.origin, release: () => { connected[i]--; } };
      },
    };
    managers[i] = new PairingManager(deps[i]);
    const handler = createPeerHandler(() => identities[i], new PeerReceipts(join(root, `receipts-${i}`)), async (_tool, args) => {
      if (typeof args.text === 'string') received[i].push(args.text);
      return { content: [{ type: 'text', text: received[i].join('\n') || `sessions-on-${i}` }] };
    });
    servers[i] = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req, server) {
      const path = new URL(req.url).pathname;
      if (path === '/host') return Response.json(identities[i]);
      try {
        if (path.startsWith('/peer/pair/')) {
          const action = path.split('/').at(-1)!;
          const result = await managers[i].receive(action, await req.json());
          if (action === 'commit' && failCommit) return Response.json({ error: 'Reply lost after commit' }, { status: 503 });
          return Response.json(result);
        }
        if (path === '/peer/tools') {
          managers[i].authorize(req, await req.clone().json());
          return handler(req, server.requestIP(req)?.address);
        }
        return new Response('not found', { status: 404 });
      } catch (error: any) { return Response.json({ error: error.message }, { status: 403 }); }
    } });
    cleanup.push(() => servers[i].stop(true));
  }
  const clients = deps.map((d, i) => new PeerClient({ identity: d.identity, remotes: d.remotes, connect: d.connect,
    pin: (id, hostId) => { const r = registries[i].get(id)!; if (r.hostId && r.hostId !== hostId) throw new Error('Wrong host'); r.hostId = hostId; },
    credentials: id => managers[i].credentials(id),
  }));
  return { managers, registries, clients, authorized, received, identities, servers,
    connected: () => connected, setFailReturn: () => { failReturn = true; }, setFailCommit: () => { failCommit = true; },
    restart: () => { for (let i = 0; i < 2; i++) managers[i] = new PairingManager(deps[i]); }, initial, root };
}

describe('reciprocal endpoint pairing', () => {
  test('one action persists both routes and both MCP directions work after restarting the managers', async () => {
    const f = fixture();
    const result = await f.managers[0].pair('rmt_b', options);
    expect(result.status).toBe('paired');
    expect(f.managers[1].list()[0].status).toBe('paired');
    expect(JSON.stringify(f.managers[0].list())).not.toContain('token');
    expect(JSON.stringify([...f.registries[1].values()])).not.toContain('PRIVATE-NOT-TRANSFERRED');
    expect(f.registries[0].get('rmt_b')?.coordination).toBe('write');
    const reverse = [...f.registries[1].values()][0];
    expect(reverse.hostId).toBe(f.identities[0].hostId);
    f.restart();
    await f.clients[0].call(f.identities[1].hostId, 'ui_send_message', { session_id: 'b', text: 'Question for B', request_id: 'q1' }, 'a');
    await f.clients[1].call(f.identities[0].hostId, 'ui_send_message', { session_id: 'a', text: 'Answer for A', request_id: 'r1' }, 'b');
    expect(f.received[0][0]).toContain('Answer for A');
    expect(f.received[1][0]).toContain('Question for B');
    expect(f.connected()).toEqual([0, 0]);
    expect(await f.managers[0].pair('rmt_b', options)).toEqual(result);
    expect(f.registries[1].size).toBe(1);
  });
  test('a failed return connection rolls back both registries and the generated authorization', async () => {
    const f = fixture(); f.setFailReturn();
    await expect(f.managers[0].pair('rmt_b', options)).rejects.toThrow('Return connection failed');
    expect(f.registries[0].get('rmt_b')).toEqual(f.initial);
    expect(f.registries[1].size).toBe(0);
    expect(f.authorized[0].size).toBe(0);
    expect(f.managers[0].list()[0].status).toBe('revoked');
    expect(f.managers[1].list()[0].status).toBe('revoked');
    expect(f.connected()).toEqual([0, 0]);
  });
  test('a lost commit reply is compensated rather than leaving one side enabled', async () => {
    const f = fixture(); f.setFailCommit();
    await expect(f.managers[0].pair('rmt_b', options)).rejects.toThrow('Reply lost');
    expect(f.registries[0].get('rmt_b')).toEqual(f.initial);
    expect(f.registries[1].size).toBe(0);
    expect(f.authorized[0].size).toBe(0);
  });
  test('read-only pairing blocks inbound writes, including a forged source and revoked tokens', async () => {
    const f = fixture();
    const pair = await f.managers[0].pair('rmt_b', { ...options, permission: 'read' });
    const headers = f.managers[0].credentials('rmt_b');
    const body = { source: { hostId: f.identities[0].hostId, sessionId: 'a' }, tool: 'ui_send_message' } as any;
    const req = new Request('http://localhost/peer/tools', { headers });
    expect(() => f.managers[1].authorize(req, body)).toThrow('only permits reading');
    body.tool = 'ui_list_sessions';
    expect(() => f.managers[1].authorize(req, body)).not.toThrow();
    body.source.hostId = 'host_forged';
    expect(() => f.managers[1].authorize(req, body)).toThrow('identity');
    const result = await f.managers[0].unpair(pair.id);
    expect(result.remoteNotified).toBe(true);
    expect(() => f.managers[1].authorize(req, body)).toThrow('inactive');
    expect(f.registries[1].size).toBe(0);
    expect(f.authorized[0].size).toBe(0);
  });
  test('unpair from the receiver cleans both sides and restores an existing return record', async () => {
    const f = fixture();
    const previous: Remote = { ...f.initial, id: 'rmt_old', name: 'My existing PC A', hostId: f.identities[0].hostId };
    f.registries[1].set(previous.id, previous);
    const pair = await f.managers[0].pair('rmt_b', options);
    await f.managers[1].unpair(pair.id);
    expect(f.registries[1].get(previous.id)).toEqual(previous);
    expect(f.registries[0].get('rmt_b')).toEqual(f.initial);
    expect(f.authorized[0].size).toBe(0);
    // Recovery must not keep disconnecting restored, unrelated routes.
    await f.managers[0].recover(); await f.managers[1].recover();
    expect(f.registries[1].get(previous.id)).toEqual(previous);
  });
  test('rejects SSH option injection before touching either host', async () => {
    const f = fixture();
    await expect(f.managers[0].pair('rmt_b', { ...options, returnAlias: '-oProxyCommand=bad' })).rejects.toThrow('Return SSH address');
    expect(() => validatePairOptions({ ...options, sshPort: 0 })).toThrow('port');
    expect(f.managers[0].list()).toHaveLength(0);
  });
  test('local revocation succeeds when the peer is offline and invalidates its existing token', async () => {
    const f = fixture();
    const pair = await f.managers[0].pair('rmt_b', options);
    const reverse = [...f.registries[1].values()][0];
    const headers = f.managers[1].credentials(reverse.id);
    f.servers[1].stop(true);
    expect((await f.managers[0].unpair(pair.id)).remoteNotified).toBe(false);
    expect(f.authorized[0].size).toBe(0);
    expect(() => f.managers[0].authorize(new Request('http://localhost', { headers }), {
      source: { hostId: f.identities[1].hostId, sessionId: 'b' }, tool: 'ui_list_sessions',
    } as any)).toThrow('inactive');
    expect(f.registries[0].get('rmt_b')).toEqual(f.initial);
  });
  test('recovery cleans an expired preparation after a crash', async () => {
    const f = fixture();
    const id = crypto.randomUUID();
    await f.managers[1].receive('prepare', { id, token: 'a'.repeat(64), source: f.identities[0],
      targetHostId: f.identities[1].hostId, permission: 'read' });
    const path = join(f.root, '1', 'pairings.json');
    const records = JSON.parse(readFileSync(path, 'utf8'));
    records[0].createdAt = Date.now() - 11 * 60_000;
    writeFileSync(path, JSON.stringify(records));
    f.restart();
    await f.managers[1].recover();
    expect(f.managers[1].list()[0].status).toBe('revoked');
    expect(() => readFileSync(join(f.root, '1', 'keys', id, 'id_ed25519'))).toThrow();
  });
});

describe('pair SSH credentials', () => {
  test('generates a private key locally and preserves unrelated authorized keys through grant and revoke', async () => {
    const dir = directory();
    const generated = await createPairKey(join(dir, 'private'));
    expect(generated.startsWith('ssh-ed25519 ')).toBe(true);
    expect(await createPairKey(join(dir, 'private'))).toBe(generated);
    const path = join(dir, 'authorized_keys');
    const original = '# my existing key\nssh-ed25519 AAAA existing\n';
    writeFileSync(path, original);
    const keys = new PairAuthorizedKeys(path);
    const id = crypto.randomUUID();
    keys.grant(id, generated, 3111, Date.now() + 600_000);
    expect(readFileSync(path, 'utf8')).toContain('expiry-time=');
    expect(readFileSync(path, 'utf8')).toContain('permitopen="localhost:3111"');
    keys.grant(id, generated, 3111);
    const saved = readFileSync(path, 'utf8');
    expect(saved).not.toContain('expiry-time=');
    expect(saved.split(`codiby-pair:${id}`)).toHaveLength(2);
    expect(saved).toContain(original);
    keys.revoke(id);
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(() => publicKey('ssh-ed25519 AAAA\ncommand="bad"')).toThrow('Invalid');
  });
});
