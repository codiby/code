/**
 * Agent configuration — `~/.codiby/agent/config.json`.
 *
 * Core settings only (who the agent is, who it serves, where it lives). Each
 * area keeps its own file next to this one (channels.json, heartbeat.json…)
 * via `createJsonStore`, so two areas never rewrite each other's settings.
 */

import { existsSync } from 'fs';
import { homedir, hostname } from 'os';
import { join } from 'path';
import { logError } from '../lib/logger';
import { loadTelegramSettings } from '../session/storage';
import { CODIBY_DIR, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from '../config/config';
import { DEFAULT_PROVIDER, listProviders } from '../provider/registry';
import { HttpError } from './http';
import { agentDataDir, createJsonStore } from './store';
// The leaf module, not './memory': its index registers routes, tools and
// hooks and imports this file back.
import { normalizeWhatsAppHandle } from './memory/phone';

export interface AgentPersona {
  /** Display name, used in the session tab and in how the agent introduces itself. */
  name: string;
  emoji: string;
  /** BCP-47 tag the agent replies in, or '' to mirror the owner's language. */
  language: string;
  /** IANA zone for "today", reminders and quiet hours. */
  timezone: string;
  /** Free-form tone/style guidance appended to the persona prompt. */
  style: string;
}

export interface AgentOwner {
  name: string;
  /** Telegram chat ids allowed to give orders. */
  telegramChatIds: string[];
  /** WhatsApp JIDs (`5216…@s.whatsapp.net`, `…@lid`) allowed to give orders. */
  whatsappJids: string[];
  emails: string[];
}

export interface QuietHours {
  enabled: boolean;
  /** Local "HH:MM" in persona.timezone. Urgent messages still go through. */
  start: string;
  end: string;
}

export interface AgentConfig {
  /** Only the agent host runs channels and the agent session. */
  enabled: boolean;
  persona: AgentPersona;
  owner: AgentOwner;
  /** The agent session's working directory (its notes, downloads, scratch). */
  workspaceDir: string;
  quietHours: QuietHours;
  /** Channel id for proactive messages; null = the channel the owner used last. */
  preferredChannel: string | null;
  provider: string;
  model: string | null;
}

const CONFIG_FILE = agentDataDir('config.json');

function defaultTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/**
 * A zone Intl accepts, else the host's. A typo saved from the Persona form
 * ("America/Mazatlan " is fine, "Mexico City" is not) would otherwise throw a
 * RangeError from every date the agent formats: channel headers, quiet hours,
 * reminders.
 */
function validTimezone(v: unknown): string {
  const tz = typeof v === 'string' ? v.trim() : '';
  if (!tz) return defaultTimezone();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return defaultTimezone();
  }
}

/**
 * Owner WhatsApp handles in the canonical form the channel and the people
 * directory compare against (`6677805604` → `5216677805604@s.whatsapp.net`,
 * device suffixes dropped). Anything that isn't a number or JID is kept as
 * typed rather than silently dropped from the owner list.
 */
function whatsappList(v: unknown): string[] {
  return [...new Set(strList(v).map(h => normalizeWhatsAppHandle(h) ?? h))];
}

/** `~/agent` — inside the sandbox under `bun test`, so tests never touch the real home. */
function defaultWorkspace(): string {
  return process.env.NODE_ENV === 'test' ? join(CODIBY_DIR, 'agent-workspace') : join(homedir(), 'agent');
}

const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map(s => s.trim()).filter(Boolean))] : [];
const hhmm = (v: unknown, fallback: string): string => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : fallback);

/**
 * A provider the bridge has registered (provider/registry.ts). The default
 * always passes. With nothing registered yet nothing can be checked, so any
 * name passes rather than discarding a valid choice; the bridge registers
 * its adapters before anything reads this config.
 */
export function isKnownProvider(name: string): boolean {
  if (name === DEFAULT_PROVIDER) return true;
  const known = listProviders();
  return known.length === 0 || known.includes(name);
}

/** A registered provider, else the default (a hand edit, an adapter that was removed). */
function validProvider(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name) return DEFAULT_PROVIDER;
  if (isKnownProvider(name)) return name;
  logError(`[agent] unknown provider ${JSON.stringify(name.slice(0, 64))} in the agent config; using ${DEFAULT_PROVIDER}`);
  return DEFAULT_PROVIDER;
}

/**
 * First boot: an install that already had a Telegram bot keeps behaving like
 * it did (agent on, paired chat as owner); a fresh install starts disabled.
 */
function legacyDefaults(): { enabled: boolean; telegramChatIds: string[] } {
  try {
    const tg = loadTelegramSettings();
    const token = tg.botToken || TELEGRAM_BOT_TOKEN;
    const chat = tg.chatId || TELEGRAM_CHAT_ID;
    return { enabled: !!token, telegramChatIds: chat ? [chat] : [] };
  } catch {
    return { enabled: false, telegramChatIds: [] };
  }
}

export function normalizeAgentConfig(raw: unknown): AgentConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const fresh = raw == null;
  const legacy = fresh ? legacyDefaults() : { enabled: false, telegramChatIds: [] };
  const persona = (r.persona ?? {}) as Record<string, unknown>;
  const owner = (r.owner ?? {}) as Record<string, unknown>;
  const quiet = (r.quietHours ?? {}) as Record<string, unknown>;
  return {
    enabled: fresh ? legacy.enabled : !!r.enabled,
    persona: {
      name: str(persona.name, 'Codiby').trim() || 'Codiby',
      emoji: str(persona.emoji, '🤖'),
      language: str(persona.language, ''),
      timezone: validTimezone(persona.timezone),
      style: str(persona.style, ''),
    },
    owner: {
      name: str(owner.name, ''),
      telegramChatIds: fresh ? legacy.telegramChatIds : strList(owner.telegramChatIds),
      whatsappJids: whatsappList(owner.whatsappJids),
      emails: strList(owner.emails),
    },
    workspaceDir: str(r.workspaceDir, '').trim() || defaultWorkspace(),
    quietHours: {
      enabled: !!quiet.enabled,
      start: hhmm(quiet.start, '23:00'),
      end: hhmm(quiet.end, '07:00'),
    },
    preferredChannel: typeof r.preferredChannel === 'string' && r.preferredChannel ? r.preferredChannel : null,
    provider: validProvider(r.provider),
    model: typeof r.model === 'string' && r.model.trim() ? r.model.trim() : null,
  };
}

const store = createJsonStore<AgentConfig>({
  file: CONFIG_FILE,
  // `null` from the store means "missing" or "unparseable". Only a missing
  // file is a first boot; a broken one (a hand edit gone wrong) must not
  // re-derive defaults from a legacy Telegram bot — that would switch the
  // agent back on and reset its owners. Fail closed: disabled, no owners.
  normalize: raw => {
    if (raw === null && existsSync(CONFIG_FILE)) {
      logError(`[agent] ${CONFIG_FILE} is not valid JSON — the agent stays disabled until it is fixed or saved again`);
      return normalizeAgentConfig({});
    }
    return normalizeAgentConfig(raw);
  },
});

export function loadAgentConfig(): AgentConfig {
  return store.get();
}

export function saveAgentConfig(next: AgentConfig): AgentConfig {
  return store.set(next);
}

/**
 * Deep-ish merge for PUT /agent/config: nested objects merge one level.
 * An unknown provider is refused with a 400 (nothing is saved, so the
 * previous one stays) instead of being swapped for the default silently;
 * `null` or '' resets it to the default.
 */
export function patchAgentConfig(patch: Partial<Record<keyof AgentConfig, unknown>>): AgentConfig {
  if ('provider' in patch && patch.provider != null) {
    const p = patch.provider;
    if (typeof p !== 'string') throw new HttpError(400, 'provider must be a string');
    const name = p.trim();
    if (name && !isKnownProvider(name)) {
      throw new HttpError(400, `Unknown provider ${JSON.stringify(name.slice(0, 64))}. Available: ${listProviders().join(', ')}`);
    }
  }
  return store.update(current => {
    const next: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      const cur = (current as unknown as Record<string, unknown>)[k];
      next[k] = cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object' && !Array.isArray(v)
        ? { ...(cur as object), ...(v as object) }
        : v;
    }
    return next as unknown as AgentConfig;
  });
}

export function reloadAgentConfig(): AgentConfig {
  return store.reload();
}

export function isAgentEnabled(): boolean {
  return loadAgentConfig().enabled;
}

/** Name of this machine as the agent describes where it runs. */
export function agentHostLabel(): string {
  try { return hostname(); } catch { return 'this machine'; }
}
