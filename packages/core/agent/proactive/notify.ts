/**
 * Reaching the owner unprompted — the one path behind `notify_user`,
 * reminders and the heartbeat.
 *
 * Quiet hours (agent config, persona.timezone) shape delivery:
 *   - urgent  → every connected channel, push rings.
 *   - normal  → chat channels get it as a silent message (priority 'low'),
 *               push is flagged quiet.
 *   - low     → held until quiet hours end, then delivered. The held queue
 *               lives on disk (held-store.ts): an agent stop only drops the
 *               timer, and the next start restores the queue and re-arms it
 *               — delivering at once what is already overdue.
 * Heartbeat-originated messages count against the heartbeat's daily cap once
 * a chat channel actually took them; held and in-flight ones keep their
 * place in it meanwhile.
 */

import { randomUUID } from 'crypto';
import { log, logError } from '../../lib/logger';
import { isAgentEnabled, loadAgentConfig } from '../config';
import { ownerTargets, sendToOwner } from '../outbox';
import { emitOwnerNotification, onAgentStart } from '../registry';
import { AGENT_SESSION_ID } from '../session';
import type { OutboundPriority } from '../types';
import { heldStore, type HeldNotification } from './held-store';
import { heartbeatMessagesToday, loadHeartbeatConfig, recordHeartbeatMessage } from './settings';
import { isQuietTime, quietEndsAt } from './time';

/** What raised the notification. Only 'heartbeat' is capped per day. */
export type NotifyOrigin = 'tool' | 'heartbeat' | 'brief' | 'reminder';

export interface NotifyRequest {
  text: string;
  title?: string;
  priority?: OutboundPriority;
  /** Deliver on this channel when it can reach the owner; otherwise the usual routing. */
  channelId?: string | null;
  sessionId: string;
  sessionName: string;
  origin?: NotifyOrigin;
}

export interface NotifyResult {
  /**
   * delivered — at least one chat channel took it · queued — held for the end
   * of quiet hours · push_only — no chat channel reached the owner (push was
   * still raised) · limited — the heartbeat's daily cap stopped it.
   */
  status: 'delivered' | 'queued' | 'push_only' | 'limited';
  deliveredTo: string[];
  quiet: boolean;
  priority: OutboundPriority;
  queuedUntil?: number;
  error?: string;
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let now = () => Date.now();
/** Held notifications a flush is delivering right now (a concurrent flush skips them). */
const delivering = new Set<string>();
/** Heartbeat messages on their way out: not counted yet, but they hold a place under the cap. */
let heartbeatSending = 0;
/**
 * When held notifications fell due with no channel able to reach the owner
 * (just after a start, the channels are still connecting). They wait up to
 * CHANNEL_WAIT_MS for one, then go out anyway — push still rings.
 */
let channelWaitSince: number | null = null;
const CHANNEL_WAIT_MS = 5 * 60_000;
const CHANNEL_RETRY_MS = 15_000;

/** Tests only: freeze the clock the quiet-hours logic reads. */
export function _setNotifyClock(fn: (() => number) | null): void {
  now = fn ?? (() => Date.now());
}

/** Other sessions' messages say who sent them; the agent speaks as itself. */
export function composeNotification(req: Pick<NotifyRequest, 'text' | 'title' | 'sessionId' | 'sessionName'>): string {
  const lines: string[] = [];
  const from = req.sessionId !== AGENT_SESSION_ID ? `[${req.sessionName.trim() || 'A session'}] ` : '';
  if (req.title?.trim()) {
    lines.push(`${from}**${req.title.trim()}**`, req.text.trim());
  } else {
    lines.push(`${from}${req.text.trim()}`);
  }
  return lines.join('\n');
}

async function deliver(req: NotifyRequest, body: string, quiet: boolean): Promise<NotifyResult> {
  const priority = req.priority ?? 'normal';
  // Channels render priority 'low' as a silent message (no sound or buzz).
  const wire: OutboundPriority = quiet ? 'low' : priority;
  const all = priority === 'urgent';
  let res = await sendToOwner({ kind: 'text', text: body, priority: wire }, { channelId: req.channelId ?? null, all });
  if (!res.ok && req.channelId) {
    // The requested channel is down: reaching the owner matters more than the route.
    res = await sendToOwner({ kind: 'text', text: body, priority: wire }, { all });
  }
  emitOwnerNotification({
    text: req.text.trim(),
    title: req.title?.trim() || (req.sessionId !== AGENT_SESSION_ID ? req.sessionName : undefined),
    priority,
    sessionId: req.sessionId,
    sessionName: req.sessionName,
    quiet,
  });
  if (res.ok) return { status: 'delivered', deliveredTo: res.deliveredTo, quiet, priority };
  return {
    status: 'push_only',
    deliveredTo: [],
    quiet,
    priority,
    error: res.error || 'No connected channel could reach the owner',
  };
}

export async function notifyOwner(req: NotifyRequest): Promise<NotifyResult> {
  const priority = req.priority ?? 'normal';
  const cfg = loadAgentConfig();
  const tz = cfg.persona.timezone;
  const at = now();
  const quiet = priority !== 'urgent' && isQuietTime(cfg.quietHours, tz, at);

  if (req.origin === 'heartbeat' && priority !== 'urgent') {
    const max = loadHeartbeatConfig().maxMessagesPerDay;
    const { sent } = heartbeatMessagesToday(tz, at);
    const pending = heldHeartbeatCount() + heartbeatSending;
    if (sent + pending >= max) {
      const waiting = pending ? ` (${pending} more ${pending === 1 ? 'is' : 'are'} waiting to go out)` : '';
      return {
        status: 'limited',
        deliveredTo: [],
        quiet,
        priority,
        error: `The heartbeat already sent ${sent} of its ${max} messages today${waiting}; this one was not sent. Use priority "urgent" only if it truly cannot wait until tomorrow.`,
      };
    }
  }

  const body = composeNotification(req);
  if (quiet && priority === 'low') {
    const until = quietEndsAt(cfg.quietHours, tz, at) ?? at;
    try {
      heldStore.update(items => [...items, { id: randomUUID(), req: { ...req, priority }, body, heldAt: at, until }]);
      armFlush(until);
      log(`[agent] low-priority notification held until ${new Date(until).toISOString()} (quiet hours)`);
      return { status: 'queued', deliveredTo: [], quiet: true, priority, queuedUntil: until };
    } catch (err) {
      // Not held if it can't be kept: it goes now, silently, rather than nowhere.
      logError(`[agent] could not hold a notification for the end of quiet hours: ${err}`);
    }
  }
  return deliverCounted({ ...req, priority }, body, quiet);
}

function heldHeartbeatCount(): number {
  return heldStore.get().filter(h => h.req.origin === 'heartbeat').length;
}

/** deliver(), and a heartbeat message counted against today's cap only once a chat channel took it. */
async function deliverCounted(req: NotifyRequest, body: string, quiet: boolean): Promise<NotifyResult> {
  const heartbeat = req.origin === 'heartbeat';
  if (heartbeat) heartbeatSending++;
  try {
    const res = await deliver(req, body, quiet);
    if (heartbeat && res.status === 'delivered') recordHeartbeatMessage(loadAgentConfig().persona.timezone, now());
    return res;
  } finally {
    if (heartbeat) heartbeatSending--;
  }
}

function armFlush(until: number): void {
  if (flushTimer) clearTimeout(flushTimer);
  // Quiet hours never span more than a day, well inside setTimeout's range.
  flushTimer = setTimeout(() => {
    flushQueuedNotifications({ waitForChannel: true }).catch(err => logError(`[agent] held notifications flush failed: ${err}`));
  }, Math.max(0, until - now()) + 1_000);
}

/**
 * Send what quiet hours held back: everything once they are over, and
 * anything whose end time already passed while they are on again (the
 * bridge was down through it — it goes out silently). The rest is re-timed
 * to the current window's end (it may have moved) and re-armed.
 *
 * `waitForChannel` (the timer): when no channel can reach the owner yet,
 * try again shortly for up to CHANNEL_WAIT_MS before delivering anyway.
 * Each notification leaves the file once delivered, so a restart mid-flush
 * resends nothing and loses nothing.
 */
export async function flushQueuedNotifications(opts: { waitForChannel?: boolean } = {}): Promise<NotifyResult[]> {
  // Called early too (a quiet-hours edit): drop the armed timer rather than
  // just forgetting it, or it fires later still and stop can't clear it.
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const items = heldStore.get().filter(h => !delivering.has(h.id));
  if (!items.length) return [];
  const cfg = loadAgentConfig();
  const tz = cfg.persona.timezone;
  const at = now();
  const quiet = isQuietTime(cfg.quietHours, tz, at);
  const due = items.filter(h => !quiet || h.until <= at);
  const held = items.filter(h => quiet && h.until > at);
  let next: number | null = null;
  if (held.length) {
    const end = quietEndsAt(cfg.quietHours, tz, at) ?? at;
    const ids = new Set(held.map(h => h.id));
    if (held.some(h => h.until !== end)) heldStore.update(all => all.map(h => (ids.has(h.id) ? { ...h, until: end } : h)));
    next = end;
  }
  if (due.length && opts.waitForChannel && isAgentEnabled() && ownerTargets().length === 0) {
    channelWaitSince ??= at;
    if (at - channelWaitSince < CHANNEL_WAIT_MS) {
      armFlush(Math.min(next ?? Infinity, at + CHANNEL_RETRY_MS - 1_000));
      return [];
    }
  }
  channelWaitSince = null;
  if (next !== null) armFlush(next);

  const results: NotifyResult[] = [];
  for (const item of due) {
    delivering.add(item.id);
    try {
      results.push(await deliverCounted(item.req, item.body, quiet));
    } catch (err) {
      logError(`[agent] queued notification failed: ${err}`);
    } finally {
      delivering.delete(item.id);
      try {
        heldStore.update(all => all.filter(h => h.id !== item.id));
      } catch (err) {
        logError(`[agent] could not update the held notifications file: ${err}`);
      }
    }
  }
  return results;
}

export function queuedNotificationCount(): number {
  return heldStore.get().length;
}

/** What is held, oldest first (status views, tests). */
export function heldNotifications(): readonly HeldNotification[] {
  return heldStore.get();
}

/**
 * Agent stopped: drop the timer only. What quiet hours hold stays on disk;
 * the next start restores it (restoreHeldNotifications).
 */
export function clearNotificationQueue(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  channelWaitSince = null;
}

/**
 * Agent start (and bridge boot, through it): read the held queue back from
 * disk and arm its delivery for the earliest end time — at once for what is
 * already overdue. Returns how many are held.
 */
export function restoreHeldNotifications(): number {
  const items = heldStore.reload();
  if (!items.length) return 0;
  const next = Math.min(...items.map(h => h.until));
  armFlush(next);
  log(`[agent] ${items.length} held notification(s) restored; next delivery at ${new Date(Math.max(next, now())).toISOString()}`);
  return items.length;
}

onAgentStart('notify', () => { restoreHeldNotifications(); });

/** Tests only: drop the timer and everything held, on disk too. */
export function _resetNotificationQueue(): void {
  clearNotificationQueue();
  delivering.clear();
  heartbeatSending = 0;
  heldStore.set([]);
}
