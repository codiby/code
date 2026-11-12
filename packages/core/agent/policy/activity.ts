/**
 * Activity log — one `agent_activity` row per tool call the agent makes, and
 * how it was decided.
 *
 * A call reaches us twice: once when the model emits it (onAgentToolUse) and,
 * unless the provider allowed it natively, again as a permission decision.
 * Both are folded into one row. Claude uses the tool-use id as the request
 * id, so the two match exactly; other providers mint their own request ids,
 * so their calls are paired first-in-first-out by tool name.
 */

import { randomUUID } from 'crypto';
import { and, desc, eq, like, lt, or } from 'drizzle-orm';
import { database } from '../../database';
import { agentActivity, type AgentActivityRecord } from '../../database/schema';
import { logError } from '../../lib/logger';
import type { Classification } from './classify';
import { redactText, sanitizeInput, truncate } from './redact';
import type { RuleMatch } from './rules';

export const ACTIVITY_DECISIONS = ['auto_allowed', 'asked', 'approved', 'denied', 'blocked', 'expired'] as const;
export type ActivityDecision = typeof ACTIVITY_DECISIONS[number];

const MATCH_WINDOW_MS = 30 * 60_000;
const MAX_TRACKS = 300;
const DAY_MS = 86_400_000;

interface Track {
  rowId: string;
  toolName: string;
  /** Tool-use id (from the transcript) and/or permission request id. */
  ids: Set<string>;
  at: number;
  sawUse: boolean;
  decided: boolean;
}

const tracks: Track[] = [];

function remember(t: Track) {
  tracks.push(t);
  const cutoff = Date.now() - MATCH_WINDOW_MS;
  while (tracks.length > MAX_TRACKS || (tracks[0] && tracks[0].at < cutoff)) tracks.shift();
}

function findById(id: string | undefined): Track | undefined {
  if (!id) return undefined;
  for (let i = tracks.length - 1; i >= 0; i--) if (tracks[i]!.ids.has(id)) return tracks[i];
  return undefined;
}

function oldest(pred: (t: Track) => boolean): Track | undefined {
  const cutoff = Date.now() - MATCH_WINDOW_MS;
  return tracks.find(t => t.at >= cutoff && pred(t));
}

function insert(row: Omit<AgentActivityRecord, 'id'>): string {
  const id = randomUUID();
  try {
    database.insert(agentActivity).values({ id, ...row }).run();
  } catch (err) {
    logError(`[agent] could not record activity for ${row.toolName}: ${err}`);
  }
  return id;
}

function update(id: string, fields: Partial<AgentActivityRecord>) {
  try {
    database.update(agentActivity).set(fields).where(eq(agentActivity.id, id)).run();
  } catch (err) {
    logError(`[agent] could not update activity ${id}: ${err}`);
  }
}

const decisionOf = (action: RuleMatch['action']): ActivityDecision =>
  action === 'allow' ? 'auto_allowed' : action === 'deny' ? 'blocked' : 'asked';

function baseFields(e: { sessionId: string; toolName: string; input: unknown; cls: Classification }) {
  return {
    sessionId: e.sessionId,
    toolName: e.toolName,
    category: e.cls.qualifier ? `${e.cls.category}:${e.cls.qualifier}` : e.cls.category,
    summary: truncate(redactText(e.cls.summary), 500),
    input: sanitizeInput(e.input),
  };
}

export interface ToolUseRecord {
  sessionId: string;
  toolName: string;
  toolUseId?: string;
  input: unknown;
  cls: Classification;
  /** Policy preview for this call; null when the policy has no opinion. */
  preview: RuleMatch | null;
  /** Protected by the bridge before the policy ran (requirements ledger). */
  protectedPath?: boolean;
  /** Pair by id only (Claude); otherwise pair FIFO by tool name. */
  exactIds: boolean;
}

/**
 * The model emitted a tool call. Until a permission decision arrives the row
 * reads "auto-allowed" — which is what it stays when the provider runs the
 * call without asking (Claude's own reads inside the working directory).
 */
export function recordToolUse(e: ToolUseRecord): void {
  const known = findById(e.toolUseId)
    ?? (!e.exactIds ? oldest(t => !t.sawUse && t.decided && t.toolName === e.toolName) : undefined);
  if (known) {
    known.sawUse = true;
    if (e.toolUseId) known.ids.add(e.toolUseId);
    return;
  }
  const now = Date.now();
  const decision: ActivityDecision = e.protectedPath ? 'blocked' : 'auto_allowed';
  const reason = e.protectedPath
    ? 'Protected path (requirements ledger)'
    : e.preview?.action === 'allow' ? e.preview.reason : 'Allowed by the provider without asking';
  const rowId = insert({
    ...baseFields(e),
    requestId: e.toolUseId ?? null,
    decision,
    decidedVia: e.protectedPath ? 'policy' : e.preview?.action === 'allow' ? 'policy' : 'provider',
    ruleId: !e.protectedPath && e.preview?.action === 'allow' ? e.preview.rule?.id ?? null : null,
    reason,
    createdAt: now,
    decidedAt: now,
  });
  remember({ rowId, toolName: e.toolName, ids: new Set(e.toolUseId ? [e.toolUseId] : []), at: now, sawUse: true, decided: false });
}

export interface DecisionRecord {
  sessionId: string;
  requestId?: string;
  toolName: string;
  input: unknown;
  cls: Classification;
  match: RuleMatch;
  exactIds: boolean;
}

/** The bridge asked the policy for a real decision. */
export function recordDecision(e: DecisionRecord): void {
  const now = Date.now();
  const decision = decisionOf(e.match.action);
  const fields = {
    ...baseFields(e),
    requestId: e.requestId ?? null,
    decision,
    decidedVia: decision === 'asked' ? null : 'policy',
    ruleId: e.match.rule?.id ?? null,
    reason: e.match.reason,
    decidedAt: decision === 'asked' ? null : now,
  };
  const track = findById(e.requestId)
    ?? (!e.exactIds ? oldest(t => t.sawUse && !t.decided && t.toolName === e.toolName) : undefined);
  if (track && !track.decided) {
    track.decided = true;
    if (e.requestId) track.ids.add(e.requestId);
    update(track.rowId, fields);
    return;
  }
  const rowId = insert({ ...fields, createdAt: now });
  remember({ rowId, toolName: e.toolName, ids: new Set(e.requestId ? [e.requestId] : []), at: now, sawUse: false, decided: true });
}

/**
 * An approval was raised for the agent. Usually the decision row exists
 * already; requests raised by tool handlers themselves (plan approval) don't
 * go through the policy, so they get their row here.
 */
export function recordApprovalRequested(e: { sessionId: string; requestId: string; toolName: string; input: unknown; cls: Classification }): void {
  const track = findById(e.requestId);
  if (track) {
    if (!track.decided) {
      track.decided = true;
      update(track.rowId, { decision: 'asked', decidedVia: null, decidedAt: null });
    }
    return;
  }
  const now = Date.now();
  const rowId = insert({ ...baseFields(e), requestId: e.requestId, decision: 'asked', decidedVia: null, ruleId: null, reason: 'Needs the owner', createdAt: now, decidedAt: null });
  remember({ rowId, toolName: e.toolName, ids: new Set([e.requestId]), at: now, sawUse: false, decided: true });
}

/** Close an "asked" row with the owner's answer (or its expiry). */
export function recordApprovalResolved(e: { requestId: string; allow: boolean; via: string }): void {
  const decision: ActivityDecision = e.via === 'expired' ? 'expired' : e.allow ? 'approved' : 'denied';
  const fields: Partial<AgentActivityRecord> = { decision, decidedVia: e.via, decidedAt: Date.now() };
  if (e.via === 'cancelled') fields.reason = 'Cancelled — the session was interrupted or restarted';
  if (e.via === 'expired') fields.reason = 'Nobody answered in time';
  try {
    database.update(agentActivity).set(fields)
      .where(and(eq(agentActivity.requestId, e.requestId), eq(agentActivity.decision, 'asked')))
      .run();
  } catch (err) {
    logError(`[agent] could not close activity for ${e.requestId}: ${err}`);
  }
}

export function pruneActivity(retentionDays: number, now = Date.now()): number {
  try {
    const res = database.delete(agentActivity).where(lt(agentActivity.createdAt, now - retentionDays * DAY_MS)).run() as unknown as { changes?: number };
    return res?.changes ?? 0;
  } catch (err) {
    logError(`[agent] activity prune failed: ${err}`);
    return 0;
  }
}

export interface ActivityQuery {
  limit?: number;
  before?: number;
  category?: string;
  decision?: string;
}

/** Newest first. `category` matches the coarse category and its qualified forms. */
export function listActivity(q: ActivityQuery = {}): AgentActivityRecord[] {
  const limit = Math.min(500, Math.max(1, Math.floor(q.limit ?? 100)));
  const conds = [];
  if (q.before && Number.isFinite(q.before)) conds.push(lt(agentActivity.createdAt, q.before));
  if (q.decision) conds.push(eq(agentActivity.decision, q.decision));
  if (q.category) {
    const cat = q.category;
    conds.push(cat.includes(':') ? eq(agentActivity.category, cat) : or(eq(agentActivity.category, cat), like(agentActivity.category, `${cat}:%`))!);
  }
  return database.select().from(agentActivity)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(agentActivity.createdAt))
    .limit(limit)
    .all();
}

/** Tests only. */
export function _resetActivityTracking(): void {
  tracks.length = 0;
}
