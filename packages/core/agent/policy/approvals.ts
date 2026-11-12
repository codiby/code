/**
 * Approvals: every pending permission request gets a 4-digit code, is sent
 * to the owner's channels, and can be answered from any of them (buttons, a
 * typed "SI 4821" — parsed by the channels area — the app, a push action).
 *
 * Answering settles the bridge's pending decision and leaves session state
 * exactly as the app's own permission_response does: the request card is
 * cleared, viewers get `permission_cancelled`, a deny also interrupts the
 * session. Agent-session approvals expire (auto-deny) so a forgotten request
 * can't block the agent forever; other sessions wait, as they always have.
 *
 * A settled request's code is not handed out again for hours, and a code
 * typed on a channel answers only a request that was sent there.
 */

import { randomInt } from 'crypto';
import { log, logError } from '../../lib/logger';
import { getPendingDecision, resolvePermissionDecision } from '../../provider/bridge';
import { saveSessions, sessions } from '../../session/sessions';
import { getSessionState, updateSessionState } from '../../session/state';
import { loadAgentConfig } from '../config';
import { ownerTargets, sendTo, sendToOwner } from '../outbox';
import type { ApprovalAnswer } from '../registry';
import { agentDeps, hasAgentDeps } from '../runtime';
import { AGENT_SESSION_ID } from '../session';
import type { ApprovalPrompt, ApprovalRequestedEvent, ApprovalResolvedEvent, OutboundMessage } from '../types';
import { recordApprovalRequested, recordApprovalResolved } from './activity';
import { classifyToolCall, isKnownServer, splitToolName, type Classification } from './classify';
import { classifyContext } from './evaluate';
import { redactText, truncate } from './redact';
import { createRule, escapeRegExp, listRules, type Rule } from './rules';
import { loadPolicySettings } from './settings';

export interface PendingApproval {
  requestId: string;
  code: string;
  toolName: string;
  title: string;
  summary: string;
  category: string;
  qualifier?: string;
  /** Redacted target (command, path, recipient) — what "always allow" pins. */
  target?: string;
  sessionId: string;
  sessionName: string;
  createdAt: number;
  /** 0 = waits until answered (sessions other than the agent's). */
  expiresAt: number;
  /** Original input, handed back to the provider on approval. Never leaves the process. */
  input: Record<string, unknown>;
  /** Unredacted target, only for building an exact "always allow" rule. */
  rawTarget?: string;
  /**
   * "Always allow" would pin the target into a rule pattern the UI shows, so
   * it's offered only when the target holds no secret and is short enough
   * for rule matching to see all of it.
   */
  pinnable: boolean;
  /** Channels the prompt went out on: a code typed on a channel answers only what reached it. */
  sentTo: Set<string>;
}

const pending = new Map<string, PendingApproval>();
const byCode = new Map<string, string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * Requests answered recently (any surface, expiry and cancellation included),
 * so a late answer is told "already answered" while an id that never existed
 * is told "not found" — a phone or a script retrying needs to tell them apart.
 */
const answered = new Set<string>();
const MAX_ANSWERED = 1000;

function rememberAnswered(requestId: string): void {
  answered.delete(requestId);
  answered.add(requestId);
  while (answered.size > MAX_ANSWERED) answered.delete(answered.values().next().value!);
}

/**
 * Codes of settled requests stay out of circulation this long, so a late
 * "SI 4821" is told it came too late instead of answering a newer request.
 */
export const CODE_COOLDOWN_MS = 6 * 60 * 60_000;

interface RetiredCode {
  requestId: string;
  sessionId: string;
  sentTo: Set<string>;
  until: number;
}

/** Oldest first: every code gets the same cooldown, so expired ones sit at the front. */
const retired = new Map<string, RetiredCode>();

let drawCode = (min: number, max: number): number => randomInt(min, max);

/** Tests only. */
export function _setCodeDraw(fn: ((min: number, max: number) => number) | null): void {
  drawCode = fn ?? ((min, max) => randomInt(min, max));
}

type Scheduler = (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
let schedule: Scheduler = (fn, ms) => {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return t;
};

/** Tests only. */
export function _setApprovalScheduler(fn: Scheduler | null): void {
  schedule = fn ?? ((f, ms) => setTimeout(f, ms));
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const TITLES: Record<string, string> = {
  shell: 'Run a shell command',
  write: 'Write a file outside the workspace',
  destructive: 'Run a destructive action',
  credentials: 'Use credentials or secrets',
  send_external: 'Send something to someone else',
  mail: 'Change your email',
  calendar: 'Change your calendar',
  purchase: 'Possible purchase or payment',
  network: 'Network action',
};

function titleFor(cls: Classification, event: ApprovalRequestedEvent): string {
  if (cls.category === 'credentials' && cls.qualifier === 'browser_secret') return 'Use a saved login';
  if (cls.category === 'send_external' && cls.qualifier === 'email') return 'Send an email';
  if (cls.category === 'send_external' && cls.qualifier === 'message') return 'Send a message';
  if (cls.category === 'write' && cls.qualifier === 'workspace') return 'Write a file';
  if (cls.qualifier === 'browser_script') return 'Run a script in the browser';
  return TITLES[cls.category] ?? event.title ?? splitToolName(event.toolName).bare;
}

function codeBlock(text: string, max: number): string {
  return `\`\`\`\n${truncate(text.replace(/```/g, "'''"), max)}\n\`\`\``;
}

/** One input value as a prompt line: redacted, on one line, clipped. */
function fieldText(v: unknown, max = 200): string {
  const s = Array.isArray(v) ? v.filter(x => typeof x === 'string').join(', ') : typeof v === 'string' ? v : '';
  return truncate(redactText(s.replace(/\s+/g, ' ').trim()), max);
}

/**
 * The key fields of a high-impact call, from its input: the summary is one
 * clipped line, and a script, a Bcc or the end of a message hides past it.
 */
function keyFields(a: PendingApproval): string[] {
  const { server, bare } = splitToolName(a.toolName);
  if (!isKnownServer(server)) return [];
  const input = a.input;
  const lines: string[] = [];
  const add = (label: string, v: unknown, max?: number) => {
    const text = fieldText(v, max);
    if (text) lines.push(`${label}: ${text}`);
  };
  switch (bare) {
    case 'browser_evaluate': {
      const script = typeof input.function === 'string' ? input.function.trim() : '';
      if (script) lines.push(codeBlock(redactText(script), 600));
      break;
    }
    case 'gmail_send':
      add('To', input.to);
      add('Cc', input.cc);
      add('Bcc', input.bcc);
      add('Subject', input.subject);
      add('Body', input.body, 400);
      break;
    case 'send_message':
      // The summary clipped a long text: show it whole.
      if (a.summary.endsWith('…')) add('Text', input.text ?? input.message, 600);
      break;
    case 'calendar_create':
    case 'calendar_update':
    case 'calendar_delete': {
      add('Event id', input.id ?? input.event_id ?? input.eventId, 120);
      const when = [fieldText(input.start, 60), fieldText(input.end, 60)].filter(Boolean).join(' → ');
      const tz = fieldText(input.timezone, 60);
      if (when) lines.push(`When: ${when}${tz ? ` (${tz})` : ''}`);
      add('Guests', input.attendees, 300);
      add('Location', input.location);
      add('Description', input.description);
      add('Guest emails', input.sendUpdates, 40);
      break;
    }
  }
  return lines;
}

/** Commands and paths read best as code; prose summaries as text, then the key fields. */
function detailBlock(a: PendingApproval): string {
  const codeLike = ['shell', 'destructive', 'credentials', 'write'].includes(a.category) && a.target;
  if (codeLike) return codeBlock(a.target!, 700);
  return [truncate(a.summary, 700), ...keyFields(a)].join('\n');
}

export function approvalText(a: PendingApproval): string {
  const lines = [`🔐 **Approval needed** — ${a.title}`, detailBlock(a)];
  if (a.sessionId !== AGENT_SESSION_ID) lines.push(`Session: ${a.sessionName}`);
  const site = loginSiteOf(a);
  if (site) lines.push(`Approving also lets the agent use this login on ${site} from now on (Agent → Rules to undo).`);
  const expiry = a.expiresAt ? ` Expires in ${Math.max(1, Math.round((a.expiresAt - Date.now()) / 60_000))} min.` : '';
  lines.push(`Reply **SI ${a.code}** to approve or **NO ${a.code}** to deny.${expiry}`);
  return lines.join('\n');
}

function questionText(a: PendingApproval): string {
  return [`❓ **${a.sessionName} has a question for you**`, truncate(a.summary, 700), 'Answer it in the Codiby app.'].join('\n');
}

export function toPrompt(a: PendingApproval): ApprovalPrompt {
  return {
    requestId: a.requestId,
    code: a.code,
    title: a.title,
    summary: a.summary,
    toolName: a.toolName,
    sessionId: a.sessionId,
    sessionName: a.sessionName,
    expiresAt: a.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Held by a pending request, or settled too recently to hand out again. */
function codeTaken(code: string, now: number): boolean {
  if (byCode.has(code)) return true;
  const r = retired.get(code);
  return !!r && r.until > now;
}

function allocateCode(): string {
  const now = Date.now();
  for (const [code, r] of retired) {
    if (r.until > now) break;
    retired.delete(code);
  }
  for (let i = 0; i < 500; i++) {
    const code = String(drawCode(1000, 10_000));
    if (!codeTaken(code, now)) return code;
  }
  // 9,000 codes pending or cooling down is not a real situation; stay unique anyway.
  let code: string;
  do { code = String(drawCode(100_000, 1_000_000)); } while (codeTaken(code, now));
  return code;
}

function forget(requestId: string): PendingApproval | undefined {
  const a = pending.get(requestId);
  pending.delete(requestId);
  if (a && byCode.get(a.code) === requestId) {
    byCode.delete(a.code);
    retired.delete(a.code);
    retired.set(a.code, { requestId, sessionId: a.sessionId, sentTo: a.sentTo, until: Date.now() + CODE_COOLDOWN_MS });
  }
  const t = timers.get(requestId);
  if (t) clearTimeout(t);
  timers.delete(requestId);
  return a;
}

function contextFor(sessionId: string) {
  const ctx = classifyContext(sessionId);
  // A coding session's "workspace" is its own folder, not the agent's.
  const session = sessions.get(sessionId);
  return sessionId === AGENT_SESSION_ID || !session?.cwd ? ctx : { ...ctx, workspaceDir: session.cwd };
}

export function handleApprovalRequested(e: ApprovalRequestedEvent): void {
  if (pending.has(e.requestId)) return;
  const isAgent = e.sessionId === AGENT_SESSION_ID;
  const settings = loadPolicySettings();
  let cls: Classification;
  try {
    cls = classifyToolCall(e.toolName, e.input, contextFor(e.sessionId));
  } catch (err) {
    logError(`[agent] could not classify approval ${e.requestId}: ${err}`);
    cls = { category: 'other', summary: e.summary || e.toolName, reasons: [] };
  }
  const now = Date.now();
  const entry: PendingApproval = {
    requestId: e.requestId,
    code: allocateCode(),
    toolName: e.toolName,
    title: titleFor(cls, e),
    summary: truncate(redactText(cls.summary || e.summary || e.title), 800),
    category: cls.category,
    qualifier: cls.qualifier,
    target: cls.target ? truncate(redactText(cls.target), 2000) : undefined,
    rawTarget: cls.target,
    pinnable: !cls.target || (cls.target.length <= 2000 && redactText(cls.target) === cls.target),
    sessionId: e.sessionId,
    sessionName: e.sessionName,
    createdAt: now,
    expiresAt: isAgent ? now + settings.approvalTimeoutMinutes * 60_000 : 0,
    input: e.input ?? {},
    sentTo: new Set(),
  };
  pending.set(entry.requestId, entry);
  byCode.set(entry.code, entry.requestId);

  if (isAgent) {
    recordApprovalRequested({ sessionId: e.sessionId, requestId: e.requestId, toolName: e.toolName, input: e.input, cls });
    timers.set(entry.requestId, schedule(() => { void expireApproval(entry.requestId); }, entry.expiresAt - now));
  }
  if (isAgent || settings.approvalsForAllSessions) void fanOut(entry);
}

export function handleApprovalResolved(e: ApprovalResolvedEvent): void {
  const entry = pending.get(e.requestId);
  forget(e.requestId);
  rememberAnswered(e.requestId);
  recordApprovalResolved(e);
  // Here rather than in the answerer: the app's own permission card settles
  // through the bridge directly, and a login approved there counts too.
  if (e.allow && entry) {
    try { rememberLoginSite(entry); } catch (err) { logError(`[agent] could not save the login rule for ${entry.code}: ${err}`); }
  }
}

// ---------------------------------------------------------------------------
// Saved logins: one approval per site
// ---------------------------------------------------------------------------

/**
 * The site of an agent `browser_fill_secret` request, or null. Approving
 * one is a decision about the site ("the agent may log into example.com"),
 * not about one keystroke: the tool already refuses any page that isn't on
 * that site, over https, in a real password field. Asking on every fill
 * would mean two approvals per login, every time.
 */
function loginSiteOf(a: Pick<PendingApproval, 'sessionId' | 'toolName' | 'rawTarget'>): string | null {
  if (a.sessionId !== AGENT_SESSION_ID) return null;
  const { server, bare } = splitToolName(a.toolName);
  if (bare !== 'browser_fill_secret' || !isKnownServer(server)) return null;
  const m = /^site:([a-z0-9.-]+)$/.exec(a.rawTarget ?? '');
  return m ? m[1]! : null;
}

/** The site and its subdomains — the same reach the tool's own origin check allows. */
export function loginSitePattern(site: string): string {
  return `^site:(?:[a-z0-9-]+\\.)*${escapeRegExp(site)}$`;
}

/**
 * The always-allow rule for a login's site, created on its first approval.
 * An existing rule for the site is returned as is — including a disabled
 * one, which the owner switched off on purpose.
 */
export function rememberLoginSite(a: PendingApproval): Rule | null {
  const site = loginSiteOf(a);
  if (!site) return null;
  const pattern = loginSitePattern(site);
  const existing = listRules().find(r => r.source === 'always_allow' && r.toolGlob === 'browser_fill_secret' && r.pattern === pattern);
  if (existing) return existing;
  const date = new Date().toISOString().slice(0, 10);
  const rule = createRule({
    toolGlob: 'browser_fill_secret',
    pattern,
    action: 'allow',
    note: `Saved login for ${site}: allowed after the first approval on ${date}`,
  }, 'always_allow');
  log(`[agent] login fills on ${site} are allowed from now on (${rule.id})`);
  return rule;
}

/** Still waiting for an answer: neither settled through us nor through the bridge directly. */
function isLive(requestId: string): boolean {
  return pending.has(requestId) && !!getPendingDecision(requestId);
}

/**
 * Every owner channel, side by side: a channel waiting out a rate limit or
 * retrying must not hold the prompt back from the others. Each channel checks
 * that the request is still waiting before it sends, so one answered (or
 * settled in the app) before its fan-out reaches a channel is not sent there.
 * A send already under way when the answer lands is settled by its adapter
 * (channels/approvals.ts).
 */
async function fanOut(a: PendingApproval): Promise<void> {
  const msg: OutboundMessage = a.toolName === 'AskUserQuestion'
    ? { kind: 'text', text: questionText(a), priority: 'normal' }
    : { kind: 'approval', text: approvalText(a), approval: toPrompt(a), priority: 'normal' };
  // No channel reaches the owner (desktop-only setups): the app's own card is enough.
  const targets = ownerTargets();
  if (targets.length === 0) return;
  const deliveredTo: string[] = [];
  const skipped: string[] = [];
  let lastError: string | undefined;
  await Promise.all(targets.map(async addr => {
    if (!isLive(a.requestId)) {
      skipped.push(addr.channelId);
      return;
    }
    // Before the send, so an answer typed the moment it lands is accepted.
    a.sentTo.add(addr.channelId);
    try {
      const res = await sendTo(addr, msg);
      if (res.ok) deliveredTo.push(addr.channelId);
      else {
        lastError = res.error;
        a.sentTo.delete(addr.channelId);
      }
    } catch (err) {
      a.sentTo.delete(addr.channelId);
      lastError = err instanceof Error ? err.message : String(err);
      logError(`[agent] approval fan-out to ${addr.channelId} failed: ${lastError}`);
    }
  }));
  if (skipped.length) log(`[agent] approval ${a.code} was answered before it reached ${skipped.join(', ')}; not sent there`);
  if (deliveredTo.length) log(`[agent] sent approval ${a.code} to owner via ${deliveredTo.join(', ')}`);
  else if (skipped.length < targets.length) log(`[agent] approval ${a.code} not delivered to any channel: ${lastError ?? 'unknown error'}`);
}

/** Mirror the app's permission_response: clear the card and tell every viewer. */
function settleSessionState(sessionId: string, requestId: string): void {
  updateSessionState(sessionId, s => (s.permRequest?.requestId === requestId ? { ...s, permRequest: null } : s));
  if (hasAgentDeps()) agentDeps().broadcastToSession(sessionId, { type: 'permission_cancelled', sessionId, requestId });
}

/** Approving a plan takes the session out of plan mode, as the app does. */
async function leavePlanMode(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session || session.permissionMode !== 'plan') return;
  session.permissionMode = 'acceptEdits';
  saveSessions();
  if (hasAgentDeps()) agentDeps().broadcastSessionList();
  try { await session.providerSession?.setPermissionMode('acceptEdits'); } catch {}
  log(`[${sessionId.slice(0, 8)}] ExitPlanMode approved remotely — switched to acceptEdits`);
}

export async function expireApproval(requestId: string): Promise<boolean> {
  const a = pending.get(requestId);
  if (!a) return false;
  const minutes = Math.max(1, Math.round((a.expiresAt - a.createdAt) / 60_000));
  const owner = loadAgentConfig().owner.name || 'The owner';
  const resolved = resolvePermissionDecision(requestId, {
    allow: false,
    message: `Not approved: ${owner} didn't answer within ${minutes} min, so this was not run. Don't retry it on your own — tell ${owner === 'The owner' ? 'them' : owner} what you wanted to do.`,
  }, 'expired');
  forget(requestId);
  if (!resolved) return false;
  settleSessionState(a.sessionId, requestId);
  void sendToOwner({ kind: 'text', text: `⌛ Approval ${a.code} expired — ${a.title}. It was not run.` }).catch(() => {});
  log(`[agent] approval ${a.code} (${a.toolName}) expired after ${minutes} min`);
  return true;
}

function normaliseCode(code: string): string {
  return code.replace(/\D+/g, '');
}

export interface ApprovalAnswerResult {
  ok: boolean;
  requestId?: string;
  error?: string;
  /**
   * Why it was refused: `not_found` — no such request (or a code that matches
   * none) · `answered` — it was settled already · `question` — answered only
   * in the app · `invalid` — neither an id nor a code. The routes map these
   * to HTTP statuses.
   */
  reason?: 'not_found' | 'answered' | 'question' | 'invalid';
}

const ALREADY_ANSWERED = 'This approval was already answered or has expired';

/**
 * A code typed on a channel answers only what reached that channel's owner:
 * the agent's own requests, or prompts sent there. Other sessions' requests
 * that never went out on it stay out of reach of a guessed or mistyped code.
 */
function reachedChannel(a: Pick<PendingApproval, 'sessionId' | 'sentTo'>, channelId: string | undefined): boolean {
  return !channelId || a.sessionId === AGENT_SESSION_ID || a.sentTo.has(channelId);
}

/** The ApprovalAnswerer installed in the registry. */
export async function answerPendingApproval(answer: ApprovalAnswer): Promise<ApprovalAnswerResult> {
  let requestId = answer.requestId;
  if (!requestId && answer.code) {
    const code = normaliseCode(answer.code);
    const entry = pending.get(byCode.get(code) ?? '');
    if (entry && reachedChannel(entry, answer.channelId)) requestId = entry.requestId;
    const old = entry ? undefined : retired.get(code);
    if (old && old.until > Date.now() && reachedChannel(old, answer.channelId)) {
      return { ok: false, requestId: old.requestId, error: `Approval ${code} was already answered or has expired`, reason: 'answered' };
    }
  }
  if (!requestId) {
    return answer.code
      ? { ok: false, error: `No pending approval with code ${answer.code}`, reason: 'not_found' }
      : { ok: false, error: 'requestId or code is required', reason: 'invalid' };
  }
  const live = getPendingDecision(requestId);
  if (!live) {
    const known = pending.has(requestId) || answered.has(requestId);
    forget(requestId);
    return known
      ? { ok: false, requestId, error: ALREADY_ANSWERED, reason: 'answered' }
      : { ok: false, requestId, error: 'No pending approval with this id — it may have been answered before the bridge restarted', reason: 'not_found' };
  }
  if (live.toolName === 'AskUserQuestion') return { ok: false, requestId, error: 'Questions have to be answered in the Codiby app', reason: 'question' };
  const entry = pending.get(requestId);
  const isPlan = live.toolName === 'ExitPlanMode' && getSessionState(live.sessionId).permRequest?.toolName === 'ExitPlanMode';
  const resolved = resolvePermissionDecision(
    requestId,
    answer.allow ? { allow: true, updatedInput: entry?.input ?? {} } : { allow: false, interrupt: true },
    answer.via,
  );
  forget(requestId);
  if (!resolved) return { ok: false, requestId, error: ALREADY_ANSWERED, reason: 'answered' };
  settleSessionState(live.sessionId, requestId);
  if (answer.allow && isPlan) await leavePlanMode(live.sessionId);
  // A deny stops the turn so the model doesn't keep retrying the same tool.
  if (!answer.allow && hasAgentDeps()) {
    try { await agentDeps().interruptSession(live.sessionId); } catch (err) { logError(`[agent] interrupt after deny failed: ${err}`); }
  }
  log(`[agent] approval ${entry?.code ?? requestId.slice(0, 8)} ${answer.allow ? 'approved' : 'denied'} via ${answer.via}`);
  return { ok: true, requestId };
}

export function getPendingApproval(requestId: string): PendingApproval | null {
  return pending.get(requestId) ?? null;
}

/** Pending approvals that the bridge is still waiting on, oldest first. */
export function listPendingApprovals(): PendingApproval[] {
  for (const id of [...pending.keys()]) if (!getPendingDecision(id)) forget(id);
  return [...pending.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * "Always allow": a user rule pinned to this tool and this exact target, so
 * the same call runs freely next time but a different command still asks.
 */
export function createAlwaysAllowRule(a: PendingApproval): Rule {
  // A login is pinned to its site, not to the exact call (usually saved already by handleApprovalResolved).
  const login = rememberLoginSite(a);
  if (login) return login;
  const { server, bare } = splitToolName(a.toolName);
  const glob = server === '' || server === 'codiby-code' || server === 'codiby-code-sdk' ? bare : a.toolName;
  const date = new Date().toISOString().slice(0, 10);
  return createRule({
    toolGlob: glob,
    pattern: a.rawTarget ? `^${escapeRegExp(a.rawTarget)}$` : null,
    action: 'allow',
    note: `Always allowed from an approval on ${date}${a.target ? `: ${truncate(a.target, 120)}` : ''}`,
  }, 'always_allow');
}

/** Tests only. */
export function _resetApprovals(): void {
  for (const id of [...pending.keys()]) forget(id);
  answered.clear();
  retired.clear();
}
