/**
 * People directory over `agent_people`: who the owner talks about, the names
 * they use for them ("esposita"), and how to reach them on each channel.
 *
 * The table is small (a personal address book), so lookups load the live rows
 * and score them in JS — that keeps accent/case folding identical to memory
 * search without an FTS table of its own.
 */

import { randomUUID } from 'crypto';
import { sqliteHandle } from '../../database';
import { MemoryError } from './errors';
import { VAULT_HINT, detectSecret } from './secrets';
import { normalizePhone, normalizeWhatsAppHandle, phoneTail } from './phone';
import { foldText, wordTokens } from './text';

export const HANDLE_CHANNELS = ['whatsapp', 'telegram', 'email', 'phone'] as const;
export type HandleChannel = (typeof HANDLE_CHANNELS)[number];
export type PersonHandles = Partial<Record<HandleChannel, string[]>>;

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
  name?: unknown;
  aliases?: unknown;
  relation?: unknown;
  handles?: unknown;
  notes?: unknown;
}

const MAX_NAME = 120;
const MAX_ALIASES = 20;
const MAX_HANDLES_PER_CHANNEL = 10;
const MAX_NOTES = 2000;
const MAX_RELATION = 80;

interface PersonRow {
  id: string;
  name: string;
  aliases: string;
  relation: string | null;
  handles: string;
  notes: string;
  created_at: number;
  updated_at: number;
}

const COLUMNS = 'id, name, aliases, relation, handles, notes, created_at, updated_at';

function parseStoredHandles(raw: string): PersonHandles {
  let parsed: unknown;
  try { parsed = JSON.parse(raw || '{}'); } catch { return {}; }
  const out: PersonHandles = {};
  if (!parsed || typeof parsed !== 'object') return out;
  for (const ch of HANDLE_CHANNELS) {
    const list = (parsed as Record<string, unknown>)[ch];
    if (Array.isArray(list)) {
      const clean = list.filter((x): x is string => typeof x === 'string' && !!x.trim());
      if (clean.length) out[ch] = clean;
    }
  }
  return out;
}

function toPerson(row: PersonRow): Person {
  return {
    id: row.id,
    name: row.name,
    aliases: splitAliases(row.aliases),
    relation: row.relation || null,
    handles: parseStoredHandles(row.handles),
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function splitAliases(s: string): string[] {
  return s.split(',').map(a => a.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function oneLineText(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string') throw new MemoryError('invalid', `${field} must be a string`);
  const s = v.replace(/\s+/g, ' ').trim();
  if (s.length > max) throw new MemoryError('invalid', `${field} is too long (max ${max} characters)`);
  return s;
}

function parseName(v: unknown): string {
  const name = oneLineText(v, 'name', MAX_NAME);
  if (!name) throw new MemoryError('invalid', 'name is required');
  return name;
}

/** Aliases from a list or a comma-separated string; commas can't live inside one (the column is comma-separated). */
export function parseAliases(v: unknown, name?: string): string[] {
  if (v === undefined || v === null || v === '') return [];
  const parts = typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v : null;
  if (!parts) throw new MemoryError('invalid', 'aliases must be a list of names');
  const seen = new Set<string>(name ? [foldText(name)] : []);
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p !== 'string') throw new MemoryError('invalid', 'aliases must be strings');
    const alias = p.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    const key = foldText(alias);
    if (!alias || seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  if (out.length > MAX_ALIASES) throw new MemoryError('invalid', `at most ${MAX_ALIASES} aliases`);
  return out;
}

function parseRelation(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return oneLineText(v, 'relation', MAX_RELATION) || null;
}

function parseNotes(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new MemoryError('invalid', 'notes must be a string');
  const notes = v.replace(/\r\n?/g, '\n').trim();
  if (notes.length > MAX_NOTES) throw new MemoryError('invalid', `notes are too long (max ${MAX_NOTES} characters)`);
  const secret = detectSecret(notes);
  if (secret) throw new MemoryError('secret', `Not saved: the notes ${secret.replace(/^it /, '')}. ${VAULT_HINT}`);
  return notes;
}

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;
const TELEGRAM_ID = /^-?\d{3,20}$/;
const TELEGRAM_USER = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/;

/** One handle in its canonical form, or a MemoryError explaining what's wrong with it. */
export function normalizeHandle(channel: HandleChannel, value: string): string {
  const v = value.trim();
  switch (channel) {
    case 'whatsapp': {
      const jid = normalizeWhatsAppHandle(v);
      if (!jid) throw new MemoryError('invalid', `"${v}" is not a WhatsApp number or JID`);
      return jid;
    }
    case 'phone': {
      const phone = normalizePhone(v);
      if (!phone) throw new MemoryError('invalid', `"${v}" is not a phone number`);
      return phone;
    }
    case 'email': {
      const email = v.replace(/^mailto:/i, '').toLowerCase();
      if (!EMAIL.test(email) || email.length > 254) throw new MemoryError('invalid', `"${v}" is not an email address`);
      return email;
    }
    case 'telegram': {
      if (TELEGRAM_ID.test(v)) return v;
      const user = TELEGRAM_USER.exec(v.replace(/^https?:\/\/t\.me\//i, ''));
      if (!user) throw new MemoryError('invalid', `"${v}" is not a Telegram chat id or @username`);
      return `@${user[1]!.toLowerCase()}`;
    }
  }
}

/** Handles keyed by channel; each list accepts an array or a comma/newline separated string. */
export function normalizeHandles(v: unknown): PersonHandles {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new MemoryError('invalid', 'handles must be an object like {"whatsapp": ["6671234567"]}');
  const out: PersonHandles = {};
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!(HANDLE_CHANNELS as readonly string[]).includes(key)) {
      throw new MemoryError('invalid', `unknown handle channel "${key}" (use ${HANDLE_CHANNELS.join(', ')})`);
    }
    const channel = key as HandleChannel;
    const parts = typeof raw === 'string' ? raw.split(/[,\n]/) : Array.isArray(raw) ? raw : raw == null ? [] : null;
    if (!parts) throw new MemoryError('invalid', `handles.${channel} must be a list`);
    const list: string[] = [];
    for (const p of parts) {
      if (typeof p !== 'string') throw new MemoryError('invalid', `handles.${channel} must contain strings`);
      if (!p.trim()) continue;
      const h = normalizeHandle(channel, p);
      if (!list.includes(h)) list.push(h);
    }
    if (list.length > MAX_HANDLES_PER_CHANNEL) throw new MemoryError('invalid', `at most ${MAX_HANDLES_PER_CHANNEL} ${channel} handles`);
    if (list.length) out[channel] = list;
  }
  return out;
}

function mergeHandles(a: PersonHandles, b: PersonHandles): PersonHandles {
  const out: PersonHandles = {};
  for (const ch of HANDLE_CHANNELS) {
    const list = [...new Set([...(a[ch] ?? []), ...(b[ch] ?? [])])].slice(0, MAX_HANDLES_PER_CHANNEL);
    if (list.length) out[ch] = list;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function livePeople(): Person[] {
  const rows = sqliteHandle.query(`SELECT ${COLUMNS} FROM agent_people WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE ASC`).all() as PersonRow[];
  return rows.map(toPerson);
}

export function listPeople(): Person[] {
  return livePeople();
}

export function getPerson(id: string): Person | null {
  const row = sqliteHandle.query(`SELECT ${COLUMNS} FROM agent_people WHERE id = ? AND deleted_at IS NULL`).get(id) as PersonRow | null;
  return row ? toPerson(row) : null;
}

function requirePerson(id: unknown): Person {
  if (typeof id !== 'string' || !id.trim()) throw new MemoryError('invalid', 'id is required');
  const p = getPerson(id.trim());
  if (!p) throw new MemoryError('not_found', `No person with id ${id}`);
  return p;
}

/**
 * How well `person` matches the folded query. Names and aliases count most,
 * then handles (a pasted number or address), relation ("esposa"), and notes.
 */
function scorePerson(person: Person, q: string, qTokens: string[], qDigits: string): number {
  const names = [person.name, ...person.aliases].map(foldText);
  let score = 0;
  const bump = (n: number) => { if (n > score) score = n; };

  for (const n of names) {
    if (n === q) bump(100);
    else if (n.startsWith(q)) bump(75);
    else if (n.split(' ').some(w => w.startsWith(q))) bump(70);
    else if (q.length >= 3 && n.includes(q)) bump(45);
  }
  // "ana lopez" against "Ana María López": every query word starts some name word.
  if (qTokens.length > 1) {
    const words = new Set(names.flatMap(n => wordTokens(n)));
    if (qTokens.every(t => [...words].some(w => w.startsWith(t)))) bump(65);
  }
  if (qDigits.length >= 7) {
    const tail = phoneTail(qDigits);
    const numbers = [...(person.handles.whatsapp ?? []), ...(person.handles.phone ?? [])];
    if (numbers.some(h => phoneTail(h) === tail || phoneTail(h).endsWith(tail))) bump(90);
  }
  const textHandles = [...(person.handles.email ?? []), ...(person.handles.telegram ?? [])].map(h => h.toLowerCase());
  const qRaw = q.replace(/^@/, '');
  if (textHandles.some(h => h === q || h.replace(/^@/, '') === qRaw)) bump(90);
  else if (q.length >= 3 && textHandles.some(h => h.includes(qRaw))) bump(40);

  if (person.relation) {
    const rel = foldText(person.relation);
    if (rel === q) bump(60);
    else if (q.length >= 3 && (rel.includes(q) || qTokens.some(t => t.length >= 3 && wordTokens(rel).includes(t)))) bump(35);
  }
  if (q.length >= 3 && foldText(person.notes).includes(q)) bump(15);
  return score;
}

/** People matching a name, alias, relation, handle or note — best match first. */
export function findPeople(query: string, limit = 10): Person[] {
  const q = foldText(query ?? '');
  if (!q) return [];
  const qTokens = wordTokens(q);
  const qDigits = /^[\d\s()+.-]+$/.test(query.trim()) ? query.replace(/\D/g, '') : '';
  return livePeople()
    .map(p => ({ p, s: scorePerson(p, q, qTokens, qDigits) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || a.p.name.localeCompare(b.p.name))
    .slice(0, Math.max(1, Math.min(50, limit)))
    .map(x => x.p);
}

/**
 * The person who owns a channel handle (a WhatsApp sender, an email From) —
 * channels use it to put a name on a message from someone the owner knows.
 */
export function findPersonByHandle(channel: HandleChannel, value: string): Person | null {
  let canonical: string;
  try { canonical = normalizeHandle(channel, value); } catch { return null; }
  const numeric = channel === 'whatsapp' || channel === 'phone';
  const tail = numeric ? phoneTail(canonical) : '';
  for (const p of livePeople()) {
    const lists = numeric ? [...(p.handles.whatsapp ?? []), ...(p.handles.phone ?? [])] : (p.handles[channel] ?? []);
    if (lists.some(h => h === canonical || (numeric && tail.length >= 10 && phoneTail(h) === tail))) return p;
  }
  return null;
}

export function countPeopleChangesSince(since: number): number {
  return (sqliteHandle.query('SELECT COUNT(*) AS n FROM agent_people WHERE updated_at >= ?').get(since) as { n: number }).n;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function writePerson(p: Omit<Person, 'createdAt' | 'updatedAt'>, createdAt: number | null): Person {
  const now = Date.now();
  const handles = JSON.stringify(p.handles);
  if (createdAt === null) {
    sqliteHandle.query(
      `INSERT INTO agent_people (id, name, aliases, relation, handles, notes, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(p.id, p.name, p.aliases.join(', '), p.relation, handles, p.notes, now, now);
  } else {
    sqliteHandle.query('UPDATE agent_people SET name = ?, aliases = ?, relation = ?, handles = ?, notes = ?, updated_at = ? WHERE id = ?')
      .run(p.name, p.aliases.join(', '), p.relation, handles, p.notes, now, p.id);
  }
  return getPerson(p.id)!;
}

export function createPerson(input: PersonInput): Person {
  const name = parseName(input.name);
  return writePerson({
    id: randomUUID(),
    name,
    aliases: parseAliases(input.aliases, name),
    relation: parseRelation(input.relation),
    handles: normalizeHandles(input.handles),
    notes: parseNotes(input.notes),
  }, null);
}

/**
 * 'replace' (the Agent view's editor): every given field overwrites.
 * 'merge' (the agent's tools): aliases and handles are added to what's there,
 * so a call that only knows a new number can't wipe the others.
 */
export function updatePerson(id: unknown, patch: PersonInput, mode: 'replace' | 'merge' = 'replace'): Person {
  const cur = requirePerson(id);
  const name = patch.name === undefined ? cur.name : parseName(patch.name);
  const aliases = patch.aliases === undefined ? cur.aliases.filter(a => foldText(a) !== foldText(name)) : parseAliases(patch.aliases, name);
  const handles = patch.handles === undefined ? cur.handles : normalizeHandles(patch.handles);
  return writePerson({
    id: cur.id,
    name,
    aliases: mode === 'merge' && patch.aliases !== undefined ? parseAliases([...cur.aliases, ...aliases], name) : aliases,
    relation: patch.relation === undefined ? cur.relation : parseRelation(patch.relation),
    handles: mode === 'merge' && patch.handles !== undefined ? mergeHandles(cur.handles, handles) : handles,
    notes: patch.notes === undefined ? cur.notes : parseNotes(patch.notes),
  }, cur.createdAt);
}

export interface UpsertResult {
  person: Person;
  created: boolean;
}

/**
 * The agent's people_upsert: by id when given, otherwise by exact name or
 * alias (accent/case-insensitive). Two people sharing that name is ambiguous —
 * the caller has to pick one by id rather than have us guess.
 */
export function upsertPerson(input: PersonInput & { id?: unknown }, opts: { replace?: boolean } = {}): UpsertResult {
  const mode = opts.replace ? 'replace' : 'merge';
  if (input.id !== undefined && input.id !== null && input.id !== '') {
    return { person: updatePerson(input.id, input, mode), created: false };
  }
  const name = parseName(input.name);
  const key = foldText(name);
  const same = livePeople().filter(p => foldText(p.name) === key || p.aliases.some(a => foldText(a) === key));
  if (same.length > 1) {
    throw new MemoryError('conflict', `Several people are called "${name}" (${same.map(p => `${p.name}: ${p.id}`).join('; ')}) — pass the id of the one you mean`);
  }
  if (same.length === 1) {
    const existing = same[0]!;
    // Matched through an alias: keep their real name and record what was typed as an alias.
    const patch: PersonInput = foldText(existing.name) === key ? { ...input, name: undefined } : { ...input, name: undefined, aliases: [...parseAliases(input.aliases), name] };
    return { person: updatePerson(existing.id, patch, mode), created: false };
  }
  return { person: createPerson(input), created: true };
}

export function deletePerson(id: unknown): Person {
  const p = requirePerson(id);
  const now = Date.now();
  sqliteHandle.query('UPDATE agent_people SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, p.id);
  return p;
}
