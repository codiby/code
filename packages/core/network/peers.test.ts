import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeerClient } from './peer-client';
import { createPeerHandler, PeerReceipts, type PeerRequest } from './peer-protocol';
import { readHostIdentity } from './host-identity';
import type { Remote } from '../types';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'codiby-peers-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fixture() {
  const dir = directory();
  const identityA = readHostIdentity(join(dir, 'a'));
  const identityB = readHostIdentity(join(dir, 'b'));
  const history: string[] = [];
  const receipts = new PeerReceipts(join(dir, 'receipts'));
  const handler = createPeerHandler(() => identityB, receipts, async (tool, args, owner) => {
    expect(owner).toBe('');
    if (tool === 'ui_send_message') history.push(args.text as string);
    return { content: [{ type: 'text', text: tool === 'ui_list_sessions' ? 'session-b' : history.join('\n') }] };
  });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req, server) {
    if (new URL(req.url).pathname === '/host') return Response.json(identityB);
    return handler(req, server.requestIP(req)?.address);
  } });
  cleanup.push(() => server.stop(true));
  const remote: Remote = { id: 'rmt_b', name: 'PC B', alias: 'b', bunPort: server.port!, color: 'blue', createdAt: 0, coordination: 'write' };
  let releases = 0;
  const client = new PeerClient({ identity: () => identityA, remotes: () => [remote],
    pin: (id, hostId) => {
      expect(id).toBe(remote.id);
      if (remote.hostId && remote.hostId !== hostId) throw new Error('identity changed');
      remote.hostId = hostId;
    },
    connect: async () => ({ baseUrl: server.url.origin, release: () => { releases++; } }),
  });
  return { client, remote, history, handler, identityA, identityB, receipts, dir, releases: () => releases };
}

describe('host identity', () => {
  test('persists across restarts and differs across installations', () => {
    const dir = directory();
    expect(readHostIdentity(dir)).toEqual(readHostIdentity(dir));
    expect(readHostIdentity(directory()).hostId).not.toBe(readHostIdentity(dir).hostId);
    writeFileSync(join(dir, 'host-identity.json'), '{}');
    expect(() => readHostIdentity(dir)).toThrow('Invalid host-identity');
  });
});

describe('Bun peer coordination without Electron', () => {
  test('discovers, lists, sends and reads through the target server; retries deliver once', async () => {
    const f = fixture();
    const hosts = await f.client.listHosts();
    expect(hosts[1].hostId).toBe(f.identityB.hostId);
    expect(hosts[1].status).toBe('online');
    const list = await f.client.call(f.identityB.hostId, 'ui_list_sessions', {}, 'session-a');
    expect(JSON.stringify(list)).toContain('session-b');
    const args = { session_id: 'session-b', text: 'What did you decide?', request_id: 'request-1' };
    await Promise.all([f.client.call(f.identityB.hostId, 'ui_send_message', args, 'session-a'),
      f.client.call(f.identityB.hostId, 'ui_send_message', args, 'session-a')]);
    expect(f.history).toHaveLength(1);
    expect(f.history[0]).toContain(f.identityA.hostId);
    const messages = await f.client.call(f.identityB.hostId, 'ui_read_session_messages', { session_id: 'session-b' }, 'session-a');
    expect(JSON.stringify(messages)).toContain('What did you decide?');
    expect(f.releases()).toBe(5);
  });

  test('enforces read-only and disabled hosts before opening a write connection', async () => {
    const f = fixture();
    f.remote.coordination = 'read';
    await expect(f.client.call(f.remote.id, 'ui_send_message', { text: 'do work' }, 'a')).rejects.toThrow('read-only');
    expect(f.history).toHaveLength(0);
    expect(f.releases()).toBe(0);
    f.remote.coordination = 'off';
    expect((await f.client.listHosts())[1].status).toBe('disabled');
    await expect(f.client.call(f.remote.id, 'ui_list_sessions', {}, 'a')).rejects.toThrow('disabled');
  });

  test('rejects a changed destination identity and still releases the connection', async () => {
    const f = fixture();
    f.remote.hostId = 'host_previous';
    await expect(f.client.call(f.remote.id, 'ui_list_sessions', {}, 'a')).rejects.toThrow('identity changed');
    expect(f.releases()).toBe(1);
    expect((await f.client.listHosts())[1].status).toBe('offline');
  });

  test('does not trust a forged Host header, forward again, or execute arbitrary tools', async () => {
    const f = fixture();
    const body: PeerRequest = { protocolVersion: 1, targetHostId: f.identityB.hostId,
      source: { hostId: f.identityA.hostId, sessionId: 'a' }, tool: 'ui_list_sessions', args: {} };
    const request = (value: unknown) => new Request('http://localhost/peer/tools', {
      method: 'POST', headers: { Host: 'localhost' }, body: JSON.stringify(value),
    });
    expect((await f.handler(request(body), '192.168.1.10')).status).toBe(403);
    expect((await f.handler(request({ ...body, targetHostId: 'host_wrong' }), '127.0.0.1')).status).toBe(409);
    expect((await f.handler(request({ ...body, args: { host_id: 'host_third' } }), '127.0.0.1')).status).toBe(400);
    expect((await f.handler(request({ ...body, tool: 'ui_exec' }), '127.0.0.1')).status).toBe(400);
    expect((await f.handler(request({ ...body, protocolVersion: 999 }), '127.0.0.1')).status).toBe(409);
    expect(f.history).toHaveLength(0);
  });
});

describe('persistent peer write receipts', () => {
  test('replays the result after restart, rejects ID reuse, and never retries an uncertain dispatch', async () => {
    const dir = directory();
    const receipts = new PeerReceipts(dir);
    const request: PeerRequest = { protocolVersion: 1, targetHostId: 'host_b', source: { hostId: 'host_a', sessionId: 'a' },
      requestId: 'one', tool: 'ui_send_message', args: { text: 'hello' } };
    const result = { content: [{ type: 'text' as const, text: 'accepted' }] };
    let sends = 0;
    await receipts.run(request, async () => { sends++; return result; });
    expect(await new PeerReceipts(dir).run(request, async () => { sends++; return result; })).toEqual(result);
    expect(sends).toBe(1);
    await expect(receipts.run({ ...request, args: { text: 'different' } }, async () => result)).rejects.toThrow('different operation');
    const uncertain = { ...request, requestId: 'two' };
    await expect(receipts.run(uncertain, async () => { throw new Error('connection interrupted'); })).rejects.toThrow('interrupted');
    await expect(new PeerReceipts(dir).run(uncertain, async () => { sends++; return result; })).rejects.toThrow('outcome unknown');
    expect(sends).toBe(1);
  });
});
