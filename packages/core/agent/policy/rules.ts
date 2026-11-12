/**
 * Rules engine: storage in `agent_rules`, validation, and matching.
 *
 * A rule matches a tool call when its tool glob, category and pattern all
 * match (a missing field matches anything). Among matches the lowest
 * priority number wins; ties go deny > ask > allow. Guardrails (see
 * defaults.ts) override any non-deny winner so a broad "allow Bash" can't
 * reopen `rm -rf ~`.
 *
 * Reads are cached in memory and the cache is dropped on every write, so the
 * bridge's per-tool-call evaluation never waits on SQLite.
 */

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { database } from '../../database';
import { agentRules, type AgentRuleRecord } from '../../database/schema';
import { logError } from '../../lib/logger';
import { HttpError } from '../http';
import { categoryKeys, isKnownServer, RULE_CATEGORIES, splitToolName, type Classification } from './classify';
import { DEFAULT_RULES, GUARDRAIL_PREFIX, type RuleDefinition } from './defaults';

export type RuleAction = 'allow' | 'ask' | 'deny';
export const RULE_ACTIONS: RuleAction[] = ['allow', 'ask', 'deny'];

export interface Rule extends AgentRuleRecord {
  action: RuleAction;
  guardrail: boolean;
}

export interface RuleMatch {
  action: RuleAction;
  rule: Rule | null;
  reason: string;
}

const ACTION_RANK: Record<RuleAction, number> = { deny: 0, ask: 1, allow: 2 };
const USER_PRIORITY_DEFAULT = 100;
const USER_PRIORITY_MAX = 999;
const MAX_PATTERN = 300;
/** Patterns are tested against at most this much text, which bounds any backtracking. */
const MAX_SUBJECT = 2000;

// ---------------------------------------------------------------------------
// Patterns and globs
// ---------------------------------------------------------------------------

/**
 * Error message for a pattern that is unsafe or invalid, or null when it's
 * fine. JavaScript regexes can't be interrupted, so the dangerous shapes —
 * nested quantifiers and backreferences, the usual catastrophic-backtracking
 * culprits — are rejected up front, and subjects are length-capped.
 */
export function patternProblem(p: string, maxLength = MAX_PATTERN): string | null {
  if (p.length > maxLength) return `Pattern is too long (max ${maxLength} characters)`;
  if (/\\[1-9]|\\k</.test(p)) return 'Backreferences are not supported in patterns';
  if (/\((?:[^()\\]|\\.)*[+*}]\)(?:[+*]|\{\d*,?\d*\})/.test(p)) return 'Nested quantifiers like (a+)+ are not allowed';
  try {
    new RegExp(p, 'i');
  } catch (err) {
    return `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function globToRegExp(glob: string): RegExp {
  const body = glob.split('').map(ch => (ch === '*' ? '.*' : ch === '?' ? '.' : escapeRegExp(ch))).join('');
  return new RegExp(`^${body}$`, 'i');
}

interface Compiled { key: string; globs: RegExp[] | null; pattern: RegExp | null; broken: boolean }
const compiled = new Map<string, Compiled>();

function compile(rule: AgentRuleRecord): Compiled {
  const key = `${rule.toolGlob}\u0000${rule.pattern ?? ''}`;
  const hit = compiled.get(rule.id);
  if (hit && hit.key === key) return hit;
  const globs = rule.toolGlob.split(',').map(g => g.trim()).filter(Boolean);
  let pattern: RegExp | null = null;
  let broken = false;
  if (rule.pattern) {
    try { pattern = new RegExp(rule.pattern, 'i'); } catch { broken = true; }
  }
  const out: Compiled = { key, globs: globs.length === 0 || globs.includes('*') ? null : globs.map(globToRegExp), pattern, broken };
  compiled.set(rule.id, out);
  return out;
}

export function ruleMatches(rule: AgentRuleRecord, toolName: string, cls: Classification): boolean {
  const c = compile(rule);
  if (c.broken) return false;
  if (c.globs) {
    const { server, bare } = splitToolName(toolName);
    // Defaults name Codiby's tools by bare name; the same name on another
    // MCP server (`mcp__x__phone_wipe`) is somebody else's tool. User rules
    // keep matching bare names anywhere — that's how owners write them.
    const bareMatches = rule.source !== 'default' || isKnownServer(server);
    if (!c.globs.some(g => (bareMatches && g.test(bare)) || g.test(toolName))) return false;
  }
  if (rule.category && !categoryKeys(cls).includes(rule.category)) return false;
  if (c.pattern) {
    const subjects = [cls.target ?? '', cls.summary].map(s => s.slice(0, MAX_SUBJECT));
    if (!subjects.some(s => c.pattern!.test(s))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

let cache: Rule[] | null = null;

const isGuardrail = (r: Pick<AgentRuleRecord, 'id' | 'source'>) => r.source === 'default' && r.id.startsWith(GUARDRAIL_PREFIX);

function toRule(r: AgentRuleRecord): Rule {
  const action = (RULE_ACTIONS as string[]).includes(r.action) ? (r.action as RuleAction) : 'ask';
  return { ...r, action, guardrail: isGuardrail(r) };
}

function fromDefinition(d: RuleDefinition, enabled = true, now = 0): Rule {
  return toRule({ ...d, source: 'default', enabled, createdAt: now, updatedAt: now });
}

export function sortRules<T extends Pick<Rule, 'priority' | 'action' | 'createdAt' | 'id'>>(rules: T[]): T[] {
  return [...rules].sort((a, b) =>
    a.priority - b.priority
    || ACTION_RANK[a.action] - ACTION_RANK[b.action]
    || a.createdAt - b.createdAt
    || a.id.localeCompare(b.id));
}

export function invalidateRules(): void {
  cache = null;
}

/**
 * Every rule, sorted by precedence. Defaults not yet seeded are included from
 * code, so evaluation is right even before the first start hook (and reading
 * never writes — the bridge's preview phase depends on that).
 */
export function listRules(): Rule[] {
  if (cache) return cache;
  let rows: AgentRuleRecord[] = [];
  try {
    rows = database.select().from(agentRules).all();
  } catch (err) {
    logError(`[agent] could not read policy rules, using defaults: ${err}`);
  }
  const byId = new Map(rows.map(r => [r.id, r]));
  const out: Rule[] = rows.filter(r => r.source !== 'default' || DEFAULT_RULES.some(d => d.id === r.id)).map(toRule);
  for (const d of DEFAULT_RULES) if (!byId.has(d.id)) out.push(fromDefinition(d));
  cache = sortRules(out);
  return cache;
}

export function getRule(id: string): Rule | null {
  return listRules().find(r => r.id === id) ?? null;
}

/**
 * Idempotent: inserts missing defaults, refreshes their definitions from code
 * (keeping the owner's enabled flag), and drops defaults that no longer exist.
 */
export function ensureDefaultRules(): void {
  const now = Date.now();
  const rows = database.select().from(agentRules).where(eq(agentRules.source, 'default')).all();
  const byId = new Map(rows.map(r => [r.id, r]));
  database.transaction(tx => {
    for (const d of DEFAULT_RULES) {
      const row = byId.get(d.id);
      if (!row) {
        tx.insert(agentRules).values({ ...d, source: 'default', enabled: true, createdAt: now, updatedAt: now }).onConflictDoNothing().run();
        continue;
      }
      const stale = row.priority !== d.priority || row.toolGlob !== d.toolGlob || row.pattern !== d.pattern
        || row.category !== d.category || row.action !== d.action || row.note !== d.note;
      if (stale) {
        tx.update(agentRules).set({ priority: d.priority, toolGlob: d.toolGlob, pattern: d.pattern, category: d.category, action: d.action, note: d.note, updatedAt: now })
          .where(eq(agentRules.id, d.id)).run();
      }
    }
    for (const row of rows) {
      if (!DEFAULT_RULES.some(d => d.id === row.id)) tx.delete(agentRules).where(eq(agentRules.id, row.id)).run();
    }
  });
  invalidateRules();
}

/** "Reset defaults": every default back to its definition and enabled. User rules are untouched. */
export function resetDefaultRules(): void {
  ensureDefaultRules();
  database.update(agentRules).set({ enabled: true, updatedAt: Date.now() }).where(eq(agentRules.source, 'default')).run();
  invalidateRules();
}

// ---------------------------------------------------------------------------
// User rules
// ---------------------------------------------------------------------------

export interface RuleInput {
  toolGlob?: unknown;
  pattern?: unknown;
  category?: unknown;
  action?: unknown;
  note?: unknown;
  priority?: unknown;
  enabled?: unknown;
}

const CATEGORY_VALUES = new Set(RULE_CATEGORIES.map(c => c.value));

function cleanFields(input: RuleInput, partial: boolean, opts: { generatedPattern?: boolean } = {}): Partial<AgentRuleRecord> {
  const out: Partial<AgentRuleRecord> = {};
  if (input.toolGlob !== undefined || !partial) {
    const glob = input.toolGlob === undefined || input.toolGlob === null || input.toolGlob === '' ? '*' : input.toolGlob;
    if (typeof glob !== 'string' || glob.length > 300 || !/^[\w*?\-,. ]+$/.test(glob)) {
      throw new HttpError(400, 'toolGlob must be tool names or globs like "Bash", "gmail_*", "mcp__server__*" (comma-separated)');
    }
    out.toolGlob = glob.split(',').map(g => g.trim()).filter(Boolean).join(',') || '*';
  }
  if (input.pattern !== undefined || !partial) {
    const p = input.pattern;
    if (p === undefined || p === null || p === '') out.pattern = null;
    else if (typeof p !== 'string') throw new HttpError(400, 'pattern must be a string');
    else {
      const problem = patternProblem(p, opts.generatedPattern ? 4000 : MAX_PATTERN);
      if (problem) throw new HttpError(400, problem);
      out.pattern = p;
    }
  }
  if (input.category !== undefined || !partial) {
    const c = input.category;
    if (c === undefined || c === null || c === '') out.category = null;
    else if (typeof c !== 'string' || !CATEGORY_VALUES.has(c)) throw new HttpError(400, `Unknown category "${String(c)}"`);
    else out.category = c;
  }
  if (input.action !== undefined || !partial) {
    if (typeof input.action !== 'string' || !(RULE_ACTIONS as string[]).includes(input.action)) throw new HttpError(400, 'action must be allow, ask or deny');
    out.action = input.action;
  }
  if (input.note !== undefined) {
    if (input.note !== null && typeof input.note !== 'string') throw new HttpError(400, 'note must be a string');
    out.note = input.note ? input.note.trim().slice(0, 300) || null : null;
  }
  if (input.priority !== undefined || !partial) {
    const n = input.priority === undefined || input.priority === null || input.priority === '' ? USER_PRIORITY_DEFAULT : Number(input.priority);
    if (!Number.isInteger(n) || n < 0 || n > USER_PRIORITY_MAX) throw new HttpError(400, `priority must be a whole number from 0 to ${USER_PRIORITY_MAX} (defaults use 1000+)`);
    out.priority = n;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
    out.enabled = input.enabled;
  }
  return out;
}

function assertNotWideOpen(r: Pick<AgentRuleRecord, 'action' | 'toolGlob' | 'pattern' | 'category'>) {
  if (r.action === 'allow' && (r.toolGlob === '*' || !r.toolGlob) && !r.pattern && !r.category) {
    throw new HttpError(400, 'An allow rule needs a tool, a category or a pattern — allowing everything is not supported');
  }
}

export function createRule(input: RuleInput, source: 'user' | 'always_allow' = 'user'): Rule {
  const fields = cleanFields(input, false, { generatedPattern: source === 'always_allow' });
  const now = Date.now();
  const row: AgentRuleRecord = {
    id: `${source === 'always_allow' ? 'always' : 'user'}:${randomUUID()}`,
    priority: fields.priority ?? USER_PRIORITY_DEFAULT,
    toolGlob: fields.toolGlob ?? '*',
    pattern: fields.pattern ?? null,
    category: fields.category ?? null,
    action: fields.action!,
    note: fields.note ?? null,
    source,
    enabled: fields.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
  assertNotWideOpen(row);
  database.insert(agentRules).values(row).run();
  invalidateRules();
  return toRule(row);
}

/** Defaults only toggle; user rules take any field. */
export function updateRule(id: string, input: RuleInput): Rule {
  const current = getRule(id);
  if (!current) throw new HttpError(404, 'Rule not found');
  if (current.source === 'default') {
    const keys = Object.keys(input).filter(k => (input as Record<string, unknown>)[k] !== undefined);
    if (keys.some(k => k !== 'enabled')) throw new HttpError(400, 'Default rules can only be enabled or disabled');
    if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
    ensureDefaultRules();
    database.update(agentRules).set({ enabled: input.enabled, updatedAt: Date.now() }).where(eq(agentRules.id, id)).run();
    invalidateRules();
    return getRule(id)!;
  }
  const fields = cleanFields(input, true, { generatedPattern: current.source === 'always_allow' });
  assertNotWideOpen({ ...current, ...fields });
  database.update(agentRules).set({ ...fields, updatedAt: Date.now() }).where(eq(agentRules.id, id)).run();
  invalidateRules();
  return getRule(id)!;
}

export function deleteRule(id: string): void {
  const current = getRule(id);
  if (!current) throw new HttpError(404, 'Rule not found');
  if (current.source === 'default') throw new HttpError(400, 'Default rules cannot be deleted — disable them instead');
  database.delete(agentRules).where(eq(agentRules.id, id)).run();
  compiled.delete(id);
  invalidateRules();
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export function describeRule(r: Pick<Rule, 'action' | 'toolGlob' | 'category' | 'pattern' | 'note'>): string {
  if (r.note) return r.note;
  const parts = [r.toolGlob !== '*' ? r.toolGlob : null, r.category, r.pattern ? `/${r.pattern}/` : null].filter(Boolean);
  return `${r.action} ${parts.join(' · ') || 'everything'}`;
}

export function decide(rules: Rule[], toolName: string, cls: Classification): RuleMatch {
  const matching = sortRules(rules.filter(r => r.enabled && ruleMatches(r, toolName, cls)));
  const winner = matching[0];
  if (!winner) return { action: 'ask', rule: null, reason: 'No rule matched — asking first' };
  if (winner.action !== 'deny') {
    const guard = matching.find(r => r.guardrail && r.action === 'deny');
    if (guard) return { action: 'deny', rule: guard, reason: describeRule(guard) };
  }
  return { action: winner.action, rule: winner, reason: describeRule(winner) };
}
