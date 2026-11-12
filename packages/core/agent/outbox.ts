/**
 * Outbox — channel adapters, delivery with retries, and the delivery log.
 *
 * `sendTo` delivers to one address; `sendToOwner` picks the owner's channel
 * (explicit → preferred → last used → first connected). Every attempt is
 * recorded in `agent_messages` so the Agent view can show what went out and
 * what failed.
 */

import { randomUUID } from 'crypto';
import { desc, eq } from 'drizzle-orm';
import { database } from '../database';
import { agentMessages } from '../database/schema';
import { log, logError } from '../lib/logger';
import { loadAgentConfig } from './config';
import { formatForChannel, splitText } from './format';
import type { ChannelAdapter, ChannelAddress, OutboundMessage } from './types';

const adapters = new Map<string, ChannelAdapter>();

export function registerChannel(adapter: ChannelAdapter): void {
  adapters.set(adapter.id, adapter);
}

export function unregisterChannel(id: string): void {
  adapters.delete(id);
}

export function getChannel(id: string): ChannelAdapter | null {
  return adapters.get(id) ?? null;
}

export function listChannels(): ChannelAdapter[] {
  return [...adapters.values()];
}

// ---------------------------------------------------------------------------
// Last channel the owner wrote from — the default target for proactive sends.
// ---------------------------------------------------------------------------

let lastOwnerAddress: ChannelAddress | null = null;

export function rememberOwnerAddress(addr: ChannelAddress): void {
  lastOwnerAddress = { channelId: addr.channelId, channelType: addr.channelType, peer: addr.peer, peerName: addr.peerName };
}

export function getLastOwnerAddress(): ChannelAddress | null {
  return lastOwnerAddress;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

const RETRY_DELAYS_MS = [1_000, 4_000, 15_000];
/**
 * Longest wait a platform's "retry after" may impose on one attempt. Telegram
 * asks for seconds when a bot floods a chat; a minutes-long ban is better
 * reported as a failure (and the next channel tried) than waited out.
 */
export const MAX_RETRY_AFTER_MS = 120_000;

let sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
/** Tests only. */
export function _setOutboxSleep(fn: (ms: number) => Promise<void>): void { sleep = fn; }

/**
 * How long the platform asked us to wait before retrying, in ms — from an
 * adapter error's `retryAfter` (seconds; Telegram's 429 `parameters.retry_after`
 * travels on TelegramApiError). Null when the error doesn't say.
 */
export function retryAfterMs(err: unknown): number | null {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    const seconds = (e as { retryAfter?: unknown }).retryAfter;
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(seconds * 1000));
    }
  }
  return null;
}

export interface DeliveryResult {
  ok: boolean;
  error?: string;
  externalIds: string[];
  /** Delivered as far as we can tell, but at least one piece's fate is unknown (see SendResult.unconfirmed). */
  unconfirmed?: true;
}

function logRow(addr: ChannelAddress, msg: OutboundMessage, trusted: boolean) {
  const now = Date.now();
  const id = randomUUID();
  try {
    database.insert(agentMessages).values({
      id,
      direction: 'out',
      channelId: addr.channelId,
      channelType: addr.channelType,
      peer: addr.peer,
      peerName: addr.peerName ?? null,
      trusted,
      kind: msg.kind,
      text: msg.text.slice(0, 20_000),
      media: JSON.stringify((msg.files ?? []).map(f => ({ kind: 'file', mime: f.mime ?? '', path: f.path, name: f.name ?? null }))),
      status: 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    }).run();
  } catch (err) {
    logError(`[agent] could not log outbound message: ${err}`);
  }
  return {
    update(fields: Partial<typeof agentMessages.$inferInsert>) {
      try {
        database.update(agentMessages).set({ ...fields, updatedAt: Date.now() }).where(eq(agentMessages.id, id)).run();
      } catch {}
    },
  };
}

function isOwnerAddress(addr: ChannelAddress): boolean {
  const owner = getChannel(addr.channelId)?.ownerAddress();
  return !!owner && owner.peer === addr.peer;
}

/**
 * Deliver one message. Text is converted to the channel's markup and split to
 * its size limit; each piece is retried with backoff. Approval and file
 * messages are sent as a single unit (the adapter renders them).
 */
export async function sendTo(addr: ChannelAddress, msg: OutboundMessage): Promise<DeliveryResult> {
  const adapter = getChannel(addr.channelId);
  if (!adapter) return { ok: false, error: `Unknown channel ${addr.channelId}`, externalIds: [] };
  const row = logRow(addr, msg, isOwnerAddress(addr));

  const pieces: OutboundMessage[] = msg.kind === 'text'
    ? splitText(formatForChannel(msg.text, adapter.capabilities.markup), adapter.capabilities.maxLength)
        .map(text => ({ ...msg, text }))
    : [{ ...msg, text: formatForChannel(msg.text, adapter.capabilities.markup) }];
  if (pieces.length === 0) {
    row.update({ status: 'sent' });
    return { ok: true, externalIds: [] };
  }

  const externalIds: string[] = [];
  let attempts = 0;
  let unconfirmed = false;
  for (const piece of pieces) {
    let lastErr: unknown = null;
    let sent = false;
    for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
      // Looked up again for every attempt: a backoff (up to minutes on a
      // rate limit) can outlive the adapter. Disabling the agent stops its
      // channels, and the reply must not go out afterwards through the
      // stopped one; a channel restarted with new settings takes over.
      const current = getChannel(addr.channelId);
      if (!current) {
        lastErr = new Error(`${adapter.name} stopped before the message could be delivered`);
        break;
      }
      attempts++;
      try {
        const res = await current.send(addr, piece);
        if (res.externalId) externalIds.push(res.externalId);
        if (res.unconfirmed) unconfirmed = true;
        sent = true;
        break;
      } catch (err) {
        lastErr = err;
        if (i < RETRY_DELAYS_MS.length) {
          // Only this delivery waits: other channels' sends (and dispatch,
          // which queues per channel) carry on meanwhile.
          const asked = retryAfterMs(err);
          if (asked !== null) log(`[agent] ${adapter.name} asked to retry in ${Math.round(asked / 1000)}s`);
          await sleep(asked ?? RETRY_DELAYS_MS[i]!);
        }
      }
    }
    if (!sent) {
      const error = lastErr instanceof Error ? lastErr.message : String(lastErr);
      row.update({ status: 'failed', attempts, error: error.slice(0, 2000) });
      logError(`[agent] delivery to ${adapter.name} failed after ${attempts} attempts: ${error}`);
      return { ok: false, error, externalIds };
    }
  }
  // An unconfirmed piece is not counted as a failure (the owner may well
  // have it), but the log must not claim it arrived.
  row.update({ status: unconfirmed ? 'unconfirmed' : 'sent', attempts, externalId: externalIds[0] ?? null });
  return unconfirmed ? { ok: true, externalIds, unconfirmed: true } : { ok: true, externalIds };
}

/** Channels that can reach the owner right now, best first. */
export function ownerTargets(channelId?: string | null): ChannelAddress[] {
  const out: ChannelAddress[] = [];
  const push = (addr: ChannelAddress | null | undefined) => {
    if (!addr) return;
    if (out.some(a => a.channelId === addr.channelId && a.peer === addr.peer)) return;
    out.push(addr);
  };
  const ownerOf = (id: string | null | undefined) => {
    if (!id) return null;
    const ch = getChannel(id);
    return ch && ch.status().connected ? ch.ownerAddress() : null;
  };
  if (channelId) return ownerOf(channelId) ? [ownerOf(channelId)!] : [];
  push(ownerOf(loadAgentConfig().preferredChannel));
  // The channel the owner wrote from last ranks next — but only through the
  // owner address that channel itself vouches for. The peer an inbound
  // message came from isn't always a place to write to later: a webhook or
  // Shortcut "peer" names one HTTP request that was answered long ago.
  if (lastOwnerAddress) {
    const owner = ownerOf(lastOwnerAddress.channelId);
    if (owner && owner.peer === lastOwnerAddress.peer) push(owner);
  }
  for (const ch of adapters.values()) push(ownerOf(ch.id));
  return out;
}

/**
 * Send to the owner. Default: the first reachable channel, falling through to
 * the next one if delivery fails. `all: true` sends everywhere (urgent alerts,
 * approvals).
 */
export async function sendToOwner(
  msg: OutboundMessage,
  opts: { channelId?: string | null; all?: boolean } = {},
): Promise<{ ok: boolean; deliveredTo: string[]; error?: string }> {
  const targets = ownerTargets(opts.channelId);
  if (targets.length === 0) return { ok: false, deliveredTo: [], error: 'No connected channel can reach the owner' };
  const deliveredTo: string[] = [];
  let lastError: string | undefined;
  if (opts.all) {
    // Side by side: a channel waiting out a rate limit must not hold an
    // approval back from the others.
    const results = await Promise.all(targets.map(addr => sendTo(addr, msg)));
    results.forEach((res, i) => {
      if (res.ok) deliveredTo.push(targets[i]!.channelId);
      else lastError = res.error;
    });
  } else {
    for (const addr of targets) {
      const res = await sendTo(addr, msg);
      if (res.ok) {
        deliveredTo.push(addr.channelId);
        break;
      }
      lastError = res.error;
    }
  }
  if (deliveredTo.length) log(`[agent] sent ${msg.kind} to owner via ${deliveredTo.join(', ')}`);
  return { ok: deliveredTo.length > 0, deliveredTo, error: deliveredTo.length ? undefined : lastError };
}

/** Recent channel traffic for the Agent view. */
export function recentAgentMessages(limit = 100) {
  return database.select().from(agentMessages).orderBy(desc(agentMessages.createdAt)).limit(Math.min(500, Math.max(1, limit))).all();
}
