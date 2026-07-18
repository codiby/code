import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Conn } from './conn';

/**
 * Deterministic stand-in for the browser WebSocket. Opens on the next
 * microtask (mirrors the async open of a real socket) and fires `onclose`
 * asynchronously after `close()` — the async close event is load-bearing:
 * the historical orphan-socket leak depended on `onclose` running after the
 * caller had already moved on.
 */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState === FakeWebSocket.CONNECTING) {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
      }
    });
  }

  send(data: string) { this.sent.push(data); }

  close() {
    if (this.readyState >= FakeWebSocket.CLOSING) return;
    this.readyState = FakeWebSocket.CLOSING;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.();
    });
  }

  /** Server/network-initiated close (no local close() call). */
  serverClose() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const RECONNECT_MS = 20;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const settle = () => sleep(1); // flush microtasks + timer queue turn

const openSockets = () => FakeWebSocket.instances.filter(w => w.readyState === FakeWebSocket.OPEN);

const RealWebSocket = globalThis.WebSocket;
let conn: Conn | null = null;

function makeConn(opts: { base?: string | null; resolveBase?: () => Promise<string | null> } = {}) {
  conn = new Conn(null, opts.base ?? 'http://test', {
    resolveBase: opts.resolveBase ?? (async () => opts.base ?? 'http://test'),
    token: () => null,
    onMessage: () => {},
    onStatus: () => {},
    reconnectDelayMs: RECONNECT_MS,
  });
  return conn;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as any).WebSocket = FakeWebSocket;
});

afterEach(() => {
  conn?.destroy();
  conn = null;
  (globalThis as any).WebSocket = RealWebSocket;
});

describe('Conn socket lifecycle', () => {
  test('connects and resubscribes activeSubs on open', async () => {
    const c = makeConn();
    c.subscribe('session-1');
    await settle();
    expect(openSockets().length).toBe(1);
    // Sub was queued before open → replayed by onopen.
    expect(openSockets()[0]!.sent.some(s => s.includes('session-1'))).toBe(true);
  });

  test('background close does NOT resurrect the socket via the reconnect timer', async () => {
    const c = makeConn();
    await settle();
    expect(openSockets().length).toBe(1);

    c.closeForBackground();
    await sleep(RECONNECT_MS * 3);

    // Old bug: the closed socket's own onclose scheduled reopenSoon() and the
    // connection came back while still backgrounded.
    expect(openSockets().length).toBe(0);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  test('REGRESSION: background close + quick reopen leaves exactly one socket', async () => {
    // The minimize/restore race that leaked one orphan per cycle: the closed
    // socket's onclose scheduled a reconnect timer; reopen() built a healthy
    // socket; the stale timer then built a second one on top of it.
    const c = makeConn();
    c.subscribe('session-1');
    await settle();

    for (let cycle = 0; cycle < 3; cycle++) {
      c.closeForBackground();
      await settle();          // let the old socket's onclose fire
      c.reopen();              // restore inside the reconnect-delay window
      await sleep(RECONNECT_MS * 3); // let any zombie timer fire
    }

    expect(openSockets().length).toBe(1);
  });

  test('network drop still reconnects', async () => {
    makeConn();
    await settle();
    const first = openSockets()[0]!;

    first.serverClose();
    await sleep(RECONNECT_MS * 3);

    expect(openSockets().length).toBe(1);
    expect(openSockets()[0]).not.toBe(first);
  });

  test('concurrent connect attempts (slow resolveBase) produce one socket', async () => {
    // Remote-tunnel shape: resolveBase takes seconds, so two attempts can be
    // in flight at once. The epoch guard makes the superseded attempt abandon.
    let release: (base: string | null) => void = () => {};
    const gate = new Promise<string | null>(r => { release = r; });
    const c = makeConn({ base: null, resolveBase: () => gate });
    await settle();            // attempt #1 parked on resolveBase
    c.reopen();                // attempt #2 parked on the same gate
    await settle();

    release('http://test');
    await sleep(RECONNECT_MS * 3);

    expect(openSockets().length).toBe(1);
  });

  test('destroy closes the socket and stops the reconnect loop', async () => {
    const c = makeConn();
    await settle();
    c.destroy();
    await sleep(RECONNECT_MS * 3);
    expect(openSockets().length).toBe(0);
  });
});
