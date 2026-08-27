import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'net';

import {
  PortInUseError,
  closeAllPortForwards,
  closePortForward,
  closeSessionPortForwards,
  isTargetListening,
  listPortForwards,
  openPortForward,
} from './port-forward';

/** Bind an ephemeral loopback port and return it plus a way to release it. */
function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') { reject(new Error('no port')); return; }
      resolve({
        port: addr.port,
        release: () => new Promise<void>(res => srv.close(() => res())),
      });
    });
  });
}

/** An ephemeral port number nobody is holding by the time this resolves. */
async function freePort(): Promise<number> {
  const held = await occupyPort();
  await held.release();
  return held.port;
}

/** A trivial HTTP origin on loopback, standing in for a dev server. */
function startOrigin(body: string) {
  const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(body) });
  return { port: srv.port as number, stop: () => srv.stop(true) };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  closeAllPortForwards();
  for (const fn of cleanups.splice(0)) await fn();
});

describe('openPortForward', () => {
  test('pipes a public port through to a service on loopback', async () => {
    const origin = startOrigin('hello from the dev server');
    cleanups.push(origin.stop);
    const publicPort = await freePort();

    const forward = await openPortForward({
      sessionId: 'session-a',
      targetPort: origin.port,
      publicPort,
      label: 'vite dev',
    });
    expect(forward.publicPort).toBe(publicPort);
    expect(forward.targetHost).toBe('127.0.0.1');

    // Reaching it on the *public* port is the whole point — a remote browser
    // dials this machine's address, not its loopback.
    const resp = await fetch(`http://127.0.0.1:${publicPort}/`);
    expect(await resp.text()).toBe('hello from the dev server');

    expect(listPortForwards('session-a')).toHaveLength(1);
    expect(listPortForwards('session-a')[0]!.connections).toBeGreaterThan(0);
  });

  test('falls back to a free port instead of failing when the caller named none', async () => {
    const origin = startOrigin('x');
    cleanups.push(origin.stop);
    const wanted = await freePort();
    const blocker = Bun.serve({ port: wanted, hostname: '0.0.0.0', fetch: () => new Response('busy') });
    cleanups.push(() => blocker.stop(true));

    // No `publicPort`: mirroring `targetPort` is a nicety, and on Linux it is
    // impossible whenever the service already holds that number on loopback.
    const forward = await openPortForward({ sessionId: 's', targetPort: wanted });
    expect(forward.publicPort).not.toBe(wanted);
    expect(forward.publicPort).toBeGreaterThan(0);

    // The fallback port is a real, working listener.
    const resp = await fetch(`http://127.0.0.1:${forward.publicPort}/`);
    expect(resp.status).toBe(200);
  });

  test('mirrors the target port when it happens to be free', async () => {
    const origin = startOrigin('same-port');
    cleanups.push(origin.stop);
    const mirrored = await freePort();

    const forward = await openPortForward({ sessionId: 's', targetPort: mirrored });
    expect(forward.publicPort).toBe(mirrored);
  });

  test('reports an explicitly requested port held by another process as in use', async () => {
    const origin = startOrigin('x');
    cleanups.push(origin.stop);
    const taken = await freePort();
    // Bind on 0.0.0.0, the same interface a forward uses, so the conflict is
    // the real EADDRINUSE the tool has to report rather than an artefact of
    // how the OS scopes a loopback-only listener.
    const blocker = Bun.serve({ port: taken, hostname: '0.0.0.0', fetch: () => new Response('busy') });
    cleanups.push(() => blocker.stop(true));

    const attempt = openPortForward({ sessionId: 's', targetPort: origin.port, publicPort: taken });
    expect(attempt).rejects.toThrow(PortInUseError);
    await attempt.catch((err: PortInUseError) => {
      expect(err.port).toBe(taken);
      expect(err.heldBySessionId).toBeNull();
      expect(err.message).toContain('already in use');
    });
  });

  test('reports a port this bridge already forwards, naming the owning session', async () => {
    const origin = startOrigin('x');
    cleanups.push(origin.stop);
    const publicPort = await freePort();

    await openPortForward({ sessionId: 'owner-session', targetPort: origin.port, publicPort });

    const attempt = openPortForward({ sessionId: 'other-session', targetPort: origin.port, publicPort });
    expect(attempt).rejects.toThrow(PortInUseError);
    await attempt.catch((err: PortInUseError) => {
      expect(err.heldBySessionId).toBe('owner-session');
    });
  });

  test('rejects a port outside the valid range', async () => {
    expect(openPortForward({ sessionId: 's', targetPort: 0 })).rejects.toThrow(RangeError);
    expect(openPortForward({ sessionId: 's', targetPort: 70000 })).rejects.toThrow(RangeError);
    expect(openPortForward({ sessionId: 's', targetPort: 3000, publicPort: -1 })).rejects.toThrow(RangeError);
  });

  test('opens even when nothing is listening yet, so a slow-booting server still works', async () => {
    const publicPort = await freePort();
    const dead = await freePort();

    const forward = await openPortForward({ sessionId: 's', targetPort: dead, publicPort });
    expect(forward.publicPort).toBe(publicPort);
    expect(await isTargetListening('127.0.0.1', dead)).toBe(false);
  });
});

describe('closePortForward', () => {
  test('drops the listener and refuses to close another session\'s forward', async () => {
    const origin = startOrigin('bye');
    cleanups.push(origin.stop);
    const publicPort = await freePort();

    await openPortForward({ sessionId: 'mine', targetPort: origin.port, publicPort });

    expect(closePortForward(publicPort, 'not-mine')).toBe(false);
    expect(listPortForwards('mine')).toHaveLength(1);

    expect(closePortForward(publicPort, 'mine')).toBe(true);
    expect(listPortForwards('mine')).toHaveLength(0);
    expect(closePortForward(publicPort, 'mine')).toBe(false);

    // The port is genuinely released, not just forgotten.
    const reopened = await openPortForward({ sessionId: 'mine', targetPort: origin.port, publicPort });
    expect(reopened.publicPort).toBe(publicPort);
  });
});

describe('listPortForwards', () => {
  test('scopes to one session', async () => {
    const origin = startOrigin('x');
    cleanups.push(origin.stop);
    const a = await freePort();
    const b = await freePort();

    await openPortForward({ sessionId: 'one', targetPort: origin.port, publicPort: a });
    await openPortForward({ sessionId: 'two', targetPort: origin.port, publicPort: b });

    expect(listPortForwards('one').map(f => f.publicPort)).toEqual([a]);
    expect(listPortForwards('two').map(f => f.publicPort)).toEqual([b]);
    expect(listPortForwards()).toHaveLength(2);
  });
});

describe('closeSessionPortForwards', () => {
  test('drops only the deleted session\'s forwards', async () => {
    const origin = startOrigin('x');
    cleanups.push(origin.stop);
    const a = await freePort();
    const b = await freePort();
    const c = await freePort();

    await openPortForward({ sessionId: 'doomed', targetPort: origin.port, publicPort: a });
    await openPortForward({ sessionId: 'doomed', targetPort: origin.port, publicPort: b });
    await openPortForward({ sessionId: 'survivor', targetPort: origin.port, publicPort: c });

    expect(closeSessionPortForwards('doomed')).toBe(2);
    expect(listPortForwards('doomed')).toHaveLength(0);
    expect(listPortForwards('survivor')).toHaveLength(1);
    expect(closeSessionPortForwards('doomed')).toBe(0);
  });
});
