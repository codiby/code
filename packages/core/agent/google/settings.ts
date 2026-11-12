/**
 * Google settings — `~/.codiby/agent/google.json`: where Google sends the
 * owner back after consent, and how much of Gmail / Calendar the agent may
 * use. The OAuth client and tokens live in the vault, never here.
 *
 * Access levels are cumulative (`send` includes `draft` includes `read`) and
 * map onto the OAuth scopes requested at connect time. The tools enforce the
 * level again on every call, so lowering a level takes effect immediately even
 * though the token still carries the broader scopes until the next reconnect.
 */

import { agentDataDir, createJsonStore } from '../store';

export const GMAIL_LEVELS = ['off', 'read', 'draft', 'send'] as const;
export const CALENDAR_LEVELS = ['off', 'read', 'write'] as const;

export type GmailLevel = (typeof GMAIL_LEVELS)[number];
export type CalendarLevel = (typeof CALENDAR_LEVELS)[number];

export interface GoogleSettings {
  /** Externally reachable https origin (+ optional path) of this bridge, no trailing slash. '' = unset. */
  publicBaseUrl: string;
  gmail: GmailLevel;
  calendar: CalendarLevel;
  /** Why the connection was dropped (refresh token revoked/expired), shown until the next connect. */
  lastError: { message: string; at: number } | null;
}

export const SCOPE = {
  openid: 'openid',
  email: 'email',
  gmailRead: 'https://www.googleapis.com/auth/gmail.readonly',
  // Labels, read state and archiving need gmail.modify; readonly/compose can't change a message.
  gmailModify: 'https://www.googleapis.com/auth/gmail.modify',
  gmailCompose: 'https://www.googleapis.com/auth/gmail.compose',
  gmailSend: 'https://www.googleapis.com/auth/gmail.send',
  calendarRead: 'https://www.googleapis.com/auth/calendar.readonly',
  calendarEvents: 'https://www.googleapis.com/auth/calendar.events',
} as const;

/** Google reports the short `email` scope back under its long name. */
const SCOPE_ALIASES: Record<string, string> = {
  'https://www.googleapis.com/auth/userinfo.email': SCOPE.email,
};

export function canonicalScope(scope: string): string {
  return SCOPE_ALIASES[scope] ?? scope;
}

export function parseScopeString(scope: unknown): string[] {
  if (typeof scope !== 'string') return [];
  return [...new Set(scope.split(/\s+/).filter(Boolean).map(canonicalScope))];
}

export function gmailScopes(level: GmailLevel): string[] {
  switch (level) {
    case 'off': return [];
    case 'read': return [SCOPE.gmailRead];
    case 'draft': return [SCOPE.gmailRead, SCOPE.gmailModify, SCOPE.gmailCompose];
    case 'send': return [SCOPE.gmailRead, SCOPE.gmailModify, SCOPE.gmailCompose, SCOPE.gmailSend];
  }
}

export function calendarScopes(level: CalendarLevel): string[] {
  switch (level) {
    case 'off': return [];
    case 'read': return [SCOPE.calendarRead];
    // freeBusy and calendar listings still go through the read scope.
    case 'write': return [SCOPE.calendarRead, SCOPE.calendarEvents];
  }
}

/** Scopes to request for the given settings, identity first. */
export function requiredScopes(s: Pick<GoogleSettings, 'gmail' | 'calendar'>): string[] {
  return [SCOPE.openid, SCOPE.email, ...gmailScopes(s.gmail), ...calendarScopes(s.calendar)];
}

export function gmailLevelAtLeast(level: GmailLevel, min: GmailLevel): boolean {
  return GMAIL_LEVELS.indexOf(level) >= GMAIL_LEVELS.indexOf(min);
}

export function calendarLevelAtLeast(level: CalendarLevel, min: CalendarLevel): boolean {
  return CALENDAR_LEVELS.indexOf(level) >= CALENDAR_LEVELS.indexOf(min);
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validate and canonicalise a public base URL. Google only accepts https
 * redirect URIs, except for loopback hosts during development.
 * Throws with a message meant for the owner.
 */
export function normalizePublicBaseUrl(input: string): string {
  const raw = input.trim();
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Public base URL must be a full URL, e.g. https://my-host.tailnet.ts.net');
  }
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Public base URL must use https:// (Google rejects plain http redirect URIs)');
  }
  if (url.username || url.password) throw new Error('Public base URL must not contain credentials');
  if (url.search || url.hash) throw new Error('Public base URL must not contain a query string or #fragment');
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** Where Google redirects after consent. Null until the public base URL is set. */
export function redirectUriFor(publicBaseUrl: string): string | null {
  return publicBaseUrl ? `${publicBaseUrl}/agent/google/callback` : null;
}

function oneOf<T extends string>(list: readonly T[], v: unknown, fallback: T): T {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function normalizeGoogleSettings(raw: unknown): GoogleSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  let publicBaseUrl = '';
  try { publicBaseUrl = typeof r.publicBaseUrl === 'string' ? normalizePublicBaseUrl(r.publicBaseUrl) : ''; } catch {}
  const err = r.lastError as Record<string, unknown> | null | undefined;
  return {
    publicBaseUrl,
    gmail: oneOf(GMAIL_LEVELS, r.gmail, 'read'),
    calendar: oneOf(CALENDAR_LEVELS, r.calendar, 'read'),
    lastError: err && typeof err.message === 'string' && typeof err.at === 'number'
      ? { message: err.message.slice(0, 500), at: err.at }
      : null,
  };
}

const store = createJsonStore<GoogleSettings>({ file: agentDataDir('google.json'), normalize: normalizeGoogleSettings });

export function loadGoogleSettings(): GoogleSettings {
  return store.get();
}

export function updateGoogleSettings(fn: (s: GoogleSettings) => GoogleSettings): GoogleSettings {
  return store.update(fn);
}

/** Tests only. */
export function _reloadGoogleSettings(): GoogleSettings {
  return store.reload();
}
