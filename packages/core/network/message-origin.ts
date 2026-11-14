/**
 * Where each user message came from: which client, on which device and
 * network, and the route it took to this bridge.
 *
 * ./client-origin answers "is anyone watching from another machine"; this
 * answers "where is the person who just wrote". They differ more than it
 * seems: the desktop app can sit open on this Mac while the user types from a
 * phone on mobile data, and the links that phone can open (only the public
 * Funnel URL) are not the ones the desktop could (localhost, LAN, tailnet).
 *
 * Every user message stores its origin, and the agent gets a short
 * `<system-reminder>` whenever it changes from the last one it was told.
 */

import { describeClientOrigin, type ClientOrigin, type ClientRoute } from './client-origin';

export type ClientKind = 'desktop-app' | 'android-app' | 'ios-app' | 'browser' | 'unknown';
export type ClientTransport = 'wifi' | 'cellular' | 'ethernet' | 'other' | 'unknown';

export type MessageOrigin = {
  client: ClientKind;
  /** e.g. "samsung SM-S948B" or "MacIntel"; free text from the client. */
  device?: string;
  transport?: ClientTransport;
  route: ClientRoute;
  /** The name the client reached the bridge under, port stripped. */
  host: string | null;
  address: string;
};

/** What a client says about itself; every field is optional and untrusted. */
export type ClientHints = { client?: unknown; device?: unknown; transport?: unknown };

const KINDS: readonly ClientKind[] = ['desktop-app', 'android-app', 'ios-app', 'browser'];
const TRANSPORTS: readonly ClientTransport[] = ['wifi', 'cellular', 'ethernet', 'other'];

function clean(value: unknown, max = 60): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Ends up inside the agent's context: keep it a short, single plain line.
  const text = value.replace(/[\r\n<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return text || undefined;
}

export function buildMessageOrigin(origin: ClientOrigin, hints: ClientHints = {}): MessageOrigin {
  const kind = KINDS.find(k => k === hints.client) ?? 'unknown';
  const transport = TRANSPORTS.find(t => t === hints.transport);
  const device = clean(hints.device);
  return {
    client: kind,
    ...(device ? { device } : {}),
    ...(transport ? { transport } : {}),
    route: origin.route,
    host: origin.host,
    address: origin.address,
  };
}

/** Origin of an HTTP request; the hints ride in `X-Codiby-*` headers. */
export function messageOriginFromRequest(req: Request, peerAddress: string | null | undefined): MessageOrigin {
  const origin = describeClientOrigin(peerAddress, req.headers.get('host'), req.headers);
  return buildMessageOrigin(origin, {
    client: req.headers.get('x-codiby-client'),
    device: req.headers.get('x-codiby-device'),
    transport: req.headers.get('x-codiby-network'),
  });
}

const CLIENT_LABEL: Record<ClientKind, string> = {
  'desktop-app': 'the Codiby desktop app',
  'android-app': 'the Codiby Android app',
  'ios-app': 'the Codiby iOS app',
  browser: 'a web browser',
  unknown: 'a Codiby client',
};

const TRANSPORT_LABEL: Record<ClientTransport, string> = {
  wifi: 'on Wi-Fi',
  cellular: 'on mobile data',
  ethernet: 'on Ethernet',
  other: 'on another network',
  unknown: '',
};

function where(origin: MessageOrigin): string {
  const host = origin.host || origin.address;
  switch (origin.route) {
    case 'this-machine': return 'on this same machine';
    case 'lan': return `over the local network, reaching this bridge at \`${host}\``;
    case 'tailnet': return `over Tailscale, reaching this bridge as \`${host}\``;
    case 'tailscale-funnel': return `over the public internet through Tailscale Funnel, as \`https://${host}\``;
    case 'internet': return `over the public internet, as \`${host}\``;
  }
}

function linkRule(origin: MessageOrigin): string {
  const host = origin.host || origin.address;
  switch (origin.route) {
    case 'this-machine':
      return '`localhost` URLs open fine for them.';
    case 'lan':
      return `Give links on \`${host}\` (e.g. \`http://${host}:<port>\`), never \`localhost\`. Tailscale addresses only work if their device is also on the tailnet.`;
    case 'tailnet':
      return `Give links on \`${host}\` (e.g. \`http://${host}:<port>\`), never \`localhost\`. LAN addresses (192.168.x.x) only work if they happen to be on the same network.`;
    case 'tailscale-funnel':
      return `Only public HTTPS links open for them, such as \`https://${host}/...\`. LAN addresses (192.168.x.x), Tailscale IPs (100.x) and \`localhost\` will NOT open; to show a page, publish it under that Funnel URL.`;
    case 'internet':
      return 'Only public URLs open for them; `localhost`, LAN and Tailscale addresses will not.';
  }
}

/** One-paragraph reminder the agent reads ahead of the user's text. */
export function describeMessageOrigin(origin: MessageOrigin): string {
  const client = CLIENT_LABEL[origin.client] + (origin.device ? ` (${origin.device})` : '');
  const transport = origin.transport ? ` ${TRANSPORT_LABEL[origin.transport]}` : '';
  return [
    '<system-reminder>',
    `Message origin (Codiby Code-specific): the user sent this from ${client}${transport}, ${where(origin)}.`,
    `- Links you hand them must open from there. ${linkRule(origin)}`,
    '</system-reminder>',
  ].join('\n');
}

/** What each session's agent was last told, so an unchanged origin costs nothing. */
const told = new Map<string, string>();

function originKey(origin: MessageOrigin): string {
  return [origin.client, origin.device ?? '', origin.transport ?? '', origin.route, origin.host ?? origin.address].join('|');
}

/** The reminder to prepend for this message, or null when nothing changed. */
export function messageOriginReminder(sessionId: string, origin: MessageOrigin): string | null {
  const key = originKey(origin);
  if (told.get(sessionId) === key) return null;
  told.set(sessionId, key);
  return describeMessageOrigin(origin);
}

/** Forget what a session was told: on delete, and when its provider respawns with a fresh context. */
export function forgetMessageOrigin(sessionId: string): void {
  told.delete(sessionId);
}

