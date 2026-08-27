/**
 * Telling the agent that its user is not sitting at this machine.
 *
 * Left to itself an agent will start a dev server and hand over
 * `http://localhost:5173`, which is correct on the box it runs on and useless
 * to a browser somewhere else on the network. This module turns the socket-level
 * fact from ./client-origin into (a) a system-prompt block injected at spawn and
 * (b) a reminder for when the answer changes mid-session, plus the URL builder
 * the port-forward tools hand back.
 */

import { hostname } from 'os';

import { remoteViewerHosts, sessionViewerLocation } from './client-origin';
import type { ViewerLocation } from './client-origin';

/**
 * URL a remote viewer should open for a published port. Prefers the hostname
 * the client actually reached the bridge on, so a Tailscale or mDNS name
 * survives instead of being replaced by a LAN IP that only resolves here.
 *
 * With no remote client connected there is nothing to prefer, so this falls
 * back to the machine's own hostname. Never `localhost` — handing back the one
 * URL we spend the whole briefing telling the agent not to use would be worse
 * than a name that merely might not resolve.
 */
export function publishedPortUrl(publicPort: number): string {
  const host = remoteViewerHosts()[0] || hostname();
  const bracketed = host.includes(':') ? `[${host}]` : host;
  return `http://${bracketed}:${publicPort}`;
}

/** True when the URL above is a guess rather than the name a client used. */
export function publishedUrlIsGuess(): boolean {
  return remoteViewerHosts().length === 0;
}

function guidanceLines(): string[] {
  const hosts = remoteViewerHosts();
  const where = hosts.length ? `\`${hosts[0]}\`` : 'a different machine on the network';
  return [
    'Remote viewer (Codiby Code-specific):',
    `- The user's browser is NOT on this machine. It reaches this bridge as ${where}. Everything you start here — dev servers, previews, databases, docs sites — binds to *this* machine's loopback, which their browser cannot reach.`,
    '- Never hand over a `localhost` or `127.0.0.1` URL, and never assume a link printed by a dev server is one they can open. Before giving the user any URL for something you started, call `ui_forward_port` with that port and give them the URL the tool returns.',
    '- `ui_list_port_forwards` shows what this session has already forwarded — check it before forwarding again. `ui_close_port_forward` takes one down once the process behind it is gone.',
    '- If `ui_forward_port` reports the port is already in use, pick a different `public_port` rather than retrying the same one.',
    '- A forwarded port is reachable by anyone who can route to this machine, and there is no auth in front of it. Forward what the user asked to see, not everything you happen to have running.',
    '- Browser automation tools (`browser_open`, `browser_navigate`) drive a browser on THIS machine, so they can still use `localhost` directly. The forwarding rule is only about URLs you hand to the user.',
  ];
}

/**
 * What each session's provider has already been told. `'remote'` means the
 * briefing is in its context (system prompt or an earlier reminder); anything
 * else means it is not. Sessions absent from the map have heard nothing.
 */
const briefed = new Map<string, ViewerLocation>();

/**
 * System-prompt block for a session whose viewers are remote, or null when
 * they are local (or nobody is watching yet) — a local user gets nothing, so
 * the common case costs no tokens and carries no confusing advice.
 *
 * Call this at spawn: it records what the provider was told, which is what
 * `viewerLocationReminder` diffs against later.
 */
export function remoteViewerSystemPrompt(sessionId: string): string | null {
  const location = sessionViewerLocation(sessionId);
  briefed.set(sessionId, location);
  return location === 'remote' ? guidanceLines().join('\n') : null;
}

/**
 * A `<system-reminder>` to prepend to the next user turn when the viewer moved
 * since the provider was last told, or null when nothing changed.
 *
 * The system prompt is fixed at spawn, so this is what covers the user opening
 * a long-running session from their laptop an hour after it started. `'none'`
 * (nobody subscribed) never fires and never overwrites what was briefed —
 * a momentary reconnect is not a move.
 */
export function viewerLocationReminder(sessionId: string): string | null {
  const location = sessionViewerLocation(sessionId);
  if (location === 'none') return null;
  const previous = briefed.get(sessionId);
  if (previous === location) return null;
  briefed.set(sessionId, location);
  if (location === 'remote') {
    return ['<system-reminder>', ...guidanceLines(), '</system-reminder>'].join('\n');
  }
  // Only worth saying when it contradicts a briefing already in context.
  if (previous !== 'remote') return null;
  return [
    '<system-reminder>',
    'Remote viewer (Codiby Code-specific): the user is now watching this session from this machine, so `localhost` URLs work again and new services no longer need `ui_forward_port`. Forwards already opened stay up until you close them.',
    '</system-reminder>',
  ].join('\n');
}

/** Forget a session's briefing state. Called when the session is deleted. */
export function forgetViewerBriefing(sessionId: string): void {
  briefed.delete(sessionId);
}
