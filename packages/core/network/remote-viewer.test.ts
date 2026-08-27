import { afterEach, describe, expect, test } from 'bun:test';
import { hostname } from 'os';

import {
  bindSubscriptionMap,
  describeClientOrigin,
  forgetClientOrigin,
  registerClientOrigin,
} from './client-origin';
import {
  forgetViewerBriefing,
  publishedPortUrl,
  publishedUrlIsGuess,
  remoteViewerSystemPrompt,
  viewerLocationReminder,
} from './remote-viewer';

const registered: unknown[] = [];
const subscriptions = new Map<unknown, Set<string>>();
bindSubscriptionMap(subscriptions);

function connect(address: string, host: string | null, sessionIds: string[]): object {
  const ws = {};
  registerClientOrigin(ws, describeClientOrigin(address, host));
  registered.push(ws);
  subscriptions.set(ws, new Set(sessionIds));
  return ws;
}

function disconnect(ws: unknown) {
  forgetClientOrigin(ws);
  subscriptions.delete(ws);
}

afterEach(() => {
  for (const ws of registered.splice(0)) disconnect(ws);
  subscriptions.clear();
  for (const id of ['s1', 's2']) forgetViewerBriefing(id);
});

describe('remoteViewerSystemPrompt', () => {
  test('briefs a session whose only viewer is on another machine', () => {
    connect('192.168.1.24', 'mac-mini.local:3111', ['s1']);
    const prompt = remoteViewerSystemPrompt('s1');
    expect(prompt).toContain('ui_forward_port');
    expect(prompt).toContain('mac-mini.local');
    expect(prompt).toContain('NOT on this machine');
  });

  test('says nothing to a session watched from this machine', () => {
    connect('127.0.0.1', 'localhost:3111', ['s1']);
    // A local user gets no briefing at all — the common case costs no tokens
    // and carries no advice that would be wrong for them.
    expect(remoteViewerSystemPrompt('s1')).toBeNull();
  });

  test('says nothing when nobody is watching yet', () => {
    expect(remoteViewerSystemPrompt('s1')).toBeNull();
  });
});

describe('viewerLocationReminder', () => {
  test('fires when the user moves to another machine mid-session', () => {
    const local = connect('127.0.0.1', 'localhost:3111', ['s1']);
    expect(remoteViewerSystemPrompt('s1')).toBeNull();
    expect(viewerLocationReminder('s1')).toBeNull();

    // The system prompt is fixed at spawn, so this is the only way the agent
    // learns the user walked over to their laptop.
    disconnect(local);
    connect('192.168.1.24', 'mac-mini.local:3111', ['s1']);
    const notice = viewerLocationReminder('s1');
    expect(notice).toContain('<system-reminder>');
    expect(notice).toContain('ui_forward_port');
  });

  test('does not repeat itself while the viewer stays put', () => {
    connect('192.168.1.24', 'mac-mini.local:3111', ['s1']);
    expect(remoteViewerSystemPrompt('s1')).not.toBeNull();
    // Already in the system prompt — a second copy on every turn is waste.
    expect(viewerLocationReminder('s1')).toBeNull();
    expect(viewerLocationReminder('s1')).toBeNull();
  });

  test('tells the agent when the user comes back to this machine', () => {
    const remote = connect('192.168.1.24', 'mac-mini.local:3111', ['s1']);
    remoteViewerSystemPrompt('s1');

    disconnect(remote);
    connect('127.0.0.1', 'localhost:3111', ['s1']);
    expect(viewerLocationReminder('s1')).toContain('localhost` URLs work again');
  });

  test('stays quiet on a plain reconnect with nobody subscribed', () => {
    connect('192.168.1.24', 'mac-mini.local:3111', ['s1']);
    remoteViewerSystemPrompt('s1');

    for (const ws of registered.splice(0)) disconnect(ws);
    // 'none' is a momentary gap, not a move — it must not fire a notice, and
    // it must not overwrite what the provider was already told.
    expect(viewerLocationReminder('s1')).toBeNull();

    connect('192.168.1.24', 'mac-mini.local:3111', ['s1']);
    expect(viewerLocationReminder('s1')).toBeNull();
  });

  test('never announces "local" to a session that was never briefed', () => {
    connect('127.0.0.1', 'localhost:3111', ['s1']);
    // No spawn-time briefing recorded: saying "localhost works again" would be
    // a non sequitur in a context that never heard otherwise.
    expect(viewerLocationReminder('s1')).toBeNull();
  });
});

describe('publishedPortUrl', () => {
  test('uses the hostname the remote client actually reached the bridge on', () => {
    connect('100.87.4.1', 'mac-mini.tail1234.ts.net:3111', ['s1']);
    expect(publishedPortUrl(5173)).toBe('http://mac-mini.tail1234.ts.net:5173');
  });

  test('brackets an IPv6 literal', () => {
    connect('fd7a::1', '[fd7a::1]:3111', ['s1']);
    expect(publishedPortUrl(5173)).toBe('http://[fd7a::1]:5173');
  });

  test('falls back to this machine\'s hostname, never localhost', () => {
    // `localhost` is the one URL the whole briefing tells the agent not to
    // hand over, so it must not leak back in through the fallback.
    const url = publishedPortUrl(5173);
    expect(url).toBe(`http://${hostname()}:5173`);
    expect(url).not.toContain('localhost');
    expect(publishedUrlIsGuess()).toBe(true);
  });

  test('is not a guess once a remote client is connected', () => {
    connect('100.87.4.1', 'mac-mini.tail1234.ts.net:3111', ['s1']);
    expect(publishedUrlIsGuess()).toBe(false);
  });
});
