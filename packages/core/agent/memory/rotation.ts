/**
 * Fresh threads: the daily rotation and "Start a fresh thread now".
 *
 * A long-lived agent thread gets compacted over and over and drifts; memory is
 * what carries over. Once a day (04:00 in the owner's timezone by default) the
 * thread is rotated — but only once the owner has been quiet for two hours, so
 * it never cuts a conversation in half. If they're active at that time, the
 * rotation waits for the quiet instead of being skipped.
 */

import { log, logError } from '../../lib/logger';
import { getSessionState } from '../../session/state';
import { loadAgentConfig } from '../config';
import { ROTATION_HOLD_MAX_MS } from '../inbound';
import { AGENT_SESSION_ID, agentRotation, rotateAgentThread } from '../session';
import { hasConversationSince, isConsolidating, lastAgentActivityAt } from './consolidation';
import { loadMemorySettings, memoryStateStore, type MemorySettings } from './settings';
import { latestSlot, nextSlot, safeTimeZone } from './tz';

export const IDLE_BEFORE_ROTATION_MS = 2 * 60 * 60_000;
/** Wake at least hourly, so a timezone or settings change is picked up without a restart. */
const MAX_SLEEP_MS = 60 * 60_000;
/** Mid-turn or waiting on an approval: look again in a bit. */
const BUSY_RETRY_MS = 15 * 60_000;
/** Give the bridge a moment after boot before the first check. */
const FIRST_CHECK_DELAY_MS = 30_000;

export const DAILY_ROTATION_REASON = 'Daily fresh start';
export const MANUAL_ROTATION_REASON = 'Fresh start from the Agent view';

export type DailyPlan =
  | { action: 'disabled'; wakeAt: number }
  /** First run on this host: remember the current slot instead of rotating right away. */
  | { action: 'baseline'; slot: number; wakeAt: number }
  | { action: 'wait'; wakeAt: number }
  | { action: 'defer'; slot: number; wakeAt: number; why: 'busy' | 'active' }
  | { action: 'skip'; slot: number; wakeAt: number }
  | { action: 'rotate'; slot: number };

export interface PlanInput {
  now: number;
  settings: MemorySettings;
  timezone: string;
  lastDailySlot: number | null;
  lastActivityAt: number;
  /** Mid-turn, waiting on an approval, or another rotation running. */
  busy: boolean;
  /** Conversation since the last rotation. */
  hasNew: boolean;
}

/** What the daily rotation should do at `now`. Pure, for tests. */
export function planDailyRotation(input: PlanInput): DailyPlan {
  const { now, settings } = input;
  const cap = (t: number) => Math.min(t, now + MAX_SLEEP_MS);
  if (!settings.dailyRotation.enabled) return { action: 'disabled', wakeAt: now + MAX_SLEEP_MS };
  const tz = safeTimeZone(input.timezone);
  const { time } = settings.dailyRotation;
  const slot = latestSlot(now, time, tz);
  const next = nextSlot(now, time, tz);
  if (input.lastDailySlot === null) return { action: 'baseline', slot, wakeAt: cap(next) };
  if (slot <= input.lastDailySlot) return { action: 'wait', wakeAt: cap(next) };
  if (input.busy) return { action: 'defer', slot, why: 'busy', wakeAt: now + BUSY_RETRY_MS };
  const quietAt = input.lastActivityAt + IDLE_BEFORE_ROTATION_MS;
  if (now < quietAt) return { action: 'defer', slot, why: 'active', wakeAt: cap(quietAt + 60_000) };
  if (!input.hasNew) return { action: 'skip', slot, wakeAt: cap(next) };
  return { action: 'rotate', slot };
}

// ---------------------------------------------------------------------------
// Rotation in progress (shared by the daily timer and the button)
// ---------------------------------------------------------------------------

let rotation: Promise<void> | null = null;

export function isRotating(): boolean {
  return rotation !== null || isConsolidating();
}

function runRotation(reason: string): Promise<void> {
  rotation = rotateAgentThread(reason).finally(() => { rotation = null; });
  return rotation;
}

/** POST /agent/memory/rotate — starts in the background (consolidation can take minutes). */
export function rotateNow(reason = MANUAL_ROTATION_REASON): { started: boolean } {
  if (isRotating()) return { started: false };
  void runRotation(reason).catch(err => logError(`[agent:memory] rotation failed: ${err instanceof Error ? err.message : err}`));
  return { started: true };
}

// ---------------------------------------------------------------------------
// Owner messages that arrive mid-rotation
// ---------------------------------------------------------------------------

/**
 * Commands and approval answers other areas consume themselves ("/new",
 * "SI 4821") must not wait: an approval reply may be what the consolidation
 * turn itself is waiting for.
 */
export function isControlMessage(text: string): boolean {
  const t = text.trim();
  return t.startsWith('/') || /^(s[ií]|no|yes|y|n|ok)\s+\d{3,8}$/i.test(t);
}

/**
 * "/new" followed straight away by "hola": the second message must go to the
 * fresh thread. Sent during consolidation it would be answered in the thread
 * that's about to close — and the rotation would cut that answer off.
 *
 * The session's rotation promise spans all of it — the consolidation turn
 * (a before-rotate hook) and the thread reset after it — so awaiting it is
 * exactly "until the fresh thread exists". Bounded like inbound.ts's own
 * wait, so a provider whose close() hangs can't swallow the owner's messages.
 */
export async function holdWhileRotating(text: string): Promise<void> {
  if (isControlMessage(text)) return;
  const pending = agentRotation() ?? rotation;
  if (!pending) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>(resolve => { timer = setTimeout(resolve, ROTATION_HOLD_MAX_MS); });
  try {
    await Promise.race([pending.catch(() => {}), cap]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The daily timer
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null;
let active = false;
let ticking = false;

function isBusy(): boolean {
  const s = getSessionState(AGENT_SESSION_ID);
  return s.isStreaming || !!s.permRequest || isRotating();
}

function currentPlan(now: number): DailyPlan {
  const state = memoryStateStore.get();
  return planDailyRotation({
    now,
    settings: loadMemorySettings(),
    timezone: loadAgentConfig().persona.timezone,
    lastDailySlot: state.lastDailySlot,
    lastActivityAt: lastAgentActivityAt(),
    busy: isBusy(),
    hasNew: hasConversationSince(state.lastRotatedAt),
  });
}

/** One check of the daily rotation; returns what it decided. Exported for tests. */
export async function runDailyCheck(now = Date.now()): Promise<DailyPlan> {
  const plan = currentPlan(now);
  switch (plan.action) {
    case 'baseline':
    case 'skip':
      memoryStateStore.update(s => ({ ...s, lastDailySlot: plan.slot }));
      if (plan.action === 'skip') log('[agent:memory] Daily fresh start skipped — nothing new since the last one');
      break;
    case 'rotate':
      // Mark the slot first: if the rotation throws, retrying every few minutes would spam the agent.
      memoryStateStore.update(s => ({ ...s, lastDailySlot: plan.slot }));
      await runRotation(DAILY_ROTATION_REASON);
      break;
    default:
      break;
  }
  return plan;
}

function schedule(at: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tick(), Math.max(1_000, at - Date.now()));
  (timer as { unref?: () => void }).unref?.();
}

async function tick(): Promise<void> {
  if (!active || ticking) return;
  ticking = true;
  let wakeAt = Date.now() + BUSY_RETRY_MS;
  try {
    const plan = await runDailyCheck();
    wakeAt = 'wakeAt' in plan ? plan.wakeAt : Date.now() + 60_000;
  } catch (err) {
    logError(`[agent:memory] daily rotation check failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    ticking = false;
    if (active) schedule(wakeAt);
  }
}

export function startDailyRotation(): void {
  active = true;
  schedule(Date.now() + FIRST_CHECK_DELAY_MS);
}

export function stopDailyRotation(): void {
  active = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

/**
 * After a settings change. Turning the rotation on (or moving its time)
 * starts counting from the next slot, so saving the form at 3 pm doesn't
 * rotate the thread on the spot.
 */
export function onRotationSettingsChanged(before: MemorySettings, after: MemorySettings, now = Date.now()): void {
  const turnedOn = !before.dailyRotation.enabled && after.dailyRotation.enabled;
  const moved = before.dailyRotation.time !== after.dailyRotation.time;
  if (after.dailyRotation.enabled && (turnedOn || moved)) {
    const tz = safeTimeZone(loadAgentConfig().persona.timezone);
    memoryStateStore.update(s => ({ ...s, lastDailySlot: latestSlot(now, after.dailyRotation.time, tz) }));
  }
  if (active) schedule(Date.now() + 1_000);
}

/** For the Agent view: when the next daily fresh start is due, and whether one is overdue (waiting for quiet). */
export function dailyRotationStatus(now = Date.now()): { nextAt: number | null; waitingForQuiet: boolean; timezone: string } {
  const settings = loadMemorySettings();
  const tz = safeTimeZone(loadAgentConfig().persona.timezone);
  if (!settings.dailyRotation.enabled) return { nextAt: null, waitingForQuiet: false, timezone: tz };
  const last = memoryStateStore.get().lastDailySlot;
  const slot = latestSlot(now, settings.dailyRotation.time, tz);
  const overdue = last !== null && slot > last;
  return { nextAt: overdue ? null : nextSlot(now, settings.dailyRotation.time, tz), waitingForQuiet: overdue, timezone: tz };
}
