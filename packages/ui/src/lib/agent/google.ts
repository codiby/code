/**
 * Client for the agent's Google connection and saved website logins
 * (packages/core/agent/google). Secrets only travel one way: the server
 * accepts them and never returns a value, only names and timestamps.
 */

import type { AgentApi } from './api';

export type GmailLevel = 'off' | 'read' | 'draft' | 'send';
export type CalendarLevel = 'off' | 'read' | 'write';

export interface GoogleStatus {
  /** OAuth client saved and public base URL set: ready to connect. */
  configured: boolean;
  clientConfigured: boolean;
  clientIdHint: string | null;
  connected: boolean;
  email: string | null;
  scopes: string[];
  services: { gmail: GmailLevel; calendar: CalendarLevel };
  publicBaseUrl: string | null;
  redirectUri: string | null;
  missingScopes: string[];
  needsReconnect: boolean;
  lastError: { message: string; at: number } | null;
}

export interface GoogleAuthStart {
  url: string;
  expiresAt: number;
  redirectUri: string;
  scopes: string[];
}

export interface SavedLogin {
  name: string;
  domain: string;
  updatedAt: number;
}

export type GoogleClientInput = { clientId: string; clientSecret: string } | { credentialsJson: string };

export const GMAIL_LEVELS: { id: GmailLevel; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'The agent cannot touch your mail.' },
  { id: 'read', label: 'Read', hint: 'Search and read email.' },
  { id: 'draft', label: 'Draft', hint: 'Read, write drafts for you to send, mark read, archive and label.' },
  { id: 'send', label: 'Send', hint: 'Everything above, plus sending email on your behalf.' },
];

export const CALENDAR_LEVELS: { id: CalendarLevel; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'The agent cannot see your calendar.' },
  { id: 'read', label: 'Read', hint: 'See events and free/busy times.' },
  { id: 'write', label: 'Read & write', hint: 'Also create, move and delete events and invite guests.' },
];

const SCOPE_LABELS: Record<string, string> = {
  openid: 'Sign-in',
  email: 'Email address',
  'https://www.googleapis.com/auth/gmail.readonly': 'Gmail read',
  'https://www.googleapis.com/auth/gmail.modify': 'Gmail labels',
  'https://www.googleapis.com/auth/gmail.compose': 'Gmail drafts',
  'https://www.googleapis.com/auth/gmail.send': 'Gmail send',
  'https://www.googleapis.com/auth/calendar.readonly': 'Calendar read',
  'https://www.googleapis.com/auth/calendar.events': 'Calendar events',
};

export function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, '');
}

/** "https://www.github.com/login" → "www.github.com"; the server validates the result. */
export function domainFromInput(input: string): string {
  const raw = input.trim();
  if (!raw) return '';
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

export const googleApi = {
  status: (api: AgentApi) => api.get<GoogleStatus>('/agent/google/status'),
  saveClient: (api: AgentApi, input: GoogleClientInput) => api.send<GoogleStatus>('PUT', '/agent/google/client', input),
  removeClient: (api: AgentApi) => api.send<GoogleStatus>('DELETE', '/agent/google/client'),
  saveSettings: (api: AgentApi, patch: { publicBaseUrl?: string; gmail?: GmailLevel; calendar?: CalendarLevel }) =>
    api.send<GoogleStatus>('PUT', '/agent/google/settings', patch),
  detectBaseUrl: (api: AgentApi) => api.get<{ url: string | null; detail: string }>('/agent/google/detect-base-url'),
  startAuth: (api: AgentApi) => api.get<GoogleAuthStart>('/agent/google/auth/start'),
  disconnect: (api: AgentApi) => api.send<{ ok: true; revoked: boolean }>('POST', '/agent/google/disconnect'),
};

export const savedLoginsApi = {
  list: (api: AgentApi) => api.get<{ secrets: SavedLogin[] }>('/agent/secrets?prefix=site:'),
  save: (api: AgentApi, domain: string, username: string, password: string) =>
    api.send<{ ok: true; domain: string; updatedAt: number }>('PUT', `/agent/secrets/site/${encodeURIComponent(domain)}`, { username, password }),
  remove: (api: AgentApi, domain: string) =>
    api.send<{ ok: true; domain: string }>('DELETE', `/agent/secrets/site/${encodeURIComponent(domain)}`),
};
