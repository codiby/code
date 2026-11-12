/**
 * Agent registries — the single seam between the core bridge and the agent's
 * areas (channels, policy, memory, proactivity, Google, push, browser).
 *
 * Areas register at import time (see agent/index.ts); the bridge only calls
 * the `emit*` / `evaluate*` / `render*` functions below. Nothing in here knows
 * about any one area, so areas never import each other through the bridge.
 */

import { log, logError } from '../lib/logger';
import type { AgentConfig } from './config';
import type {
  AgentRoute,
  AgentToolGroup,
  ApprovalListener,
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  InboundEnvelope,
  PolicyEvaluator,
  PolicyRequest,
  PolicyVerdict,
  PromptSection,
} from './types';

/** Stops a listener registered with one of the `on*` functions below. */
export type Unsubscribe = () => void;

/**
 * Add `item` to `list`; the returned function takes it out again. Emitters
 * iterate over a copy, so a listener that unsubscribes itself mid-emit
 * doesn't make the loop skip its neighbour.
 */
function subscribe<T>(list: T[], item: T): Unsubscribe {
  list.push(item);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const i = list.indexOf(item);
    if (i >= 0) list.splice(i, 1);
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const routes: AgentRoute[] = [];

export function registerRoute(route: AgentRoute): void {
  if (!route.path.startsWith('/agent/')) throw new Error(`Agent routes live under /agent/: ${route.path}`);
  const dup = routes.find(r => r.method === route.method && r.path === route.path);
  if (dup) throw new Error(`Duplicate agent route ${route.method} ${route.path}`);
  routes.push(route);
}

export function registerRoutes(list: AgentRoute[]): void {
  for (const r of list) registerRoute(r);
}

/** Match `/agent/channels/abc/inbound` against `/agent/channels/:id/inbound`. */
export type RouteMatch =
  | { route: AgentRoute; params: Record<string, string> }
  | { methodNotAllowed: true };

export function matchRoute(method: string, pathname: string): RouteMatch | null {
  const parts = pathname.split('/').filter(Boolean);
  let pathMatched = false;
  for (const route of routes) {
    const pattern = route.path.split('/').filter(Boolean);
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      const seg = pattern[i]!;
      if (seg.startsWith(':')) {
        try { params[seg.slice(1)] = decodeURIComponent(parts[i]!); } catch { ok = false; break; }
      } else if (seg !== parts[i]) { ok = false; break; }
    }
    if (!ok) continue;
    pathMatched = true;
    if (route.method === method) return { route, params };
  }
  return pathMatched ? { methodNotAllowed: true } : null;
}

export function listRoutes(): readonly AgentRoute[] {
  return routes;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const toolGroups: AgentToolGroup[] = [];

export function registerToolGroup(group: AgentToolGroup): void {
  if (toolGroups.some(g => g.id === group.id)) throw new Error(`Duplicate agent tool group ${group.id}`);
  toolGroups.push(group);
}

export function listToolGroups(): readonly AgentToolGroup[] {
  return toolGroups;
}

// ---------------------------------------------------------------------------
// Prompt sections
// ---------------------------------------------------------------------------

const promptSections: PromptSection[] = [];

export function registerPromptSection(section: PromptSection): void {
  const i = promptSections.findIndex(s => s.id === section.id);
  if (i >= 0) promptSections[i] = section; else promptSections.push(section);
  promptSections.sort((a, b) => a.order - b.order);
}

export function listPromptSections(): readonly PromptSection[] {
  return promptSections;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

let policyEvaluator: PolicyEvaluator | null = null;

export function setPolicyEvaluator(fn: PolicyEvaluator | null): void {
  policyEvaluator = fn;
}

/** Called by provider/bridge.ts for every permission decision. Never throws. */
export function evaluateAgentPolicy(req: PolicyRequest): PolicyVerdict | null {
  if (!policyEvaluator) return null;
  try {
    return policyEvaluator(req);
  } catch (err) {
    logError(`[agent] policy evaluator threw for ${req.toolName}: ${err}`);
    // Fail closed for real decisions, open for cosmetic previews.
    return req.phase === 'decide' ? { action: 'ask', reason: 'Policy error — asking instead' } : null;
  }
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

const approvalListeners: ApprovalListener[] = [];

export function onApproval(listener: ApprovalListener): Unsubscribe {
  return subscribe(approvalListeners, listener);
}

export function emitApprovalRequested(event: ApprovalRequestedEvent): void {
  for (const l of [...approvalListeners]) {
    try { l.onRequested?.(event); } catch (err) { logError(`[agent] approval listener (requested) threw: ${err}`); }
  }
}

export function emitApprovalResolved(event: ApprovalResolvedEvent): void {
  for (const l of [...approvalListeners]) {
    try { l.onResolved?.(event); } catch (err) { logError(`[agent] approval listener (resolved) threw: ${err}`); }
  }
}

/**
 * Answering an approval from a channel. Channels (Telegram buttons, a
 * WhatsApp "SI 4821", a push action) call `answerApproval`; the policy area
 * installs the implementation that maps codes to requests and settles them.
 */
export interface ApprovalAnswer {
  requestId?: string;
  /** Short code shown on channels without buttons. */
  code?: string;
  allow: boolean;
  /** Surface that answered: 'telegram', 'whatsapp', 'push'… */
  via: string;
  /** Channel a code was typed on: it then answers only a request that reached that channel. */
  channelId?: string;
}
export type ApprovalAnswerer = (answer: ApprovalAnswer) => Promise<{ ok: boolean; requestId?: string; error?: string }>;

let approvalAnswerer: ApprovalAnswerer | null = null;

export function setApprovalAnswerer(fn: ApprovalAnswerer | null): void {
  approvalAnswerer = fn;
}

export async function answerApproval(answer: ApprovalAnswer): Promise<{ ok: boolean; requestId?: string; error?: string }> {
  if (!approvalAnswerer) return { ok: false, error: 'Approvals are not available yet' };
  try {
    return await approvalAnswerer(answer);
  } catch (err) {
    logError(`[agent] approval answerer threw: ${err}`);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Owner notifications (notify_user, reminders) — push listens here
// ---------------------------------------------------------------------------

export interface OwnerNotification {
  text: string;
  title?: string;
  priority: 'low' | 'normal' | 'urgent';
  /** Session that raised it (the agent, or any coding session via notify_user). */
  sessionId: string;
  sessionName: string;
  /** True when quiet hours are on and the notification is not urgent (push should be silent). */
  quiet: boolean;
}

type OwnerNotificationListener = (n: OwnerNotification) => void;
const ownerNotificationListeners: OwnerNotificationListener[] = [];

export function onOwnerNotification(fn: OwnerNotificationListener): Unsubscribe { return subscribe(ownerNotificationListeners, fn); }
export function emitOwnerNotification(n: OwnerNotification): void {
  for (const fn of [...ownerNotificationListeners]) {
    try { fn(n); } catch (err) { logError(`[agent] owner-notification listener threw: ${err}`); }
  }
}

// ---------------------------------------------------------------------------
// Thread rotation (`/new`)
// ---------------------------------------------------------------------------

type RotateHook = (info: { reason: string }) => Promise<void> | void;
const beforeRotateHooks: RotateHook[] = [];

/** Runs before the agent's conversation is rotated (memory consolidation). */
export function onBeforeThreadRotate(fn: RotateHook): Unsubscribe { return subscribe(beforeRotateHooks, fn); }
export async function runBeforeThreadRotate(info: { reason: string }): Promise<void> {
  for (const fn of [...beforeRotateHooks]) {
    try { await fn(info); } catch (err) { logError(`[agent] before-rotate hook threw: ${err}`); }
  }
}

// ---------------------------------------------------------------------------
// Turn / tool / inbound listeners
// ---------------------------------------------------------------------------

/** `failure`: the provider failed the turn (its error, as relayed to the channels in a Codiby notice). */
type TurnListener = (sessionId: string, delivered: { texts: string[]; failure?: string }) => void;
type ToolUseListener = (sessionId: string, toolName: string, summary: string) => void;
type UntrustedListener = (envelope: InboundEnvelope) => void;
type InboundInterceptor = (envelope: InboundEnvelope) => Promise<boolean> | boolean;

const turnListeners: TurnListener[] = [];
const toolUseListeners: ToolUseListener[] = [];
const untrustedListeners: UntrustedListener[] = [];
const inboundInterceptors: InboundInterceptor[] = [];

/** After the agent's turn completes and replies were dispatched. */
export function onAgentTurnComplete(fn: TurnListener): Unsubscribe { return subscribe(turnListeners, fn); }
export function emitAgentTurnComplete(sessionId: string, delivered: { texts: string[]; failure?: string }): void {
  for (const fn of [...turnListeners]) {
    try { fn(sessionId, delivered); } catch (err) { logError(`[agent] turn listener threw: ${err}`); }
  }
}

/** Each tool call the agent starts (channels show progress in a working message). */
export function onAgentToolUse(fn: ToolUseListener): Unsubscribe { return subscribe(toolUseListeners, fn); }
export function emitAgentToolUse(sessionId: string, toolName: string, summary: string): void {
  for (const fn of [...toolUseListeners]) {
    try { fn(sessionId, toolName, summary); } catch (err) { logError(`[agent] tool-use listener threw: ${err}`); }
  }
}

/** A message from someone other than the owner was stored (never sent to the agent). */
export function onUntrustedInbound(fn: UntrustedListener): Unsubscribe { return subscribe(untrustedListeners, fn); }
export function emitUntrustedInbound(envelope: InboundEnvelope): void {
  for (const fn of [...untrustedListeners]) {
    try { fn(envelope); } catch (err) { logError(`[agent] untrusted listener threw: ${err}`); }
  }
}

/**
 * Runs before a trusted message reaches the agent. Return true to consume it
 * (slash commands like `/new`, approval codes like "SI 4821").
 */
export function addInboundInterceptor(fn: InboundInterceptor): Unsubscribe { return subscribe(inboundInterceptors, fn); }
export async function runInboundInterceptors(envelope: InboundEnvelope): Promise<boolean> {
  for (const fn of [...inboundInterceptors]) {
    try {
      if (await fn(envelope)) return true;
    } catch (err) {
      logError(`[agent] inbound interceptor threw: ${err}`);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Config changes (PUT /agent/config)
// ---------------------------------------------------------------------------

type ConfigListener = (next: AgentConfig, prev: AgentConfig) => void;
const configListeners: ConfigListener[] = [];

/**
 * After the owner saves the agent's config from the Agent view (timezone,
 * quiet hours, owners…) — areas that derived schedules from it re-sync here.
 * Runs after the enable/disable start/stop hooks of the same save.
 */
export function onAgentConfigChanged(fn: ConfigListener): Unsubscribe { return subscribe(configListeners, fn); }
export function emitAgentConfigChanged(next: AgentConfig, prev: AgentConfig): void {
  for (const fn of [...configListeners]) {
    try { fn(next, prev); } catch (err) { logError(`[agent] config listener threw: ${err}`); }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

type Hook = { id: string; fn: () => Promise<void> | void };
const startHooks: Hook[] = [];
const stopHooks: Hook[] = [];

/** Runs once the agent runtime is configured and enabled. */
export function onAgentStart(id: string, fn: () => Promise<void> | void): Unsubscribe {
  return subscribe(startHooks, { id, fn });
}

export function onAgentStop(id: string, fn: () => Promise<void> | void): Unsubscribe {
  return subscribe(stopHooks, { id, fn });
}

async function startAll(): Promise<void> {
  for (const h of [...startHooks]) {
    try {
      await h.fn();
    } catch (err) {
      logError(`[agent] start hook "${h.id}" failed: ${err instanceof Error ? err.stack || err.message : err}`);
    }
  }
  if (startHooks.length) log(`[agent] ran ${startHooks.length} start hook(s)`);
}

async function stopAll(): Promise<void> {
  for (const h of [...stopHooks].reverse()) {
    try { await h.fn(); } catch (err) { logError(`[agent] stop hook "${h.id}" failed: ${err}`); }
  }
}

export interface AgentLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Run start or stop so the areas match `enabled()`, read when this call's
   * turn comes rather than when it was made: a burst of saves (on, off, on)
   * ends where the last one left the config and never repeats a transition.
   */
  sync(enabled: () => boolean, beforeStart?: () => void): Promise<void>;
  isUp(): boolean;
}

/**
 * Start and stop run one after the other, never interleaved. A disable saved
 * while a slow start hook is still awaiting (a Telegram bot's getMe) used to
 * run every stop hook at once, and then the start hooks still to come armed
 * their timers — heartbeat reconcile, daily rotation, activity pruning — on
 * an agent that was off. Exported for tests; the agent uses the one below.
 */
export function createAgentLifecycle(runStart: () => Promise<void>, runStop: () => Promise<void>): AgentLifecycle {
  let up = false;
  let queue: Promise<void> = Promise.resolve();
  const serial = (fn: () => Promise<void>): Promise<void> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };
  return {
    start: () => serial(async () => { up = true; await runStart(); }),
    stop: () => serial(async () => { up = false; await runStop(); }),
    sync: (enabled, beforeStart) => serial(async () => {
      const want = enabled();
      if (want === up) return;
      up = want;
      if (want) {
        beforeStart?.();
        await runStart();
      } else {
        await runStop();
      }
    }),
    isUp: () => up,
  };
}

const lifecycle = createAgentLifecycle(startAll, stopAll);

export function runStartHooks(): Promise<void> {
  return lifecycle.start();
}

export function runStopHooks(): Promise<void> {
  return lifecycle.stop();
}

/** After `enabled` changed (PUT /agent/config, boot): start or stop the areas to match it. */
export function syncAgentLifecycle(enabled: () => boolean, beforeStart?: () => void): Promise<void> {
  return lifecycle.sync(enabled, beforeStart);
}
