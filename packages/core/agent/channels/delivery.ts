/**
 * Delivery certainty for channel adapters.
 *
 * The outbox retries every send that throws. That is only safe when the send
 * definitely did not happen: a timeout or a dropped connection after the
 * platform accepted the message would deliver it twice on the retry. So
 * adapters throw only for definite failures (refused, rejected, never left
 * this machine) and log-and-return for uncertain ones — the owner may miss a
 * message that really was lost, but never gets the same one twice.
 */

import { createHash } from 'crypto';
import { logError } from '../../lib/logger';
import type { OutboundMessage } from '../types';

/** The platform may have acted on the request; retrying could duplicate it. */
export class DeliveryUncertainError extends Error {
  readonly uncertain = true;
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryUncertainError';
  }
}

export function isDeliveryUncertain(err: unknown): err is DeliveryUncertainError {
  return err instanceof DeliveryUncertainError;
}

/**
 * Errors raised before any request byte left this machine: name resolution,
 * a refused or unreachable socket, a TLS certificate rejected during the
 * handshake. The platform never saw the request, so a retry is safe.
 */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED', 'ConnectionRefused', 'ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL',
  'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'EADDRNOTAVAIL', 'FailedToOpenSocket', 'UnableToConnect',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export function failedBeforeSending(err: unknown): boolean {
  // Bun puts the code on the error; Node's fetch wraps it in `cause`.
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && NOT_SENT_CODES.has(code)) return true;
  }
  return false;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function logUncertain(channel: string, what: string, err: unknown): void {
  logError(`[${channel}] ${what} may or may not have been delivered (${errorText(err)}) — not retrying, so it is never sent twice`);
}

/**
 * Per-message progress for multi-part sends (several files, then a caption).
 * The outbox retries with the same message object, so a retry resumes after
 * the parts that already went out instead of sending them again.
 */
export interface PartProgress {
  done: number;
  firstId: string | undefined;
  /** A part went out without the platform confirming it (see logUncertain). */
  unconfirmed: boolean;
}

export function partTracker(): (msg: OutboundMessage) => PartProgress {
  const progress = new WeakMap<OutboundMessage, PartProgress>();
  return msg => {
    let p = progress.get(msg);
    if (!p) {
      p = { done: 0, firstId: undefined, unconfirmed: false };
      progress.set(msg, p);
    }
    return p;
  };
}

// ---------------------------------------------------------------------------
// Inbound dedupe without a platform message id
// ---------------------------------------------------------------------------

/** Stable id from the parts that identify one message (channel, sender, time, content…). */
export function contentId(parts: (string | number | null | undefined)[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(`${p ?? ''}\u0000`);
  return `auto:${h.digest('hex').slice(0, 32)}`;
}

/**
 * Inbound envelopes need a stable externalId so a client's retry is dropped
 * as a duplicate. When the sender sends none and the content carries no
 * timestamp of its own, identical content within `windowMs` of its first
 * arrival is treated as the same message: the id is anchored to that first
 * arrival, so every retry inside the window hashes to the same value.
 */
export class RetryWindow {
  private readonly firstSeen = new Map<string, number>();

  constructor(private readonly windowMs: number, private readonly max = 500) {}

  idFor(parts: (string | number | null | undefined)[], now: number): string {
    const key = contentId(parts);
    for (const [k, at] of this.firstSeen) {
      if (now - at <= this.windowMs) break;
      this.firstSeen.delete(k);
    }
    let at = this.firstSeen.get(key);
    if (at === undefined || now - at > this.windowMs) {
      at = now;
      // Re-insert so the map stays ordered by first arrival (oldest first).
      this.firstSeen.delete(key);
      this.firstSeen.set(key, at);
      while (this.firstSeen.size > this.max) this.firstSeen.delete(this.firstSeen.keys().next().value!);
    }
    return contentId([key, at]);
  }
}
