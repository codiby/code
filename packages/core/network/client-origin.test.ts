import { afterEach, describe, expect, test } from 'bun:test';

import {
  bindSubscriptionMap,
  describeClientOrigin,
  forgetClientOrigin,
  isLoopbackAddress,
  registerClientOrigin,
  remoteViewerHosts,
  sessionViewerLocation,
} from './client-origin';

// The module holds process-wide state (it mirrors the bridge's one WS
// registry), so each test cleans up the clients it registered.
const registered: unknown[] = [];
const subscriptions = new Map<unknown, Set<string>>();
bindSubscriptionMap(subscriptions);

function connect(address: string, host: string | null, sessionIds: string[] = []): object {
  const ws = {};
  registerClientOrigin(ws, describeClientOrigin(address, host));
  registered.push(ws);
  if (sessionIds.length) subscriptions.set(ws, new Set(sessionIds));
  return ws;
}

afterEach(() => {
  for (const ws of registered.splice(0)) forgetClientOrigin(ws);
  subscriptions.clear();
});

describe('isLoopbackAddress', () => {
  test('accepts every shape the loopback peer arrives as', () => {
    for (const addr of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:127.0.0.1', 'localhost', '::1%lo0']) {
      expect(isLoopbackAddress(addr)).toBe(true);
    }
  });

  test('rejects addresses that reach us over the network', () => {
    // 127.0.0.1.example.com and the like must not slip through a prefix match.
    for (const addr of ['192.168.1.24', '10.0.0.2', '100.87.4.1', 'fd7a::1', '127.0.0.1.evil.test', '']) {
      expect(isLoopbackAddress(addr)).toBe(false);
    }
    expect(isLoopbackAddress(null)).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('describeClientOrigin', () => {
  test('strips the port from the Host header and flags a network peer', () => {
    const origin = describeClientOrigin('192.168.1.24', 'mac-mini.tail1234.ts.net:3111');
    expect(origin.remote).toBe(true);
    expect(origin.host).toBe('mac-mini.tail1234.ts.net');
    expect(origin.address).toBe('192.168.1.24');
  });

  test('treats the desktop app on this machine as local', () => {
    expect(describeClientOrigin('::ffff:127.0.0.1', 'localhost:3111').remote).toBe(false);
  });

  test('survives a missing Host header', () => {
    expect(describeClientOrigin('192.168.1.24', null).host).toBeNull();
  });
});

describe('sessionViewerLocation', () => {
  test('is "none" when nobody is connected', () => {
    expect(sessionViewerLocation('s1')).toBe('none');
  });

  test('is "remote" when only a browser on another machine is watching', () => {
    connect('192.168.1.24', 'mac-mini.local:3111', ['s1']);
    expect(sessionViewerLocation('s1')).toBe('remote');
  });

  test('is "local" when the desktop app on this machine is watching too', () => {
    connect('192.168.1.24', 'mac-mini.local:3111', ['s1']);
    connect('127.0.0.1', 'localhost:3111', ['s1']);
    // A loopback viewer wins: `localhost:3000` opens fine for them, so telling
    // the agent to forward everything would be wrong.
    expect(sessionViewerLocation('s1')).toBe('local');
  });

  test('answers per session, not for the bridge as a whole', () => {
    connect('192.168.1.24', 'mac-mini.local:3111', ['s1']);
    connect('127.0.0.1', 'localhost:3111', ['s2']);
    expect(sessionViewerLocation('s1')).toBe('remote');
    expect(sessionViewerLocation('s2')).toBe('local');
  });

  test('falls back to every client while a session has no subscribers yet', () => {
    // This is the state at spawn: the tab exists but `subscribe` has not
    // arrived, and the system prompt still has to be decided.
    connect('192.168.1.24', 'mac-mini.local:3111', []);
    expect(sessionViewerLocation('not-subscribed-yet')).toBe('remote');
  });
});

describe('remoteViewerHosts', () => {
  test('prefers the Host header and skips local clients', () => {
    connect('127.0.0.1', 'localhost:3111', ['s1']);
    connect('192.168.1.24', 'mac-mini.tail1234.ts.net:3111', ['s1']);
    expect(remoteViewerHosts()).toEqual(['mac-mini.tail1234.ts.net']);
  });

  test('falls back to the peer address when no Host header made it through', () => {
    connect('192.168.1.24', null, ['s1']);
    expect(remoteViewerHosts()).toEqual(['192.168.1.24']);
  });

  test('deduplicates two tabs on the same remote machine', () => {
    connect('192.168.1.24', 'mac-mini.local:3111', ['s1']);
    connect('192.168.1.24', 'mac-mini.local:3111', ['s2']);
    expect(remoteViewerHosts()).toEqual(['mac-mini.local']);
  });
});
