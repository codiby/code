/**
 * Typed client for the agent's memory, people and fresh-thread routes, plus
 * the small validators the Memory and Persona tabs share.
 *
 * `phoneToWhatsAppJid` mirrors packages/core/agent/memory/phone.ts (the UI
 * can't import core); core's memory.test.ts checks the two give the same
 * answers.
 */

import type { AgentApi } from './api';

// ---------------------------------------------------------------------------
// Types (mirror packages/core/agent/memory)
// ---------------------------------------------------------------------------

export const MEMORY_KINDS = ['profile', 'preference', 'person', 'fact', 'note', 'task'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const KIND_LABELS: Record<MemoryKind, string> = {
  profile: 'Profile',
  preference: 'Preference',
  person: 'Person',
  fact: 'Fact',
  note: 'Note',
  task: 'Task',
};

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  content: string;
  tags: string[];
  source: string | null;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export type MemoryCounts = Record<MemoryKind, number> & { total: number };

export interface MemoryList {
  items: MemoryItem[];
  total: number;
  counts: MemoryCounts;
}

export const HANDLE_CHANNELS = ['whatsapp', 'telegram', 'email', 'phone'] as const;
export type HandleChannel = (typeof HANDLE_CHANNELS)[number];
export type PersonHandles = Partial<Record<HandleChannel, string[]>>;

export const HANDLE_LABELS: Record<HandleChannel, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  email: 'Email',
  phone: 'Phone',
};

export interface Person {
  id: string;
  name: string;
  aliases: string[];
  relation: string | null;
  handles: PersonHandles;
  notes: string;
  createdAt: number;
  updatedAt: number;
}

export interface PersonInput {
  name: string;
  aliases: string[];
  relation: string;
  handles: PersonHandles;
  notes: string;
}

export interface MemorySettings {
  dailyRotation: { enabled: boolean; time: string };
  consolidateOnRotate: boolean;
}

export type ConsolidationOutcome = 'done' | 'timeout' | 'failed' | 'nothing_new' | 'disabled' | 'unavailable';

export interface MemoryStatus {
  settings: MemorySettings;
  state: {
    lastRotatedAt: number | null;
    lastConsolidation: { at: number; reason: string; outcome: ConsolidationOutcome; saved: number } | null;
    rotating: boolean;
    /** Next daily fresh start; null when off or overdue. */
    nextAt: number | null;
    /** The daily slot passed and the agent is waiting for two quiet hours. */
    waitingForQuiet: boolean;
    timezone: string;
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;

export const agentMemory = {
  list: (api: AgentApi, opts: { query?: string; kind?: MemoryKind | null; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.query?.trim()) q.set('query', opts.query.trim());
    if (opts.kind) q.set('kind', opts.kind);
    if (opts.limit) q.set('limit', String(opts.limit));
    return api.get<MemoryList>(`/agent/memory?${q}`);
  },
  create: (api: AgentApi, input: { content: string; kind: MemoryKind; tags: string[]; pinned: boolean }) =>
    api.send<{ item: MemoryItem; created: boolean }>('POST', '/agent/memory', input),
  update: (api: AgentApi, id: string, patch: Partial<Pick<MemoryItem, 'content' | 'kind' | 'tags' | 'pinned'>>) =>
    api.send<{ item: MemoryItem }>('PATCH', `/agent/memory/${enc(id)}`, patch),
  remove: (api: AgentApi, id: string) => api.send<{ ok: true }>('DELETE', `/agent/memory/${enc(id)}`),

  people: (api: AgentApi, query = '') =>
    api.get<{ people: Person[] }>(`/agent/people${query.trim() ? `?query=${enc(query.trim())}` : ''}`),
  createPerson: (api: AgentApi, input: PersonInput) => api.send<{ person: Person }>('POST', '/agent/people', input),
  updatePerson: (api: AgentApi, id: string, input: PersonInput) => api.send<{ person: Person }>('PATCH', `/agent/people/${enc(id)}`, input),
  removePerson: (api: AgentApi, id: string) => api.send<{ ok: true }>('DELETE', `/agent/people/${enc(id)}`),

  status: (api: AgentApi) => api.get<MemoryStatus>('/agent/memory/settings'),
  saveSettings: (api: AgentApi, patch: { dailyRotation?: Partial<MemorySettings['dailyRotation']>; consolidateOnRotate?: boolean }) =>
    api.send<MemoryStatus>('PUT', '/agent/memory/settings', patch),
  rotateNow: (api: AgentApi) => api.send<MemoryStatus & { ok: true }>('POST', '/agent/memory/rotate'),
};

// ---------------------------------------------------------------------------
// Validators shared by the Memory and Persona tabs
// ---------------------------------------------------------------------------

const MEXICO = '52';
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

/** Same rules as core's phone.ts: bare 10-digit numbers are Mexican; Mexican JIDs keep the mobile `1`. */
function parseNumber(input: string, defaultCountry: string): { country: string; national: string } | null {
  const trimmed = input.trim();
  if (!trimmed || /[a-z@]/i.test(trimmed)) return null;
  let digits = trimmed.replace(/\D/g, '');
  let international = trimmed.startsWith('+');
  if (!international && digits.startsWith('00')) {
    digits = digits.slice(2);
    international = true;
  }
  if (!digits) return null;
  if (!international) {
    if (digits.length === 13 && /^04[45]/.test(digits)) digits = digits.slice(3);
    else if (digits.length === 12 && digits.startsWith('01')) digits = digits.slice(2);
    if (digits.length === 10) return { country: defaultCountry, national: digits };
  }
  if (digits.startsWith(MEXICO)) {
    const rest = digits.slice(MEXICO.length);
    if (rest.length === 11 && rest.startsWith('1')) return { country: MEXICO, national: rest.slice(1) };
    if (rest.length === 10) return { country: MEXICO, national: rest };
  }
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;
  return { country: '', national: digits };
}

/** `6677805604` → `5216677805604@s.whatsapp.net`; null when it isn't a phone number. */
export function phoneToWhatsAppJid(input: string, defaultCountry = MEXICO): string | null {
  const p = parseNumber(input, defaultCountry);
  if (!p) return null;
  const user = p.country === MEXICO ? `${MEXICO}1${p.national}` : `${p.country}${p.national}`;
  if (user.length < MIN_DIGITS || user.length > MAX_DIGITS + 1) return null;
  return `${user}@s.whatsapp.net`;
}

/** A WhatsApp handle as the owner typed it → canonical JID (phone numbers, `@s.whatsapp.net`, `@c.us`, `@lid`). */
export function normalizeWhatsAppInput(input: string): string | null {
  const s = input.trim().toLowerCase();
  const jid = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|c\.us)$/.exec(s);
  if (jid) return phoneToWhatsAppJid(`+${jid[1]}`);
  if (/^\d+(?::\d+)?@lid$/.test(s)) return s.replace(/:\d+@/, '@');
  if (/^[\d-]+@g\.us$/.test(s)) return s;
  return phoneToWhatsAppJid(input);
}

export function isValidEmail(s: string): boolean {
  return /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/.test(s.trim());
}

/** Telegram chat ids are integers (groups are negative). */
export function isValidTelegramChatId(s: string): boolean {
  return /^-?\d{3,20}$/.test(s.trim());
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

let zones: string[] | null = null;

/** IANA zones this runtime knows, for the timezone picker. */
export function listTimeZones(): string[] {
  if (!zones) {
    try {
      zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
    } catch {
      zones = [];
    }
  }
  return zones;
}

export function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
