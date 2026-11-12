/**
 * FCM HTTP v1 sender. One call = one message to one registration token.
 *
 * Errors are sorted into what the caller can act on:
 *   - 'token'     — this device's token is dead (UNREGISTERED, or a token
 *                   FCM cannot parse): disable it;
 *   - 'config'    — the project is misconfigured (missing role, API off, no
 *                   APNs key, key from another project): every device will
 *                   fail the same way, so no device is blamed;
 *   - 'transient' — retried here with backoff, reported if it persists;
 *   - 'payload'   — we built a bad message; a bug, never the device's fault.
 */

import { createAccessTokenProvider, OAuthError, type AccessTokenProvider, type FetchFn } from './oauth';
import type { ServiceAccount } from './serviceAccount';

export const FCM_API_BASE = 'https://fcm.googleapis.com/v1/projects';

/** The subset of the FCM v1 `Message` resource this area sends. */
export interface FcmMessage {
  token: string;
  data: Record<string, string>;
  android?: {
    priority: 'HIGH' | 'NORMAL';
    ttl?: string;
    collapse_key?: string;
  };
  apns?: {
    headers: Record<string, string>;
    payload: { aps: Record<string, unknown> } & Record<string, unknown>;
  };
}

export type FcmErrorKind = 'token' | 'config' | 'transient' | 'payload';

export type FcmOutcome =
  | { ok: true; messageId: string }
  | { ok: false; kind: FcmErrorKind; status: number; errorCode: string | null; message: string };

export interface FcmClient {
  send(sa: ServiceAccount, message: FcmMessage): Promise<FcmOutcome>;
  /** Forget the cached access token (the credential was replaced or removed). */
  reset(): void;
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: { '@type'?: string; errorCode?: string; fieldViolations?: { field?: string }[] }[];
  };
}

const RETRY_DELAYS_MS = [1_000, 4_000];
const MAX_RETRY_AFTER_MS = 30_000;

/** Pure: map an FCM error response to what the caller should do about it. */
export function classifyFcmError(status: number, body: unknown): Omit<Extract<FcmOutcome, { ok: false }>, 'ok'> {
  const err = (body as GoogleErrorBody | null)?.error ?? {};
  const details = Array.isArray(err.details) ? err.details : [];
  const errorCode = details.find(d => typeof d?.errorCode === 'string')?.errorCode ?? err.status ?? null;
  const message = typeof err.message === 'string' && err.message ? err.message : `HTTP ${status}`;
  const tokenField = details.some(d => Array.isArray(d?.fieldViolations) && d.fieldViolations.some(v => v?.field === 'message.token'));

  if (errorCode === 'UNREGISTERED') {
    return { kind: 'token', status, errorCode, message };
  }
  // Every phone fails like this when the uploaded key belongs to another
  // project, so it is a setup problem — disabling the devices would hide it.
  if (errorCode === 'SENDER_ID_MISMATCH') {
    return { kind: 'config', status, errorCode, message: `${message} — the app's google-services file and the service account must come from the same Firebase project` };
  }
  if (errorCode === 'INVALID_ARGUMENT' || status === 400) {
    const aboutToken = tokenField || /registration token/i.test(message);
    return { kind: aboutToken ? 'token' : 'payload', status, errorCode, message };
  }
  if (errorCode === 'QUOTA_EXCEEDED' || errorCode === 'UNAVAILABLE' || errorCode === 'INTERNAL' || status === 429 || status >= 500) {
    return { kind: 'transient', status, errorCode, message };
  }
  if (errorCode === 'THIRD_PARTY_AUTH_ERROR') {
    return { kind: 'config', status, errorCode, message: `${message} — upload your APNs authentication key in Firebase → Project settings → Cloud Messaging` };
  }
  return { kind: 'config', status, errorCode, message };
}

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.min(Math.max(0, at - Date.now()), MAX_RETRY_AFTER_MS) : null;
}

export function createFcmClient(opts: {
  fetch?: FetchFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  tokens?: AccessTokenProvider;
} = {}): FcmClient {
  const doFetch: FetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const tokens = opts.tokens ?? createAccessTokenProvider({ fetch: opts.fetch, now: opts.now });

  async function attempt(sa: ServiceAccount, message: FcmMessage): Promise<{ outcome: FcmOutcome; retryAfter: number | null }> {
    let accessToken: string;
    try {
      accessToken = await tokens.get(sa);
    } catch (err) {
      if (err instanceof OAuthError) {
        // invalid_grant / unauthorized_client mean the key itself is bad; a 5xx is Google having a moment.
        const kind: FcmErrorKind = err.status >= 500 || err.status === 429 ? 'transient' : 'config';
        return { outcome: { ok: false, kind, status: err.status, errorCode: err.code, message: err.message }, retryAfter: null };
      }
      return { outcome: { ok: false, kind: 'transient', status: 0, errorCode: null, message: `Could not reach Google: ${errMessage(err)}` }, retryAfter: null };
    }

    let res: Response;
    try {
      res = await doFetch(`${FCM_API_BASE}/${encodeURIComponent(sa.projectId)}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return { outcome: { ok: false, kind: 'transient', status: 0, errorCode: null, message: `Could not reach FCM: ${errMessage(err)}` }, retryAfter: null };
    }

    let body: unknown = null;
    try { body = await res.json(); } catch {}
    if (res.ok) {
      const name = (body as { name?: unknown } | null)?.name;
      return { outcome: { ok: true, messageId: typeof name === 'string' ? name : '' }, retryAfter: null };
    }
    return { outcome: { ok: false, ...classifyFcmError(res.status, body) }, retryAfter: retryAfterMs(res) };
  }

  return {
    async send(sa, message) {
      let refreshedToken = false;
      for (let i = 0; ; i++) {
        const { outcome, retryAfter } = await attempt(sa, message);
        if (outcome.ok) return outcome;
        // A 401 from FCM with a cached token usually means Google rotated it early; one fresh token, then give up.
        if (outcome.status === 401 && outcome.errorCode !== 'THIRD_PARTY_AUTH_ERROR' && !refreshedToken) {
          refreshedToken = true;
          tokens.invalidate();
          i--;
          continue;
        }
        if (outcome.kind !== 'transient' || i >= RETRY_DELAYS_MS.length) return outcome;
        await sleep(retryAfter ?? RETRY_DELAYS_MS[i]!);
      }
    },
    reset() {
      tokens.invalidate();
    },
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
