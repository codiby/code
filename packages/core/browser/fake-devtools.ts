/**
 * Test helper: a tiny in-process stand-in for Chromium's DevTools endpoint
 * and process, enough for the manager's lifecycle (targets, contexts, flatten
 * sessions, navigation events, screenshots, Browser.close, crashes). Only
 * imported by *.test.ts files.
 */

import type { Server, ServerWebSocket } from 'bun';
import type { LaunchedChromium } from './launcher';

export type FakeMsg = { id: number; method: string; params?: any; sessionId?: string };

interface FakeTarget {
  targetId: string;
  sessionId: string | null;
  url: string;
  browserContextId?: string;
}

export function fakeDevtools() {
  const received: FakeMsg[] = [];
  const targets = new Map<string, FakeTarget>();
  let socket: ServerWebSocket<unknown> | null = null;
  let seq = 0;
  let exitResolve: ((code: number | null) => void) | null = null;
  const launches: { sandbox: boolean; preferNoSandbox?: boolean }[] = [];
  const killed: string[] = [];

  const send = (obj: unknown) => socket?.send(JSON.stringify(obj));
  const emit = (method: string, params: unknown, sessionId?: string) => send({ method, params, ...(sessionId ? { sessionId } : {}) });
  const bySession = (sid?: string) => [...targets.values()].find(t => t.sessionId === sid);

  function answer(msg: FakeMsg): unknown {
    const p = msg.params ?? {};
    switch (msg.method) {
      case 'Target.createBrowserContext':
        return { browserContextId: `ctx-${++seq}` };
      case 'Target.createTarget': {
        const targetId = `T${++seq}`;
        targets.set(targetId, { targetId, sessionId: null, url: p.url, browserContextId: p.browserContextId });
        return { targetId };
      }
      case 'Target.attachToTarget': {
        const t = targets.get(p.targetId);
        if (!t) throw new Error('No target with given id');
        t.sessionId = `S-${t.targetId}`;
        return { sessionId: t.sessionId };
      }
      case 'Target.getTargetInfo': {
        const t = targets.get(p.targetId);
        if (!t) throw new Error('No target with given id');
        return { targetInfo: { targetId: t.targetId, url: t.url, title: `Title of ${t.url}`, type: 'page' } };
      }
      case 'Target.closeTarget': {
        const t = targets.get(p.targetId);
        targets.delete(p.targetId);
        if (t?.sessionId) queueMicrotask(() => emit('Target.detachedFromTarget', { sessionId: t.sessionId, targetId: t.targetId }));
        return { success: !!t };
      }
      case 'Page.navigate': {
        const t = bySession(msg.sessionId);
        if (!t) throw new Error('Session not found');
        t.url = p.url;
        queueMicrotask(() => {
          emit('Page.frameNavigated', { frame: { id: t.targetId, url: p.url } }, t.sessionId!);
          emit('Page.loadEventFired', { timestamp: Date.now() }, t.sessionId!);
        });
        return { frameId: t.targetId, loaderId: `L${++seq}` };
      }
      case 'Page.captureScreenshot': {
        const t = bySession(msg.sessionId);
        return { data: Buffer.from(`shot:${t?.url}:${++seq}`).toString('base64') };
      }
      case 'Runtime.evaluate':
        return { result: { type: 'string', value: `evaluated on ${bySession(msg.sessionId)?.url}` } };
      case 'Browser.close':
        queueMicrotask(() => { socket?.close(1000, 'browser closed'); exitResolve?.(0); });
        return {};
      default:
        return {};
    }
  }

  const server: Server<unknown> = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      if (srv.upgrade(req, { data: undefined })) return undefined;
      return new Response('no', { status: 400 });
    },
    websocket: {
      open(ws) { socket = ws; },
      message(ws, data) {
        const msg = JSON.parse(String(data)) as FakeMsg;
        received.push(msg);
        try {
          ws.send(JSON.stringify({ id: msg.id, result: answer(msg), ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }));
        } catch (err) {
          ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: (err as Error).message } }));
        }
      },
    },
  });

  /** Plays the role of launchWithSandboxFallback: a "process" whose exit the test controls. */
  async function launch(opts: { preferNoSandbox?: boolean }): Promise<LaunchedChromium> {
    launches.push({ sandbox: !opts.preferNoSandbox, preferNoSandbox: opts.preferNoSandbox });
    const exited = new Promise<number | null>((resolve) => { exitResolve = resolve; });
    return {
      proc: { kill: (sig?: string) => { killed.push(String(sig ?? 'SIGTERM')); exitResolve?.(null); } } as unknown as LaunchedChromium['proc'],
      pid: 900_000 + launches.length,
      wsEndpoint: `ws://127.0.0.1:${server.port}/devtools/browser/fake`,
      port: server.port ?? 0,
      sandbox: !opts.preferNoSandbox,
      exited,
      stderrTail: () => '',
    };
  }

  return {
    received,
    targets,
    launches,
    killed,
    launch,
    methods: () => received.map(m => m.method),
    /** Simulate Chromium dying: the socket drops and the process exits. */
    crash() {
      socket?.close(1011, 'crashed');
      exitResolve?.(139);
    },
    stop() { server.stop(true); },
  };
}
