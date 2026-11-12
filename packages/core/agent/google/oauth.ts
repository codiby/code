/**
 * Google OAuth 2.0 — authorization-code flow with PKCE for a "Web
 * application" client, plus token refresh and revocation.
 *
 * Vault records:
 *   google:oauth-client  {client_id, client_secret}
 *   google:tokens        {access_token, refresh_token, expiry_date, scope, email}
 *
 * Pending authorizations (state → PKCE verifier) live only in memory: a
 * restart in the middle of a consent screen just means clicking Connect again,
 * and nothing replayable ever touches disk.
 */

import { createHash, randomBytes } from 'crypto';
import { log, logError } from '../../lib/logger';
import { safeEqual } from '../http';
import { deleteSecret, getSecretJson, hasSecret, setSecretJson } from '../vault';
import { googleDeps } from './deps';
import {
  loadGoogleSettings,
  parseScopeString,
  redirectUriFor,
  requiredScopes,
  updateGoogleSettings,
} from './settings';

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

const CLIENT_SECRET_NAME = 'google:oauth-client';
const TOKENS_SECRET_NAME = 'google:tokens';

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 10;
/** Refresh this long before Google's expiry so a request never races it. */
export const REFRESH_MARGIN_MS = 60_000;
const HTTP_TIMEOUT_MS = 20_000;

export interface OAuthClient {
  client_id: string;
  client_secret: string;
}

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  /** Epoch ms. */
  expiry_date: number;
  /** Space-separated granted scopes. */
  scope: string;
  email: string;
}

export type GoogleAuthErrorCode =
  | 'not_configured'
  | 'not_connected'
  | 'invalid_state'
  | 'denied'
  | 'exchange_failed'
  | 'no_refresh_token'
  | 'invalid_grant'
  | 'invalid_client'
  | 'refresh_failed';

/** Errors whose message is safe to show the owner and the model. */
export class GoogleAuthError extends Error {
  constructor(public code: GoogleAuthErrorCode, message: string) {
    super(message);
  }
}

const NOT_CONNECTED_HELP = 'Google is not connected. Ask the owner to connect it in Codiby → Agent → Connections.';

// ---------------------------------------------------------------------------
// OAuth client
// ---------------------------------------------------------------------------

const CLIENT_ID_RE = /^[A-Za-z0-9_.-]{1,200}\.apps\.googleusercontent\.com$/;
const CLIENT_SECRET_RE = /^[\x21-\x7e]{8,255}$/;

export function getOAuthClient(): OAuthClient | null {
  const c = getSecretJson<OAuthClient>(CLIENT_SECRET_NAME);
  return c && typeof c.client_id === 'string' && typeof c.client_secret === 'string' ? c : null;
}

export function isOAuthClientConfigured(): boolean {
  return hasSecret(CLIENT_SECRET_NAME);
}

export function setOAuthClient(clientId: string, clientSecret: string): void {
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (!CLIENT_ID_RE.test(id)) throw new Error('Client ID should look like 1234-abc.apps.googleusercontent.com');
  if (!CLIENT_SECRET_RE.test(secret)) throw new Error('Client secret looks wrong (8–255 printable characters, no spaces)');
  setSecretJson(CLIENT_SECRET_NAME, { client_id: id, client_secret: secret } satisfies OAuthClient);
}

export function deleteOAuthClient(): void {
  deleteSecret(CLIENT_SECRET_NAME);
}

/** Enough of the client id to recognise it in the UI; the secret is never shown. */
export function clientIdHint(): string | null {
  const c = getOAuthClient();
  if (!c) return null;
  const project = c.client_id.replace(/\.apps\.googleusercontent\.com$/, '');
  return `${project.slice(0, 10)}…${project.length > 14 ? project.slice(-4) : ''}.apps.googleusercontent.com`;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * Bumped whenever the stored tokens are replaced or removed, so a refresh
 * that started before a disconnect/reconnect can't write stale tokens back.
 */
let tokenGeneration = 0;

export function loadTokens(): StoredTokens | null {
  const t = getSecretJson<StoredTokens>(TOKENS_SECRET_NAME);
  if (!t || typeof t.access_token !== 'string' || typeof t.refresh_token !== 'string' || !t.refresh_token) return null;
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expiry_date: typeof t.expiry_date === 'number' ? t.expiry_date : 0,
    scope: typeof t.scope === 'string' ? t.scope : '',
    email: typeof t.email === 'string' ? t.email : '',
  };
}

function saveTokens(t: StoredTokens): void {
  setSecretJson(TOKENS_SECRET_NAME, t);
}

function clearTokens(): void {
  tokenGeneration++;
  deleteSecret(TOKENS_SECRET_NAME);
}

export function grantedScopes(): string[] {
  return parseScopeString(loadTokens()?.scope ?? '');
}

// ---------------------------------------------------------------------------
// PKCE + state
// ---------------------------------------------------------------------------

interface PendingAuth {
  state: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
}

const pending: PendingAuth[] = [];

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function prunePending(now: number): void {
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i]!.expiresAt <= now) pending.splice(i, 1);
  }
}

/**
 * One-time lookup: the entry is removed whether or not it is still valid, so
 * a state can never be replayed. Compares in constant time against every
 * pending entry rather than hashing into a Map keyed by the secret.
 */
function takePending(state: string, now: number): PendingAuth | null {
  let found: PendingAuth | null = null;
  for (const p of pending) {
    if (safeEqual(p.state, state)) found = p;
  }
  if (!found) {
    prunePending(now);
    return null;
  }
  pending.splice(pending.indexOf(found), 1);
  prunePending(now);
  return found.expiresAt > now ? found : null;
}

export function startAuthorization(): { url: string; expiresAt: number; redirectUri: string; scopes: string[] } {
  const client = getOAuthClient();
  if (!client) throw new GoogleAuthError('not_configured', 'Add your Google OAuth client ID and secret first.');
  const settings = loadGoogleSettings();
  const redirectUri = redirectUriFor(settings.publicBaseUrl);
  if (!redirectUri) throw new GoogleAuthError('not_configured', 'Set the public base URL of this bridge first — Google needs it to send you back.');
  if (settings.gmail === 'off' && settings.calendar === 'off') {
    throw new GoogleAuthError('not_configured', 'Turn on Gmail or Calendar access before connecting.');
  }

  const now = googleDeps().now();
  prunePending(now);
  while (pending.length >= MAX_PENDING) pending.shift();

  const state = randomBytes(32).toString('base64url');
  const { verifier, challenge } = createPkcePair();
  const expiresAt = now + STATE_TTL_MS;
  pending.push({ state, verifier, redirectUri, expiresAt });

  const scopes = requiredScopes(settings);
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    // Forces a refresh token even when the owner already granted access once.
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return { url: `${AUTH_URL}?${params}`, expiresAt, redirectUri, scopes };
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function postForm(url: string, form: Record<string, string>): Promise<{ status: number; data: TokenResponse }> {
  const res = await googleDeps().fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  let data: TokenResponse = {};
  try { data = (await res.json()) as TokenResponse; } catch {}
  return { status: res.status, data };
}

function describeTokenError(data: TokenResponse, status: number): string {
  const desc = typeof data.error_description === 'string' ? data.error_description.slice(0, 200) : '';
  return `${data.error ?? `HTTP ${status}`}${desc ? ` — ${desc}` : ''}`;
}

/** The id_token comes straight from Google's token endpoint over TLS, so its payload needs no signature check. */
function emailFromIdToken(idToken: string | undefined): string {
  if (!idToken) return '';
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: unknown };
    return typeof payload.email === 'string' ? payload.email : '';
  } catch {
    return '';
  }
}

async function fetchEmail(accessToken: string, idToken: string | undefined): Promise<string> {
  try {
    const res = await googleDeps().fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.ok) {
      const info = (await res.json()) as { email?: unknown };
      if (typeof info.email === 'string' && info.email) return info.email;
    }
  } catch (err) {
    logError(`[google] userinfo lookup failed: ${err instanceof Error ? err.message : err}`);
  }
  return emailFromIdToken(idToken);
}

/**
 * Handle Google's redirect. Validates the one-time state, exchanges the code
 * with the PKCE verifier and stores the tokens. Throws GoogleAuthError.
 */
export async function completeAuthorization(params: { code?: string | null; state?: string | null; error?: string | null }): Promise<{ email: string; scopes: string[] }> {
  const now = googleDeps().now();
  const entry = params.state ? takePending(params.state, now) : null;
  if (!entry) throw new GoogleAuthError('invalid_state', 'This sign-in link has expired or was already used. Start again from Codiby → Agent → Connections.');
  if (params.error) {
    throw new GoogleAuthError('denied', params.error === 'access_denied' ? 'Access was not granted.' : `Google returned an error: ${params.error.slice(0, 100)}`);
  }
  if (!params.code) throw new GoogleAuthError('exchange_failed', 'Google did not return an authorization code.');
  const client = getOAuthClient();
  if (!client) throw new GoogleAuthError('not_configured', 'The Google OAuth client was removed while signing in.');

  let res: { status: number; data: TokenResponse };
  try {
    res = await postForm(TOKEN_URL, {
      grant_type: 'authorization_code',
      code: params.code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: entry.redirectUri,
      code_verifier: entry.verifier,
    });
  } catch (err) {
    throw new GoogleAuthError('exchange_failed', `Couldn't reach Google: ${err instanceof Error ? err.message : err}`);
  }
  const { data } = res;
  if (res.status !== 200 || !data.access_token) {
    throw new GoogleAuthError('exchange_failed', `Google refused the sign-in (${describeTokenError(data, res.status)}).`);
  }

  const email = await fetchEmail(data.access_token, data.id_token);
  const previous = loadTokens();
  // Google only re-issues a refresh token on consent; keep the old one if the same account came back without one.
  const refreshToken = data.refresh_token || (previous && previous.email === email ? previous.refresh_token : '');
  if (!refreshToken) {
    throw new GoogleAuthError('no_refresh_token', 'Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.');
  }

  const scopes = parseScopeString(data.scope ?? '');
  tokenGeneration++;
  saveTokens({
    access_token: data.access_token,
    refresh_token: refreshToken,
    expiry_date: now + Math.max(0, Number(data.expires_in) || 3600) * 1000,
    scope: scopes.join(' '),
    email,
  });
  updateGoogleSettings(s => ({ ...s, lastError: null }));
  log(`[google] Connected ${email || 'a Google account'} (${scopes.length} scopes)`);
  return { email, scopes };
}

// ---------------------------------------------------------------------------
// Access tokens (refresh is single-flight)
// ---------------------------------------------------------------------------

let inflight: Promise<StoredTokens> | null = null;

async function handleInvalidGrant(generation: number): Promise<void> {
  // Another caller (or a reconnect) already dealt with this token.
  if (generation !== tokenGeneration) return;
  const email = loadTokens()?.email;
  clearTokens();
  const message = 'Google access expired or was revoked — connect Google again.';
  updateGoogleSettings(s => ({ ...s, lastError: { message, at: googleDeps().now() } }));
  logError(`[google] refresh token rejected (invalid_grant) for ${email || 'the connected account'}; marked disconnected`);
  try {
    await googleDeps().notifyOwner(
      `Google${email ? ` (${email})` : ''} got disconnected: access expired or was revoked. Reconnect it in Codiby → Agent → Connections so I can use Gmail and Calendar again.`,
    );
  } catch (err) {
    logError(`[google] owner notification failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function refreshTokens(tokens: StoredTokens): Promise<StoredTokens> {
  const client = getOAuthClient();
  if (!client) throw new GoogleAuthError('not_configured', 'The Google OAuth client is missing. Add it again in Codiby → Agent → Connections.');
  const generation = tokenGeneration;
  let res: { status: number; data: TokenResponse };
  try {
    res = await postForm(TOKEN_URL, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
      client_secret: client.client_secret,
    });
  } catch (err) {
    throw new GoogleAuthError('refresh_failed', `Couldn't reach Google to refresh access: ${err instanceof Error ? err.message : err}`);
  }
  const { data } = res;
  if (res.status !== 200 || !data.access_token) {
    if (data.error === 'invalid_grant') {
      await handleInvalidGrant(generation);
      throw new GoogleAuthError('invalid_grant', 'Google access expired or was revoked. Ask the owner to reconnect Google in Codiby → Agent → Connections.');
    }
    if (data.error === 'invalid_client' || data.error === 'unauthorized_client') {
      throw new GoogleAuthError('invalid_client', 'Google rejected the OAuth client. Check the client ID and secret in Codiby → Agent → Connections.');
    }
    throw new GoogleAuthError('refresh_failed', `Google couldn't refresh access (${describeTokenError(data, res.status)}). Try again shortly.`);
  }
  const next: StoredTokens = {
    ...tokens,
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    expiry_date: googleDeps().now() + Math.max(0, Number(data.expires_in) || 3600) * 1000,
    scope: data.scope ? parseScopeString(data.scope).join(' ') : tokens.scope,
  };
  if (generation === tokenGeneration && loadTokens()) saveTokens(next);
  return next;
}

/**
 * A valid access token. `rejected` is a token Google just answered 401 to:
 * refresh unless someone already replaced it.
 */
export async function getAccessToken(opts: { rejected?: string } = {}): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new GoogleAuthError('not_connected', NOT_CONNECTED_HELP);
  const now = googleDeps().now();
  const fresh = tokens.expiry_date - REFRESH_MARGIN_MS > now;
  if (fresh && tokens.access_token !== opts.rejected) return tokens.access_token;
  if (!inflight) {
    inflight = refreshTokens(tokens).finally(() => { inflight = null; });
  }
  return (await inflight).access_token;
}

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

export async function disconnectGoogle(): Promise<{ revoked: boolean }> {
  const tokens = loadTokens();
  clearTokens();
  updateGoogleSettings(s => ({ ...s, lastError: null }));
  if (!tokens) return { revoked: false };
  try {
    // Revoking the refresh token revokes every access token minted from it.
    const res = await postForm(REVOKE_URL, { token: tokens.refresh_token });
    if (res.status !== 200) logError(`[google] revoke returned ${res.status} (${res.data.error ?? 'no detail'})`);
    log(`[google] Disconnected ${tokens.email || 'Google'}`);
    return { revoked: res.status === 200 };
  } catch (err) {
    logError(`[google] revoke failed: ${err instanceof Error ? err.message : err}`);
    return { revoked: false };
  }
}

/** Tests only. */
export function _resetOAuthForTest(): void {
  pending.length = 0;
  inflight = null;
  tokenGeneration++;
}

export function _pendingCountForTest(): number {
  return pending.length;
}
