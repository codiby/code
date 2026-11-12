/**
 * Reply dispatch — when the agent's turn completes, its new text goes back
 * to the channel(s) the turn's messages came from. Turns nobody sent from a
 * channel (typed in the app, heartbeats, automations) deliver nothing; the
 * agent reaches out on purpose with `notify_user` instead.
 *
 * A turn the provider failed (not logged in, API error, interrupted…) is
 * relayed as a Codiby notice ("⚠️ Codiby: …"): the provider's error text is
 * never passed off as something the agent said.
 *
 * The origins waiting on a reply are mirrored to `inflight-replies.json` in
 * the agent data dir (0600) whenever one is recorded or delivered. If the
 * bridge stops mid-turn, the next start reads them back: when the owner
 * resumes the interrupted turn they keep waiting for its reply; otherwise
 * each is told the message was lost (RESTART_NOTICE).
 */

import { getSessionState, type ChatMessage } from '../session/state';
import { getInterruptedTurns } from '../session/interrupted';
import { log, logError } from '../lib/logger';
import type { TurnCompleteInfo } from '../provider/types';
import { emitAgentTurnComplete, onAgentStart, onAgentStop } from './registry';
import { getChannel, sendTo } from './outbox';
import { consumeRequestedStop } from './runtime';
import { AGENT_SESSION_ID } from './session';
import { agentDataDir, createJsonStore } from './store';
import type { ChannelAddress, ChannelType } from './types';

/** Replies that mean "nothing to say" — never forwarded to a channel. */
export const SILENT_REPLIES = new Set(['HEARTBEAT_OK', 'NO_REPLY']);

/** Opens every message Codiby itself (not the agent) sends a channel about a turn. */
export const CODIBY_NOTICE_PREFIX = '⚠️ Codiby: ';

export function codibyNotice(detail: string): string {
  return CODIBY_NOTICE_PREFIX + detail.trim().replace(/\s+/g, ' ').slice(0, 500);
}

/** Stop reasons that mean the turn did not end with the agent's answer. */
const FAILED_STOPS: Record<string, string> = {
  error: 'The agent\'s turn ended with a provider error.',
  interrupted: 'The agent\'s turn was interrupted before it finished.',
};

/**
 * What the Claude Code CLI returns as the whole result when it can't run a
 * turn at all. Only trusted when the result is the one thing that came out
 * of the turn, so an adapter that doesn't flag `isError` yet still gets
 * these relayed as notices rather than as the agent's words. Anchored and
 * narrow: a reply that merely talks about an error must not match.
 */
const PROVIDER_FAILURE_TEXT = /^(?:Not logged in · |Invalid API key · |OAuth token (?:has expired|revoked)|Credit balance is too low|API Error(?::| \()|Claude AI usage limit reached|You've hit your (?:\w+ )?limit|Prompt is too long$|This organization has been disabled)/;

const isResultMessage = (m: ChatMessage) => m.costUsd !== undefined || m.durationMs !== undefined;

/**
 * The provider's error when this completion is a failed turn, else null.
 * `interrupted`: the turn was stopped (Stop in the app, `/stop`, a barge-in)
 * or died on an error — whatever the provider then reports about it.
 */
export function providerFailure(info: TurnCompleteInfo | undefined, segment: ChatMessage[], interrupted = false): string | null {
  // An aborted Claude turn comes back as an `error_during_execution` result
  // whose errors are internal diagnostics; "interrupted" is what happened.
  if (interrupted) return FAILED_STOPS.interrupted!;
  if (info?.isError) {
    const errors = (info.errors ?? []).map(e => e.trim()).filter(e => e && !e.startsWith('[ede_diagnostic]'));
    const detail = info.resultText?.trim() || errors.join('; ');
    return detail || FAILED_STOPS[info.stopReason ?? ''] || 'The agent\'s turn failed with a provider error.';
  }
  const stop = info?.stopReason ? FAILED_STOPS[info.stopReason] : undefined;
  if (stop) return (info?.stopReason === 'error' && info.resultText?.trim()) || stop;
  const deliverable = segment.filter(isDeliverable);
  if (deliverable.length === 1 && isResultMessage(deliverable[0]!)) {
    const text = deliverable[0]!.content.trim();
    if (PROVIDER_FAILURE_TEXT.test(text)) return text;
  }
  return null;
}

let cursor: string | null = null;
let primed = false;
/** `midTurn`: the message arrived while a turn was already running. */
const pendingOrigins: { addr: ChannelAddress; midTurn: boolean }[] = [];
/**
 * Origins of messages that arrived mid-turn. The provider queues such a
 * message: it may fold it into the running turn, or answer it in a turn of
 * its own right after. For the second case these origins also get the next
 * turn — unless a new message opens that turn, which brings its own origin.
 */
let carriedOrigins: ChannelAddress[] = [];
/** What the last completed turn delivered (to spot the same turn reported twice). */
let lastTexts: string[] = [];
/**
 * One queue per channel: a channel's deliveries run one after another so
 * consecutive replies keep their order, while a channel waiting out a rate
 * limit (the outbox honours Telegram's retry_after) holds up no other.
 */
const channelQueues = new Map<string, Promise<void>>();
/** Origins already told about a provider error since their message arrived (see handleAgentProviderError). */
const errorNoticed = new Set<string>();

function sameAddress(a: ChannelAddress, b: ChannelAddress): boolean {
  return a.channelId === b.channelId && a.peer === b.peer;
}

const addressKey = (a: ChannelAddress) => `${a.channelId}\u0000${a.peer}`;

function enqueueDelivery(channelId: string, job: () => Promise<void>): void {
  const next = (channelQueues.get(channelId) ?? Promise.resolve())
    .then(job)
    .catch(err => logError(`[agent] reply delivery failed: ${err}`));
  channelQueues.set(channelId, next);
  void next.then(() => { if (channelQueues.get(channelId) === next) channelQueues.delete(channelId); });
}

function indexAfterCursor(messages: ChatMessage[]): number {
  if (!cursor) return 0;
  const i = messages.findIndex(m => m.id === cursor);
  return i >= 0 ? i + 1 : messages.length;
}

// ---------------------------------------------------------------------------
// In-flight origins on disk — surviving a bridge restart
// ---------------------------------------------------------------------------

/** What a channel hears when the bridge restarted under its message and the turn was not resumed. */
export const RESTART_NOTICE = '⚠️ Codiby restarted while working on your message — please send it again.';
/**
 * What index.ts sends a session when the owner resumes its interrupted turn
 * (POST /interrupted-sessions/resume — keep the two in step). A turn opened
 * by it, from the app rather than a channel, is the interrupted one resumed.
 */
export const RESUME_PROMPT = 'Continue.';
/** How long restored origins wait for the owner to resume the turn before they are told. */
const RESUME_GRACE_MS = 2 * 60_000;
const RESUME_POLL_MS = 3_000;
/** A notice waits this long at most for its channel to come up after a start. */
const CHANNEL_WAIT_MS = 60_000;
/** Older than this, a restored origin's message is not worth a notice any more. */
const MAX_RESTORE_AGE_MS = 12 * 60 * 60_000;
const MAX_STORED_ORIGINS = 50;

interface StoredOrigin {
  addr: ChannelAddress;
  midTurn: boolean;
  /** Already told about a provider error on this turn (errorNoticed). */
  noticed: boolean;
}

interface InflightReplies {
  at: number;
  pending: StoredOrigin[];
  carried: ChannelAddress[];
}

const CHANNEL_TYPES: ReadonlySet<ChannelType> = new Set(['telegram', 'whatsapp', 'http_webhook', 'ios_shortcut', 'app']);

const shortStr = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v && v.length <= max ? v : undefined);

/** A stored address, or null: only the fields a reply needs, each type- and size-checked. */
function storedAddress(raw: unknown): ChannelAddress | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const channelId = shortStr(r.channelId, 200);
  const peer = shortStr(r.peer, 500);
  if (!channelId || !peer || !CHANNEL_TYPES.has(r.channelType as ChannelType)) return null;
  const addr: ChannelAddress = { channelId, channelType: r.channelType as ChannelType, peer };
  const peerName = shortStr(r.peerName, 200);
  const replyTo = shortStr(r.replyTo, 200);
  if (peerName) addr.peerName = peerName;
  if (replyTo) addr.replyTo = replyTo;
  return addr;
}

const inflightStore = createJsonStore<InflightReplies>({
  file: agentDataDir('inflight-replies.json'),
  // Chat ids and names of whoever is waiting on the agent: owner-only.
  mode: 0o600,
  normalize: (raw) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const pending: StoredOrigin[] = [];
    for (const item of Array.isArray(r.pending) ? r.pending.slice(0, MAX_STORED_ORIGINS) : []) {
      const addr = storedAddress((item as { addr?: unknown } | null)?.addr);
      if (addr) pending.push({ addr, midTurn: (item as StoredOrigin).midTurn === true, noticed: (item as StoredOrigin).noticed === true });
    }
    const carried = (Array.isArray(r.carried) ? r.carried.slice(0, MAX_STORED_ORIGINS) : [])
      .map(storedAddress)
      .filter((a): a is ChannelAddress => a !== null);
    const at = typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0;
    return { at, pending, carried };
  },
});

/** Origins read back after a restart, until the interrupted turn is resumed or they are told it was lost. */
let restored: { addr: ChannelAddress; noticed: boolean }[] = [];
/** When the restored origins were last written by the previous run. */
let restoredAt = 0;
/** The transcript's last message id at restore: what comes after it is this run's. */
let restoredFrom: string | null = null;
let restoreWatch: ReturnType<typeof setInterval> | null = null;
let restoreDeadline = 0;
/** The last thing written, so a turn that changed nothing writes nothing. */
let lastPersisted = '';
/** session/interrupted.ts offers the agent's cut-off turn for resume: it was mid-turn when the bridge stopped. */
const agentTurnOffered = () => getInterruptedTurns().some(t => t.sessionId === AGENT_SESSION_ID);
let resumeOffered = agentTurnOffered;

function persistOrigins(): void {
  const pending: StoredOrigin[] = restored.map(r => ({ addr: r.addr, midTurn: false, noticed: r.noticed }));
  for (const o of pendingOrigins) {
    if (pending.some(p => sameAddress(p.addr, o.addr))) continue;
    pending.push({ addr: o.addr, midTurn: o.midTurn, noticed: errorNoticed.has(addressKey(o.addr)) });
  }
  const key = JSON.stringify([pending, carriedOrigins]);
  if (key === lastPersisted) return;
  try {
    inflightStore.set({ at: Date.now(), pending, carried: carriedOrigins });
    lastPersisted = key;
  } catch (err) {
    logError(`[agent] could not save the origins awaiting a reply: ${err}`);
  }
}

/**
 * Read back what the previous run left waiting (once, from primeDispatch).
 * Pending origins always count: their message's turn never completed.
 * Carried ones only when the agent was mid-turn as the bridge stopped
 * (session/interrupted.ts) — otherwise their message was folded into the
 * turn that did complete, and they already have its reply.
 */
function restoreInflight(): void {
  let saved: InflightReplies;
  try {
    saved = inflightStore.reload();
  } catch {
    return;
  }
  lastPersisted = JSON.stringify([saved.pending, saved.carried]);
  restoredFrom = cursor;
  restoredAt = saved.at;
  const list: { addr: ChannelAddress; noticed: boolean }[] = [];
  const candidates = [...saved.pending, ...(resumeOffered() ? saved.carried.map(addr => ({ addr, noticed: false })) : [])];
  for (const o of candidates) {
    if (!list.some(r => sameAddress(r.addr, o.addr))) list.push({ addr: o.addr, noticed: o.noticed });
  }
  restored = Date.now() - saved.at > MAX_RESTORE_AGE_MS ? [] : list;
  persistOrigins();
  if (restored.length) log(`[agent] ${restored.length} channel(s) were waiting on a reply when the bridge stopped`);
}

/** The first message that opened a main-thread turn after the restore point. */
function openerSinceRestore(): ChatMessage | null {
  const msgs = getSessionState(AGENT_SESSION_ID).messages;
  let start = 0;
  if (restoredFrom) {
    const i = msgs.findIndex(m => m.id === restoredFrom);
    start = i >= 0 ? i + 1 : msgs.length;
  }
  return msgs.slice(start).find(m => m.role === 'user' && !m.isToolResult && !m.parentToolUseId && !m.agentId) ?? null;
}

const isResumePrompt = (m: ChatMessage) => !m.source && m.content.trim() === RESUME_PROMPT;

/**
 * Decide what the restored origins get. Resumed (the resume prompt opened
 * the next turn): they wait for its reply like any pending origin. Not
 * resumed — another message opened a turn, the owner wrote again from a
 * channel, the offer was dismissed, or the grace period ran out — each is
 * sent RESTART_NOTICE, unless it was already told the turn failed.
 */
function settleRestored(why: 'tick' | 'deadline' | 'inbound' | 'turn'): void {
  if (!restored.length) return;
  const opener = openerSinceRestore();
  if (opener && isResumePrompt(opener)) {
    for (const r of restored) {
      if (!pendingOrigins.some(o => sameAddress(o.addr, r.addr))) pendingOrigins.push({ addr: r.addr, midTurn: false });
    }
    log(`[agent] the interrupted turn was resumed: its reply goes to the ${restored.length} channel(s) waiting on it`);
    restored = [];
    stopRestoreWatch();
    persistOrigins();
    return;
  }
  if (!opener && why !== 'inbound' && why !== 'deadline' && resumeOffered()) return;
  const told = restored;
  restored = [];
  stopRestoreWatch();
  persistOrigins();
  for (const r of told) {
    if (r.noticed) continue;
    enqueueDelivery(r.addr.channelId, async () => {
      await channelReady(r.addr.channelId);
      await sendTo(r.addr, { kind: 'text', text: RESTART_NOTICE });
    });
  }
}

let channelPollMs = 1_000;

/** Right after a start the channels may still be connecting. */
async function channelReady(channelId: string): Promise<void> {
  const until = Date.now() + CHANNEL_WAIT_MS;
  while (Date.now() < until) {
    try {
      if (getChannel(channelId)?.status().connected) return;
    } catch {}
    await new Promise(r => setTimeout(r, channelPollMs));
  }
}

function stopRestoreWatch(): void {
  if (restoreWatch) clearInterval(restoreWatch);
  restoreWatch = null;
}

/** Agent start: give the owner RESUME_GRACE_MS to resume the interrupted turn. */
function startRestoreWatch(): void {
  primeDispatch();
  if (!restored.length || restoreWatch) return;
  if (Date.now() - restoredAt > MAX_RESTORE_AGE_MS) {
    restored = [];
    persistOrigins();
    return;
  }
  restoreDeadline = Date.now() + RESUME_GRACE_MS;
  settleRestored('tick');
  if (!restored.length) return;
  restoreWatch = setInterval(() => settleRestored(Date.now() >= restoreDeadline ? 'deadline' : 'tick'), RESUME_POLL_MS);
  restoreWatch.unref?.();
}

onAgentStart('dispatch', startRestoreWatch);
// The channels stop with the agent: what is still undecided waits for the next start.
onAgentStop('dispatch', stopRestoreWatch);

/**
 * Called by inbound.ts right before a channel message is handed to the agent.
 * Returns the undo for a message that then never reached it: its origin left
 * pending would be handed the next turn's reply — once per failed attempt,
 * since a webhook's peer is a fresh request id each time (a callback channel
 * got the same answer POSTed again for every retry the sender made).
 */
export function recordTurnOrigin(addr: ChannelAddress): () => void {
  primeDispatch();
  // A new message before any resume: the turn the restart cut off is not coming back.
  settleRestored('inbound');
  const clean: ChannelAddress = { channelId: addr.channelId, channelType: addr.channelType, peer: addr.peer, peerName: addr.peerName, replyTo: addr.replyTo };
  // Anything in the transcript since the last completed turn means one is under way.
  const state = getSessionState(AGENT_SESSION_ID);
  const midTurn = state.isStreaming || state.messages.slice(indexAfterCursor(state.messages)).some(m => m.role !== 'system');
  const i = pendingOrigins.findIndex(o => sameAddress(o.addr, clean));
  const before = i >= 0 ? pendingOrigins[i]! : null;
  const entry = { addr: clean, midTurn: midTurn || !!before?.midTurn };
  if (i >= 0) pendingOrigins[i] = entry;
  else pendingOrigins.push(entry);
  // A new message is a new turn to fail: its error deserves its own notice.
  errorNoticed.delete(addressKey(clean));
  persistOrigins();
  return () => {
    // Only our own entry: a completed turn may have taken it already, and
    // another message from the same address may have replaced it since.
    const j = pendingOrigins.indexOf(entry);
    if (j < 0) return;
    if (before) pendingOrigins[j] = before;
    else pendingOrigins.splice(j, 1);
    persistOrigins();
  };
}

/**
 * Anchor the cursor at the end of the transcript so a restart never replays
 * history, and read back the origins the previous run left waiting.
 */
export function primeDispatch(): void {
  if (primed) return;
  primed = true;
  const msgs = getSessionState(AGENT_SESSION_ID).messages;
  cursor = msgs.length ? msgs[msgs.length - 1]!.id : null;
  restoreInflight();
}

function isDeliverable(m: ChatMessage): boolean {
  // Sub-agents talk to the agent, not to the owner: their text stays in the Agents window.
  if (m.parentToolUseId || m.agentId) return false;
  return m.role === 'assistant' && !m.toolName && !m.isToolResult && !m.isThinking && !!m.content?.trim();
}

/**
 * New assistant texts since the cursor. The turn's result message repeats
 * the last streamed text, so it only counts when nothing else was streamed.
 */
export function collectReplyTexts(messages: ChatMessage[], fromId: string | null): string[] {
  let start = 0;
  if (fromId) {
    const i = messages.findIndex(m => m.id === fromId);
    start = i >= 0 ? i + 1 : messages.length;
  }
  const texts: string[] = [];
  for (const m of messages.slice(start)) {
    if (!isDeliverable(m)) continue;
    const text = m.content.trim();
    const isResult = m.costUsd !== undefined || m.durationMs !== undefined;
    if (isResult && texts.length > 0) {
      if (texts[texts.length - 1] === text || texts.includes(text)) continue;
    }
    if (texts[texts.length - 1] === text) continue;
    texts.push(text);
  }
  return texts.filter(t => !SILENT_REPLIES.has(t));
}

/**
 * Hooked from provider/bridge.ts onTurnComplete; `info` is the provider's
 * report of how the turn ended, `interrupted` whether the bridge saw it
 * stopped. Never throws.
 */
export function handleAgentTurnComplete(sessionId: string, info?: TurnCompleteInfo, opts: { interrupted?: boolean } = {}): void {
  if (sessionId !== AGENT_SESSION_ID) return;
  try {
    primeDispatch();
    // Resumed after a restart: the origins that were waiting join this turn.
    settleRestored('turn');
    const messages = getSessionState(sessionId).messages;
    const segment = messages.slice(indexAfterCursor(messages));
    cursor = messages.length ? messages[messages.length - 1]!.id : cursor;
    // A stop the owner asked for from a channel was already acknowledged there.
    const failure = opts.interrupted && consumeRequestedStop(sessionId) ? null : providerFailure(info, segment, !!opts.interrupted);
    // The Claude adapter can report one turn twice: its closing message, then
    // the result repeating it. A completion that brings nothing but that echo
    // is the same turn — treating it as the queued one would hand the queued
    // message's channel a duplicate and leave its real answer undelivered.
    // A failed queued turn may echo the previous failure word for word, and
    // its channel still has to hear it.
    const echoOnly = segment.every(m => isResultMessage(m) && (!m.content?.trim() || lastTexts.includes(m.content.trim())));
    if (echoOnly && (!failure || segment.length === 0)) return;
    // A failed turn's result carries the provider's error, not the agent's words.
    const texts = collectReplyTexts(failure ? segment.filter(m => !isResultMessage(m)) : segment, null);
    const outgoing = failure ? [...texts, codibyNotice(failure)] : texts;
    // A turn opened by a new message answers that message. One that opens
    // with the agent's own output is the provider getting to a message queued
    // during the previous turn, so that message's channel gets it too.
    const opener = segment.find(m => m.role !== 'system' && !m.parentToolUseId && !m.agentId);
    const queuedTurn = opener?.role !== 'user';
    const origins: ChannelAddress[] = [];
    for (const addr of [...(queuedTurn ? carriedOrigins : []), ...pendingOrigins.map(o => o.addr)]) {
      if (!origins.some(o => sameAddress(o, addr))) origins.push(addr);
    }
    carriedOrigins = pendingOrigins.filter(o => o.midTurn).map(o => o.addr);
    pendingOrigins.length = 0;
    lastTexts = segment.filter(isDeliverable).map(m => m.content.trim());
    for (const origin of origins) {
      const key = addressKey(origin);
      // Already told by handleAgentProviderError: one notice per failed turn.
      deliver(origin, errorNoticed.has(key) ? texts : outgoing);
      errorNoticed.delete(key);
    }
    persistOrigins();
    emitAgentTurnComplete(sessionId, failure ? { texts, failure } : { texts });
  } catch (err) {
    logError(`[agent] dispatch failed: ${err}`);
  }
}

/**
 * Hooked from provider/bridge.ts onError when the error ended a running
 * turn. The provider may never report that turn complete (a crashed CLI, a
 * failed Codex turn), so the channels waiting on it hear about it now. The
 * origins stay pending: if the turn does complete after all, its reply
 * still reaches them. Never throws.
 */
export function handleAgentProviderError(sessionId: string, message: string): void {
  if (sessionId !== AGENT_SESSION_ID) return;
  try {
    const notice = codibyNotice(`The agent's provider failed: ${message || 'unknown error'}`);
    for (const { addr } of pendingOrigins) {
      const key = addressKey(addr);
      if (errorNoticed.has(key)) continue;
      errorNoticed.add(key);
      enqueueDelivery(addr.channelId, async () => { await sendTo(addr, { kind: 'text', text: notice }); });
    }
    // A restart now must not tell them a second time.
    persistOrigins();
  } catch (err) {
    logError(`[agent] provider error dispatch failed: ${err}`);
  }
}

function deliver(origin: ChannelAddress, texts: string[]): void {
  enqueueDelivery(origin.channelId, async () => {
    if (texts.length === 0) {
      try { await getChannel(origin.channelId)?.turnFinished?.(origin); } catch {}
      return;
    }
    for (const text of texts) {
      const res = await sendTo(origin, { kind: 'text', text });
      if (!res.ok) break;
    }
  });
}

/** Tests only: resolves once every queued delivery has run. */
export async function _dispatchIdle(): Promise<void> {
  while (channelQueues.size) await Promise.all([...channelQueues.values()]);
}

function resetMemory(): void {
  cursor = null;
  primed = false;
  pendingOrigins.length = 0;
  carriedOrigins = [];
  lastTexts = [];
  channelQueues.clear();
  errorNoticed.clear();
  restored = [];
  restoredAt = 0;
  restoredFrom = null;
  lastPersisted = '';
  stopRestoreWatch();
}

/** Tests only: forget everything, on disk too. */
export function _resetDispatch(): void {
  resetMemory();
  resumeOffered = agentTurnOffered;
  channelPollMs = 1_000;
  try { inflightStore.set({ at: 0, pending: [], carried: [] }); } catch {}
  lastPersisted = JSON.stringify([[], []]);
}

/**
 * Tests only: what a bridge restart does to dispatch — memory gone, the file
 * kept. `resumeOffered` stands in for session/interrupted.ts's list (whether
 * the agent was mid-turn); `channelPollMs` for the channel wait.
 */
export function _simulateDispatchRestart(opts: { resumeOffered?: () => boolean; channelPollMs?: number } = {}): void {
  resetMemory();
  resumeOffered = opts.resumeOffered ?? agentTurnOffered;
  channelPollMs = opts.channelPollMs ?? 1_000;
}

/** Tests only: the restore watch's tick (`deadline`: the grace period is over). */
export function _tickRestoreWatch(deadline = false): void {
  settleRestored(deadline ? 'deadline' : 'tick');
}

/** Tests only: start the restore watch as the agent's start hook does. */
export function _startRestoreWatch(): void {
  startRestoreWatch();
}

/** Tests only: origins restored and still undecided. */
export function _restoredOrigins(): ChannelAddress[] {
  return restored.map(r => r.addr);
}
