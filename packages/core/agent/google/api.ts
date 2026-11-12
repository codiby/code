/**
 * Authorised calls to Google REST APIs. Adds the bearer token, retries once
 * with a refreshed token on 401, and turns Google's error envelopes into
 * messages the model can act on (and that never contain a token).
 */

import { googleDeps } from './deps';
import { getAccessToken } from './oauth';

const HTTP_TIMEOUT_MS = 30_000;

export class GoogleApiError extends Error {
  constructor(public status: number, message: string, public reason?: string) {
    super(message);
  }
}

type QueryValue = string | number | boolean | undefined | null | (string | number)[];

export interface GoogleRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
}

function buildUrl(base: string, query: GoogleRequest['query']): string {
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const item of v) params.append(k, String(item));
    else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

interface GoogleErrorBody {
  error?: { code?: number; message?: string; status?: string; errors?: { reason?: string; message?: string }[] } | string;
  error_description?: string;
}

async function toApiError(res: Response): Promise<GoogleApiError> {
  let body: GoogleErrorBody = {};
  try { body = (await res.json()) as GoogleErrorBody; } catch {}
  const err = typeof body.error === 'object' ? body.error : undefined;
  const reason = err?.errors?.[0]?.reason ?? err?.status ?? (typeof body.error === 'string' ? body.error : undefined);
  const detail = (err?.message ?? body.error_description ?? res.statusText ?? '').slice(0, 300);
  if (res.status === 403 && /insufficient|scope/i.test(`${reason} ${detail}`)) {
    return new GoogleApiError(403, 'Google says this connection lacks permission for that. Ask the owner to raise the access level and reconnect Google in Codiby → Agent → Connections.', reason);
  }
  if (res.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used|is disabled/i.test(`${reason} ${detail}`)) {
    return new GoogleApiError(403, `This API is not enabled in the owner's Google Cloud project: ${detail}`, reason);
  }
  if (res.status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
    return new GoogleApiError(429, 'Google rate limit reached — wait a moment and try again.', reason);
  }
  if (res.status === 404) return new GoogleApiError(404, `Not found${detail ? `: ${detail}` : ''}`, reason);
  return new GoogleApiError(res.status, `Google API error ${res.status}${detail ? `: ${detail}` : ''}`, reason);
}

async function send(req: GoogleRequest, token: string): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (req.body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    return await googleDeps().fetch(buildUrl(req.url, req.query), {
      method: req.method ?? 'GET',
      headers,
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new GoogleApiError(0, timedOut
      ? 'Google took too long to answer. Try again in a moment.'
      : `Couldn't reach Google: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** JSON result of a Google API call; `null` for empty (204) responses. */
export async function googleRequest<T>(req: GoogleRequest): Promise<T> {
  let token = await getAccessToken();
  let res = await send(req, token);
  if (res.status === 401) {
    token = await getAccessToken({ rejected: token });
    res = await send(req, token);
  }
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return null as T;
  const text = await res.text();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GoogleApiError(res.status, 'Google returned a response that is not JSON');
  }
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
