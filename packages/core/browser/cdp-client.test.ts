import { afterEach, describe, expect, test } from 'bun:test';
import type { Server, ServerWebSocket } from 'bun';
import { CdpClient, CdpClosedError, CdpError, CdpTimeoutError } from './cdp-client';

type Msg = { id: number; method: string; params?: any; sessionId?: string };
type Handler = (msg: Msg, ws: ServerWebSocket<unknown>) => void;

/** A fake DevTools endpoint: each test decides how it answers. */
function fakeBrowser(handler: Handler) {
  const received: Msg[] = [];
  const sockets: ServerWebSocket<unknown>[] = [];
  const server: Server<unknown> = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      if (srv.upgrade(req, { data: undefined })) return undefined;
      return new Response('no', { status: 400 });
    },
    websocket: {
      open(ws) { sockets.push(ws); },
      message(ws, data) {
        const msg = JSON.parse(String(data)) as Msg;
        received.push(msg);
        handler(msg, ws);
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}/devtools/browser/test`,
    received,
    sockets,
    stop: () => server.stop(true),
  };
}

const reply = (ws: ServerWebSocket<unknown>, msg: Msg, result: unknown) => ws.send(JSON.stringify({ id: msg.id, result, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }));
const emit = (ws: ServerWebSocket<unknown>, method: string, params: unknown, sessionId?: string) => ws.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) { try { fn(); } catch {} }
  cleanup = [];
});

function track<T extends { stop(): void }>(b: T): T { cleanup.push(() => b.stop()); return b; }
function trackClient(c: CdpClient): CdpClient { cleanup.push(() => c.close()); return c; }

describe('CdpClient', () => {
  test('matches responses to requests by id, whatever order they arrive in', async () => {
    const held: { msg: Msg; ws: ServerWebSocket<unknown> }[] = [];
    const b = track(fakeBrowser((msg, ws) => {
      held.push({ msg, ws });
      if (held.length === 2) {
        // Answer the second request first.
        reply(held[1]!.ws, held[1]!.msg, { n: 2 });
        reply(held[0]!.ws, held[0]!.msg, { n: 1 });
      }
    }));
    const client = trackClient(await CdpClient.connect(b.url));
    const [a, c] = await Promise.all([client.send('A.one'), client.send('A.two')]);
    expect(a).toEqual({ n: 1 });
    expect(c).toEqual({ n: 2 });
    expect(b.received.map(m => m.id)).toEqual([1, 2]);
  });

  test('protocol errors reject with a CdpError naming the method', async () => {
    const b = track(fakeBrowser((msg, ws) => ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: 'No target', data: 'detail' } }))));
    const client = trackClient(await CdpClient.connect(b.url));
    const err = await client.send('Target.closeTarget', { targetId: 'x' }).catch(e => e);
    expect(err).toBeInstanceOf(CdpError);
    expect(err.message).toBe('Target.closeTarget: No target (detail)');
    expect((err as CdpError).code).toBe(-32000);
  });

  test('a request nobody answers times out and is forgotten', async () => {
    const b = track(fakeBrowser(() => {}));
    const client = trackClient(await CdpClient.connect(b.url));
    const err = await client.send('Page.slow', {}, { timeoutMs: 50 }).catch(e => e);
    expect(err).toBeInstanceOf(CdpTimeoutError);
    expect(err.message).toBe('Page.slow timed out after 50ms');
  });

  test('flatten sessions: commands carry the sessionId, events route to their session', async () => {
    const b = track(fakeBrowser((msg, ws) => {
      if (msg.method === 'Target.attachToTarget') {
        expect(msg.params).toEqual({ targetId: 'T1', flatten: true });
        reply(ws, msg, { sessionId: 'S1' });
      } else if (msg.method === 'Page.navigate') {
        reply(ws, msg, { frameId: 'T1', loaderId: 'L1' });
        emit(ws, 'Page.loadEventFired', { timestamp: 1 }, 'S1');
        emit(ws, 'Page.loadEventFired', { timestamp: 2 }, 'S-other');
      } else {
        reply(ws, msg, {});
      }
    }));
    const client = trackClient(await CdpClient.connect(b.url));
    const sid = await client.attachToTarget('T1');
    expect(sid).toBe('S1');

    const sessionEvents: string[] = [];
    client.onSession('S1', (method, params) => sessionEvents.push(`${method}:${params.timestamp}`));
    const anyEvents: (string | undefined)[] = [];
    client.on('Page.loadEventFired', (_p, s) => anyEvents.push(s));

    const loaded = client.waitForEvent('Page.loadEventFired', { sessionId: 'S1', timeoutMs: 1000 });
    await client.send('Page.navigate', { url: 'https://example.com' }, { sessionId: 'S1' });
    expect(await loaded).toEqual({ timestamp: 1 });
    await Bun.sleep(20);

    expect(b.received.find(m => m.method === 'Page.navigate')!.sessionId).toBe('S1');
    expect(b.received.find(m => m.method === 'Target.attachToTarget')!.sessionId).toBeUndefined();
    expect(sessionEvents).toEqual(['Page.loadEventFired:1']);
    expect(anyEvents).toEqual(['S1', 'S-other']);
  });

  test('detaching a target drops its session handlers', async () => {
    const b = track(fakeBrowser((msg, ws) => reply(ws, msg, {})));
    const client = trackClient(await CdpClient.connect(b.url));
    await client.send('Ping');
    const seen: string[] = [];
    client.onSession('S9', (method) => seen.push(method));
    const ws = b.sockets[0]!;
    emit(ws, 'Runtime.consoleAPICalled', {}, 'S9');
    emit(ws, 'Target.detachedFromTarget', { sessionId: 'S9' });
    emit(ws, 'Runtime.consoleAPICalled', {}, 'S9');
    await Bun.sleep(30);
    expect(seen).toEqual(['Runtime.consoleAPICalled']);
  });

  test('a throwing handler does not break delivery to the others', async () => {
    const b = track(fakeBrowser((msg, ws) => reply(ws, msg, {})));
    const client = trackClient(await CdpClient.connect(b.url));
    await client.send('Ping');
    const got: number[] = [];
    client.on('X.event', () => { throw new Error('boom'); });
    client.on('X.event', (p) => got.push(p.n));
    emit(b.sockets[0]!, 'X.event', { n: 7 });
    await Bun.sleep(20);
    expect(got).toEqual([7]);
  });

  test('when the socket closes, pending requests and waiters reject and onClose fires', async () => {
    const b = track(fakeBrowser(() => {}));
    const client = await CdpClient.connect(b.url);
    let closedWith = '';
    client.onClose((why) => { closedWith = why; });
    const pendingReq = client.send('Never.answered', {}, { timeoutMs: 5000 }).catch(e => e);
    const waiter = client.waitForEvent('Never.fired', { timeoutMs: 5000 }).catch(e => e);
    await Bun.sleep(20);
    b.sockets[0]!.close(1001, 'bye');
    expect(await pendingReq).toBeInstanceOf(CdpClosedError);
    expect(await waiter).toBeInstanceOf(CdpClosedError);
    expect(client.closed).toBe(true);
    expect(closedWith).toContain('1001');
    expect(await client.send('After.close').catch(e => e)).toBeInstanceOf(CdpClosedError);
  });

  test('target helpers send the right commands', async () => {
    const b = track(fakeBrowser((msg, ws) => {
      if (msg.method === 'Target.createBrowserContext') reply(ws, msg, { browserContextId: 'C1' });
      else if (msg.method === 'Target.createTarget') reply(ws, msg, { targetId: 'T7' });
      else reply(ws, msg, {});
    }));
    const client = trackClient(await CdpClient.connect(b.url));
    const ctx = await client.createBrowserContext();
    const target = await client.createTarget({ url: 'about:blank', browserContextId: ctx, newWindow: true });
    await client.closeTarget(target);
    expect(ctx).toBe('C1');
    expect(target).toBe('T7');
    expect(b.received.map(m => [m.method, m.params])).toEqual([
      ['Target.createBrowserContext', { disposeOnDetach: false }],
      ['Target.createTarget', { url: 'about:blank', browserContextId: 'C1', newWindow: true }],
      ['Target.closeTarget', { targetId: 'T7' }],
    ]);
  });

  test('connecting to nothing fails fast with a clear error', async () => {
    const b = fakeBrowser(() => {});
    const url = b.url;
    b.stop();
    const err = await CdpClient.connect(url, { timeoutMs: 2000 }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Could not connect|timed out/);
  });
});
