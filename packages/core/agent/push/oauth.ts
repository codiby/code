/**
 * Google OAuth for a service account, without firebase-admin: sign an RS256
 * JWT assertion, trade it at the token endpoint for a one-hour access token,
 * and keep that token until five minutes before it expires.
 *
 * Every push in a burst (an approval fanned out to three phones) asks for a
 * token at the same moment, so the refresh is single-flight: one request to
 * Google, everyone awaits the same promise.
 */

import { createHash, createSign } from 'crypto';
import type { ServiceAccount } from './serviceAccount';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** Google caps assertions at one hour. */
const ASSERTION_TTL_S = 3600;
/** Refresh this long before expiry so a token never dies mid-burst. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function buildSignedJwt(sa: ServiceAccount, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (sa.privateKeyId) header.kid = sa.privateKeyId;
  const claims = {
    iss: sa.clientEmail,
    sub: sa.clientEmail,
    scope: FCM_SCOPE,
    aud: TOKEN_URL,
    iat,
    exp: iat + ASSERTION_TTL_S,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(sa.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

export class OAuthError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
  }
}

interface CachedToken {
  /** Credential the token belongs to — a replaced key must not reuse it. */
  fingerprint: string;
  accessToken: string;
  expiresAt: number;
}

export interface AccessTokenProvider {
  get(sa: ServiceAccount): Promise<string>;
  /** Drop the cached token (Google answered 401, or the key changed). */
  invalidate(): void;
}

// A digest, not the key itself, so the cache never holds a second copy of it.
function fingerprint(sa: ServiceAccount): string {
  return createHash('sha256').update(`${sa.projectId}\n${sa.clientEmail}\n${sa.privateKey}`).digest('hex');
}

export function createAccessTokenProvider(opts: {
  fetch?: FetchFn;
  now?: () => number;
} = {}): AccessTokenProvider {
  // Resolved per call, so a test (or a smoke harness) can swap global fetch.
  const doFetch: FetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? Date.now;
  let cache: CachedToken | null = null;
  let inflight: { fingerprint: string; promise: Promise<string> } | null = null;

  async function exchange(sa: ServiceAccount, fp: string): Promise<string> {
    const assertion = buildSignedJwt(sa, now());
    const res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    let body: Record<string, unknown> = {};
    try { body = (await res.json()) as Record<string, unknown>; } catch {}
    if (!res.ok || typeof body.access_token !== 'string') {
      const code = typeof body.error === 'string' ? body.error : null;
      const detail = typeof body.error_description === 'string' ? body.error_description : `HTTP ${res.status}`;
      throw new OAuthError(`Google rejected the service account${code ? ` (${code})` : ''}: ${detail}`, res.status, code);
    }
    const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
    cache = { fingerprint: fp, accessToken: body.access_token, expiresAt: now() + expiresIn * 1000 };
    return body.access_token;
  }

  return {
    get(sa) {
      const fp = fingerprint(sa);
      if (cache && cache.fingerprint === fp && cache.expiresAt - REFRESH_MARGIN_MS > now()) {
        return Promise.resolve(cache.accessToken);
      }
      if (inflight && inflight.fingerprint === fp) return inflight.promise;
      const promise = exchange(sa, fp).finally(() => {
        if (inflight?.promise === promise) inflight = null;
      });
      inflight = { fingerprint: fp, promise };
      return promise;
    },
    invalidate() {
      cache = null;
    },
  };
}
