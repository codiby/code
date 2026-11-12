/**
 * Long-term memory over `agent_memory`, searched through the external-content
 * FTS5 table `agent_memory_fts` (kept in sync by triggers, database/memory-fts.ts).
 * A SQLite without FTS5 has no such table: searches and duplicate checks then
 * fall back to plain scans, so memory keeps working, just less cleverly.
 *
 * Raw SQL on `sqliteHandle` because drizzle can't express MATCH/bm25. Rows are
 * soft-deleted (`deleted_at`) so a mistaken `forget` can be undone by hand;
 * the FTS index keeps them, and every query joins back to filter them out.
 */

import { randomUUID } from 'crypto';
import { sqliteHandle } from '../../database';
import { log, logError } from '../../lib/logger';
import { MemoryError } from './errors';
import { VAULT_HINT, detectSecret } from './secrets';
import { buildFtsAllTerms, buildFtsQuery, dedupKey, escapeLike, wordTokens } from './text';

export const MEMORY_KINDS = ['profile', 'preference', 'person', 'fact', 'note', 'task'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  content: string;
  tags: string[];
  /** Who saved it: 'agent' (a tool call) or 'owner' (the Agent view). */
  source: string | null;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface MemoryInput {
  content: unknown;
  kind?: unknown;
  tags?: unknown;
  pinned?: unknown;
  source?: string;
}

export interface MemoryPatch {
  content?: unknown;
  kind?: unknown;
  tags?: unknown;
  pinned?: unknown;
}

export const MAX_MEMORY_LENGTH = 2000;
const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 40;
/** Distinct words used to find duplicate candidates; the exact key check runs on the rows found. */
const DEDUP_TERMS = 24;
const DEFAULT_KIND: MemoryKind = 'fact';

interface MemoryRow {
  id: string;
  kind: string;
  content: string;
  tags: string;
  source: string | null;
  pinned: number;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

const COLUMNS = 'm.id, m.kind, m.content, m.tags, m.source, m.pinned, m.created_at, m.updated_at, m.last_used_at';
const LIVE = 'm.deleted_at IS NULL';

function isKind(v: unknown): v is MemoryKind {
  return typeof v === 'string' && (MEMORY_KINDS as readonly string[]).includes(v);
}

function toItem(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    kind: isKind(row.kind) ? row.kind : 'note',
    content: row.content,
    tags: row.tags ? row.tags.split(' ').filter(Boolean) : [],
    source: row.source,
    pinned: !!row.pinned,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function parseKind(v: unknown): MemoryKind {
  if (isKind(v)) return v;
  throw new MemoryError('invalid', `kind must be one of: ${MEMORY_KINDS.join(', ')}`);
}

/** Trimmed text with tidy whitespace (single spaces, at most one blank line). */
export function cleanContent(v: unknown): string {
  if (typeof v !== 'string') throw new MemoryError('invalid', 'content must be a string');
  const content = v
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!content) throw new MemoryError('invalid', 'content is empty');
  if (content.length > MAX_MEMORY_LENGTH) {
    throw new MemoryError('invalid', `content is too long (${content.length} characters, max ${MAX_MEMORY_LENGTH}) — save the key fact, or keep long material in a file in the workspace`);
  }
  const secret = detectSecret(content);
  if (secret) throw new MemoryError('secret', `Not saved: ${secret}. ${VAULT_HINT}`);
  return content;
}

/** Tags from an array or a comma/space separated string: lowercase words, deduplicated. */
export function normalizeTags(v: unknown): string[] {
  if (v === undefined || v === null || v === '') return [];
  const parts = typeof v === 'string' ? v.split(/[\s,]+/) : Array.isArray(v) ? v : null;
  if (!parts) throw new MemoryError('invalid', 'tags must be a list of words');
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p !== 'string') throw new MemoryError('invalid', 'tags must be strings');
    const tag = p.trim().toLowerCase().replace(/^#+/, '').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, MAX_TAG_LENGTH);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  if (out.length > MAX_TAGS) throw new MemoryError('invalid', `at most ${MAX_TAGS} tags`);
  return out;
}

function parsePinned(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new MemoryError('invalid', 'pinned must be true or false');
  return v;
}

// ---------------------------------------------------------------------------
// Index health
// ---------------------------------------------------------------------------

let indexChecked = false;
let ftsFailureLogged = false;

/**
 * A query against the index failed. Without FTS5 (database/memory-fts.ts
 * already said so at boot) every search and every save would fail the same
 * way, so this is logged once until the index works again — not per query.
 */
function ftsFailed(what: string, err: unknown): void {
  if (ftsFailureLogged) return;
  ftsFailureLogged = true;
  logError(`[agent:memory] ${what} failed (${err instanceof Error ? err.message : err}) — using plain text matching until the search index works again`);
}

function ftsWorked(): void {
  ftsFailureLogged = false;
}

/**
 * The FTS table maps hits to memories by implicit rowid, which a VACUUM (or a
 * hand edit with triggers off) can renumber — after that, searches would
 * silently return the wrong rows. Check once per process and rebuild if so.
 */
function ensureIndex(): void {
  if (indexChecked) return;
  indexChecked = true;
  try {
    sqliteHandle.exec(`INSERT INTO agent_memory_fts(agent_memory_fts, rank) VALUES('integrity-check', 1)`);
  } catch {
    try {
      sqliteHandle.exec(`INSERT INTO agent_memory_fts(agent_memory_fts) VALUES('rebuild')`);
      log('[agent:memory] Search index was out of sync with agent_memory — rebuilt it');
    } catch (err) {
      ftsFailed('Rebuilding the search index', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getMemory(id: string): MemoryItem | null {
  const row = sqliteHandle.query(`SELECT ${COLUMNS} FROM agent_memory m WHERE m.id = ? AND ${LIVE}`).get(id) as MemoryRow | null;
  return row ? toItem(row) : null;
}

function requireMemory(id: unknown): MemoryItem {
  if (typeof id !== 'string' || !id.trim()) throw new MemoryError('invalid', 'id is required');
  const item = getMemory(id.trim());
  if (!item) throw new MemoryError('not_found', `No memory with id ${id}`);
  return item;
}

export interface ListOptions {
  kind?: MemoryKind;
  pinned?: boolean;
  limit?: number;
  offset?: number;
}

/** Newest first, pinned on top. */
export function listMemories(opts: ListOptions = {}): { items: MemoryItem[]; total: number } {
  const where = [LIVE];
  const params: (string | number)[] = [];
  if (opts.kind) { where.push('m.kind = ?'); params.push(opts.kind); }
  if (opts.pinned !== undefined) { where.push('m.pinned = ?'); params.push(opts.pinned ? 1 : 0); }
  const clause = where.join(' AND ');
  const limit = clampInt(opts.limit, 1, 500, 50);
  const offset = clampInt(opts.offset, 0, 1_000_000, 0);
  const rows = sqliteHandle
    .query(`SELECT ${COLUMNS} FROM agent_memory m WHERE ${clause} ORDER BY m.pinned DESC, m.updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as MemoryRow[];
  const total = (sqliteHandle.query(`SELECT COUNT(*) AS n FROM agent_memory m WHERE ${clause}`).get(...params) as { n: number }).n;
  return { items: rows.map(toItem), total };
}

export function countMemoriesByKind(): Record<MemoryKind, number> & { total: number } {
  const counts = Object.fromEntries(MEMORY_KINDS.map(k => [k, 0])) as Record<MemoryKind, number>;
  let total = 0;
  const rows = sqliteHandle.query(`SELECT m.kind AS kind, COUNT(*) AS n FROM agent_memory m WHERE ${LIVE} GROUP BY m.kind`).all() as { kind: string; n: number }[];
  for (const r of rows) {
    total += r.n;
    if (isKind(r.kind)) counts[r.kind] += r.n;
  }
  return { ...counts, total };
}

export interface SearchOptions {
  query: string;
  kind?: MemoryKind;
  limit?: number;
  /** Record the hits as used (recall does; browsing in the UI doesn't). */
  touch?: boolean;
}

/**
 * Full-text search: every word is a quoted prefix term OR-ed together and
 * ranked by bm25, so "cafe" finds "café de olla" and a query can't inject FTS
 * syntax. Queries without searchable words (emoji, punctuation) fall back to a
 * LIKE scan; an empty query lists the newest memories.
 */
export function searchMemories(opts: SearchOptions): MemoryItem[] {
  ensureIndex();
  const limit = clampInt(opts.limit, 1, 200, 10);
  const raw = (opts.query ?? '').trim();
  let items: MemoryItem[];
  if (!raw) {
    items = listMemories({ kind: opts.kind, limit }).items;
  } else {
    const expr = buildFtsQuery(raw);
    items = expr ? ftsSearch(expr, opts.kind, limit) ?? likeSearch(raw, opts.kind, limit) : likeSearch(raw, opts.kind, limit);
  }
  if (opts.touch && items.length) touchMemories(items.map(i => i.id));
  return items;
}

function ftsSearch(expr: string, kind: MemoryKind | undefined, limit: number): MemoryItem[] | null {
  try {
    // Tags weigh a little less than the text itself; pinned breaks ties.
    const rows = sqliteHandle.query(
      `SELECT ${COLUMNS} FROM agent_memory_fts f JOIN agent_memory m ON m.rowid = f.rowid
       WHERE agent_memory_fts MATCH ? AND ${LIVE} ${kind ? 'AND m.kind = ?' : ''}
       ORDER BY bm25(agent_memory_fts, 1.0, 0.6), m.pinned DESC, m.updated_at DESC
       LIMIT ?`,
    ).all(...(kind ? [expr, kind, limit] : [expr, limit])) as MemoryRow[];
    ftsWorked();
    return rows.map(toItem);
  } catch (err) {
    // The query builder only emits quoted alphanumeric terms, so this is a
    // broken or missing index rather than bad input: degrade to LIKE instead of failing recall.
    ftsFailed('Memory search', err);
    return null;
  }
}

function likeSearch(raw: string, kind: MemoryKind | undefined, limit: number): MemoryItem[] {
  const pattern = `%${escapeLike(raw.slice(0, 200))}%`;
  const rows = sqliteHandle.query(
    `SELECT ${COLUMNS} FROM agent_memory m
     WHERE ${LIVE} AND (m.content LIKE ? ESCAPE '\\' OR m.tags LIKE ? ESCAPE '\\') ${kind ? 'AND m.kind = ?' : ''}
     ORDER BY m.pinned DESC, m.updated_at DESC LIMIT ?`,
  ).all(...(kind ? [pattern, pattern, kind, limit] : [pattern, pattern, limit])) as MemoryRow[];
  return rows.map(toItem);
}

function touchMemories(ids: string[]): void {
  const now = Date.now();
  const stmt = sqliteHandle.query('UPDATE agent_memory SET last_used_at = ? WHERE id = ?');
  sqliteHandle.transaction(() => { for (const id of ids) stmt.run(now, id); })();
}

/**
 * A live memory that says the same thing as `content` (same text once case,
 * accents, spacing and surrounding punctuation are ignored), if any.
 */
export function findDuplicate(content: string, excludeId?: string): MemoryItem | null {
  ensureIndex();
  const key = dedupKey(content);
  const terms = [...new Set(wordTokens(content))].slice(0, DEDUP_TERMS);
  const expr = buildFtsAllTerms(terms);
  // No words at all (an emoji note), or no usable index: the table is small
  // enough to scan, and the exact key check below is what decides anyway.
  const candidates = expr ? ftsCandidates(expr) : null;
  const rows = candidates ?? (sqliteHandle.query(`SELECT ${COLUMNS} FROM agent_memory m WHERE ${LIVE}`).all() as MemoryRow[]);
  const hit = rows.find(r => r.id !== excludeId && dedupKey(r.content) === key);
  return hit ? toItem(hit) : null;
}

/** Live memories holding every term, or null when the index can't be queried (remember must still save). */
function ftsCandidates(expr: string): MemoryRow[] | null {
  try {
    const rows = sqliteHandle.query(
      `SELECT ${COLUMNS} FROM agent_memory_fts f JOIN agent_memory m ON m.rowid = f.rowid
       WHERE agent_memory_fts MATCH ? AND ${LIVE} LIMIT 200`,
    ).all(expr) as MemoryRow[];
    ftsWorked();
    return rows;
  } catch (err) {
    ftsFailed('Looking for a duplicate memory', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface AddResult {
  item: MemoryItem;
  /** False when an existing memory already said this; it was merged instead. */
  created: boolean;
}

/**
 * Save a memory. An exact duplicate isn't stored twice: its tags are merged,
 * a pin sticks, and an explicitly given kind wins (the newest classification).
 */
export function addMemory(input: MemoryInput): AddResult {
  const content = cleanContent(input.content);
  const kind = input.kind === undefined || input.kind === null || input.kind === '' ? null : parseKind(input.kind);
  const tags = normalizeTags(input.tags);
  const pinned = parsePinned(input.pinned);
  const now = Date.now();

  const dup = findDuplicate(content);
  if (dup) {
    const mergedTags = [...new Set([...dup.tags, ...tags])].slice(0, MAX_TAGS);
    sqliteHandle.query('UPDATE agent_memory SET kind = ?, tags = ?, pinned = ?, updated_at = ? WHERE id = ?').run(
      kind ?? dup.kind, mergedTags.join(' '), dup.pinned || pinned === true ? 1 : 0, now, dup.id,
    );
    return { item: getMemory(dup.id)!, created: false };
  }

  const id = randomUUID();
  sqliteHandle.query(
    `INSERT INTO agent_memory (id, kind, content, tags, source, pinned, created_at, updated_at, last_used_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(id, kind ?? DEFAULT_KIND, content, tags.join(' '), input.source ?? null, pinned ? 1 : 0, now, now);
  return { item: getMemory(id)!, created: true };
}

export function updateMemory(id: unknown, patch: MemoryPatch): MemoryItem {
  const current = requireMemory(id);
  const next = {
    content: patch.content === undefined ? current.content : cleanContent(patch.content),
    kind: patch.kind === undefined ? current.kind : parseKind(patch.kind),
    tags: patch.tags === undefined ? current.tags : normalizeTags(patch.tags),
    pinned: parsePinned(patch.pinned) ?? current.pinned,
  };
  if (next.content !== current.content) {
    const dup = findDuplicate(next.content, current.id);
    if (dup) throw new MemoryError('conflict', `Another memory already says this (id ${dup.id})`);
  }
  sqliteHandle.query('UPDATE agent_memory SET content = ?, kind = ?, tags = ?, pinned = ?, updated_at = ? WHERE id = ?').run(
    next.content, next.kind, next.tags.join(' '), next.pinned ? 1 : 0, Date.now(), current.id,
  );
  return getMemory(current.id)!;
}

/** Soft delete. Returns what was forgotten. */
export function forgetMemory(id: unknown): MemoryItem {
  const item = requireMemory(id);
  const now = Date.now();
  sqliteHandle.query('UPDATE agent_memory SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, item.id);
  return item;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export function profileFacts(): MemoryItem[] {
  const rows = sqliteHandle.query(`SELECT ${COLUMNS} FROM agent_memory m WHERE ${LIVE} AND m.kind = 'profile' ORDER BY m.created_at ASC`).all() as MemoryRow[];
  return rows.map(toItem);
}

export interface ProfileUpdate {
  facts: unknown;
  /** Ids of profile facts that are no longer true. */
  remove?: unknown;
  /** The given facts become the whole profile; every other profile fact is retired. */
  replace?: unknown;
  source?: string;
}

export interface ProfileUpdateResult {
  added: number;
  alreadyKnown: number;
  removed: number;
  profile: MemoryItem[];
}

export function updateProfile(update: ProfileUpdate): ProfileUpdateResult {
  const facts = update.facts === undefined ? [] : update.facts;
  if (!Array.isArray(facts) || facts.some(f => typeof f !== 'string')) throw new MemoryError('invalid', 'facts must be a list of strings');
  const remove = update.remove === undefined ? [] : update.remove;
  if (!Array.isArray(remove) || remove.some(r => typeof r !== 'string')) throw new MemoryError('invalid', 'remove must be a list of memory ids');
  if (update.replace !== undefined && typeof update.replace !== 'boolean') throw new MemoryError('invalid', 'replace must be true or false');
  if (!facts.length && !remove.length && update.replace !== true) throw new MemoryError('invalid', 'give at least one fact (or ids to remove)');
  // Validate everything before writing anything, so one bad fact doesn't leave half an update.
  const cleaned = (facts as string[]).map(cleanContent);
  const removeIds = remove as string[];
  for (const id of removeIds) {
    const item = requireMemory(id);
    if (item.kind !== 'profile') throw new MemoryError('invalid', `${id} is a ${item.kind} memory, not a profile fact — use forget`);
  }

  let added = 0;
  let alreadyKnown = 0;
  let removed = 0;
  sqliteHandle.transaction(() => {
    const keep = new Set<string>();
    for (const content of cleaned) {
      const res = addMemory({ content, kind: 'profile', source: update.source });
      keep.add(res.item.id);
      if (res.created) added++; else alreadyKnown++;
    }
    const retire = new Set(removeIds);
    if (update.replace === true) {
      for (const fact of profileFacts()) if (!keep.has(fact.id)) retire.add(fact.id);
    }
    for (const id of retire) {
      if (keep.has(id)) continue;
      forgetMemory(id);
      removed++;
    }
  })();
  return { added, alreadyKnown, removed, profile: profileFacts() };
}

// ---------------------------------------------------------------------------
// Prompt material
// ---------------------------------------------------------------------------

/** Memories created, edited or forgotten at or after `since` (what a consolidation turn wrote). */
export function countMemoryChangesSince(since: number): number {
  return (sqliteHandle.query('SELECT COUNT(*) AS n FROM agent_memory WHERE updated_at >= ?').get(since) as { n: number }).n;
}

/** When a memory was last relevant: used by recall, or edited. */
export function lastTouchedAt(item: MemoryItem): number {
  return Math.max(item.lastUsedAt ?? 0, item.updatedAt);
}

/** What the prompt section shows: the profile, everything pinned, and recently used preferences. */
export function promptMemories(recentPreferences = 15): { profile: MemoryItem[]; pinned: MemoryItem[]; preferences: MemoryItem[] } {
  const profile = profileFacts();
  const pinned = (sqliteHandle.query(
    `SELECT ${COLUMNS} FROM agent_memory m WHERE ${LIVE} AND m.pinned = 1 AND m.kind != 'profile'
     ORDER BY MAX(COALESCE(m.last_used_at, 0), m.updated_at) DESC`,
  ).all() as MemoryRow[]).map(toItem);
  const preferences = (sqliteHandle.query(
    `SELECT ${COLUMNS} FROM agent_memory m WHERE ${LIVE} AND m.pinned = 0 AND m.kind = 'preference'
     ORDER BY MAX(COALESCE(m.last_used_at, 0), m.updated_at) DESC LIMIT ?`,
  ).all(recentPreferences) as MemoryRow[]).map(toItem);
  return { profile, pinned, preferences };
}

/** Integer from a number or numeric string, clamped to [min, max]; `fallback` when missing or garbage. */
export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Tests only: forget that the index was checked (and that its failure was logged). */
export function _resetMemoryIndexCheck(): void {
  indexChecked = false;
  ftsFailureLogged = false;
}
