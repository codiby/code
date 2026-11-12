import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { getSecretJson } from '../vault';
import { googleRequest } from './api';
import {
  GoogleAuthError,
  REVOKE_URL,
  TOKEN_URL,
  USERINFO_URL,
  _pendingCountForTest,
  completeAuthorization,
  disconnectGoogle,
  getAccessToken,
  loadTokens,
  startAuthorization,
  type StoredTokens,
} from './oauth';
import { SCOPE, loadGoogleSettings, updateGoogleSettings } from './settings';
import { googleStatus } from './status';
import { CLIENT_ID, CLIENT_SECRET, configureClient, connectWith, createFakeGoogle, resetGoogleState } from './test-helpers';

let g: ReturnType<typeof createFakeGoogle>;

function tokenRoute(reply: (form: URLSearchParams) => { status?: number; json: unknown }) {
  g.on('POST', TOKEN_URL, req => reply(req.form()));
}

async function expectAuthError(p: Promise<unknown>, code: string): Promise<GoogleAuthError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect((err as GoogleAuthError).code).toBe(code as GoogleAuthError['code']);
    return err as GoogleAuthError;
  }
  throw new Error(`expected GoogleAuthError ${code}`);
}

beforeEach(() => {
  resetGoogleState();
  g = createFakeGoogle().install();
  g.on('GET', USERINFO_URL, () => ({ json: { email: 'owner@example.com', email_verified: true } }));
});

afterEach(() => resetGoogleState());

describe('authorization start', () => {
  test('needs a client, a public base URL and at least one service', () => {
    expect(() => startAuthorization()).toThrow(/client ID/);
    configureClient({ publicBaseUrl: '' });
    expect(() => startAuthorization()).toThrow(/public base URL/);
    configureClient({ gmail: 'off', calendar: 'off' });
    expect(() => startAuthorization()).toThrow(/Gmail or Calendar/);
  });

  test('builds a PKCE consent URL with offline access and derived scopes', () => {
    configureClient({ gmail: 'send', calendar: 'write' });
    const { url, redirectUri } = startAuthorization();
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = u.searchParams;
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('redirect_uri')).toBe('https://agent.example.ts.net/agent/google/callback');
    expect(redirectUri).toBe(p.get('redirect_uri')!);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('include_granted_scopes')).toBe('true');
    // 32 random bytes, base64url.
    expect(p.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const scopes = p.get('scope')!.split(' ');
    expect(scopes).toEqual(expect.arrayContaining(['openid', 'email', SCOPE.gmailRead, SCOPE.gmailCompose, SCOPE.gmailSend, SCOPE.calendarRead, SCOPE.calendarEvents]));
    expect(url.includes(CLIENT_SECRET)).toBe(false);
  });

  test('read-only levels request read-only scopes', () => {
    configureClient({ gmail: 'read', calendar: 'off' });
    const scopes = new URL(startAuthorization().url).searchParams.get('scope')!.split(' ');
    expect(scopes).toEqual(['openid', 'email', SCOPE.gmailRead]);
  });
});

describe('callback', () => {
  function issue() {
    configureClient({ gmail: 'draft', calendar: 'read' });
    const url = new URL(startAuthorization().url);
    return { state: url.searchParams.get('state')!, challenge: url.searchParams.get('code_challenge')! };
  }

  test('exchanges the code with the PKCE verifier and stores tokens in the vault', async () => {
    const { state, challenge } = issue();
    let verifier = '';
    tokenRoute(form => {
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('code')).toBe('the-code');
      expect(form.get('client_secret')).toBe(CLIENT_SECRET);
      expect(form.get('redirect_uri')).toBe('https://agent.example.ts.net/agent/google/callback');
      verifier = form.get('code_verifier')!;
      return { json: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599, scope: `openid https://www.googleapis.com/auth/userinfo.email ${SCOPE.gmailRead}`, token_type: 'Bearer' } };
    });
    const res = await completeAuthorization({ code: 'the-code', state });
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
    expect(res.email).toBe('owner@example.com');
    const stored = getSecretJson<StoredTokens>('google:tokens')!;
    expect(stored.access_token).toBe('at-1');
    expect(stored.refresh_token).toBe('rt-1');
    expect(stored.email).toBe('owner@example.com');
    expect(stored.expiry_date).toBe(g.now + 3599_000);
    // The long userinfo.email alias is stored under its short name.
    expect(stored.scope.split(' ')).toContain('email');
    expect(g.find('GET', '/v1/userinfo')[0]!.headers.authorization).toBe('Bearer at-1');
  });

  test('a state works once', async () => {
    const { state } = issue();
    tokenRoute(() => ({ json: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: SCOPE.gmailRead } }));
    await completeAuthorization({ code: 'c', state });
    await expectAuthError(completeAuthorization({ code: 'c', state }), 'invalid_state');
    expect(g.find('POST', '/token')).toHaveLength(1);
  });

  test('a state expires after 10 minutes', async () => {
    const { state } = issue();
    g.advance(10 * 60_000 + 1);
    await expectAuthError(completeAuthorization({ code: 'c', state }), 'invalid_state');
    expect(g.find('POST', '/token')).toHaveLength(0);
    expect(_pendingCountForTest()).toBe(0);
  });

  test('unknown or missing states are rejected without calling Google', async () => {
    issue();
    await expectAuthError(completeAuthorization({ code: 'c', state: 'forged' }), 'invalid_state');
    await expectAuthError(completeAuthorization({ code: 'c', state: null }), 'invalid_state');
    expect(g.requests).toHaveLength(0);
  });

  test('a denied consent consumes the state', async () => {
    const { state } = issue();
    await expectAuthError(completeAuthorization({ error: 'access_denied', state }), 'denied');
    await expectAuthError(completeAuthorization({ code: 'c', state }), 'invalid_state');
  });

  test('a failed exchange surfaces Google\'s reason and stores nothing', async () => {
    const { state } = issue();
    tokenRoute(() => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Bad Request' } }));
    const err = await expectAuthError(completeAuthorization({ code: 'c', state }), 'exchange_failed');
    expect(err.message).toContain('invalid_grant');
    expect(loadTokens()).toBeNull();
  });

  test('no refresh token and no previous one is an error', async () => {
    const { state } = issue();
    tokenRoute(() => ({ json: { access_token: 'at', expires_in: 3600, scope: SCOPE.gmailRead } }));
    await expectAuthError(completeAuthorization({ code: 'c', state }), 'no_refresh_token');
  });
});

describe('access tokens', () => {
  beforeEach(() => configureClient({ gmail: 'read' }));

  test('a fresh token is used as-is', async () => {
    connectWith([SCOPE.gmailRead], { now: g.now, expiresInMs: 120_000 });
    expect(await getAccessToken()).toBe('access-1');
    expect(g.requests).toHaveLength(0);
  });

  test('refreshes 60 s before expiry, once for concurrent callers', async () => {
    connectWith([SCOPE.gmailRead], { now: g.now, expiresInMs: 59_000 });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    g.on('POST', TOKEN_URL, async req => {
      expect(req.form().get('grant_type')).toBe('refresh_token');
      expect(req.form().get('refresh_token')).toBe('refresh-1');
      await gate;
      return { json: { access_token: 'access-2', expires_in: 3600 } };
    });
    const all = Promise.all([getAccessToken(), getAccessToken(), getAccessToken()]);
    release();
    expect(await all).toEqual(['access-2', 'access-2', 'access-2']);
    expect(g.find('POST', '/token')).toHaveLength(1);
    const stored = loadTokens()!;
    expect(stored.access_token).toBe('access-2');
    expect(stored.refresh_token).toBe('refresh-1'); // kept when Google doesn't rotate it
    expect(stored.expiry_date).toBe(g.now + 3_600_000);
  });

  test('invalid_grant disconnects and tells the owner exactly once', async () => {
    connectWith([SCOPE.gmailRead], { now: g.now, expiresInMs: 0 });
    tokenRoute(() => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }));
    const results = await Promise.allSettled([getAccessToken(), getAccessToken()]);
    expect(results.every(r => r.status === 'rejected' && (r.reason as GoogleAuthError).code === 'invalid_grant')).toBe(true);
    await expectAuthError(getAccessToken(), 'not_connected');
    expect(g.notifications).toHaveLength(1);
    expect(g.notifications[0]).toContain('owner@example.com');
    expect(loadTokens()).toBeNull();
    const status = googleStatus();
    expect(status.connected).toBe(false);
    expect(status.lastError?.message).toMatch(/expired or was revoked/);
  });

  test('a transient refresh failure keeps the connection', async () => {
    connectWith([SCOPE.gmailRead], { now: g.now, expiresInMs: 0 });
    tokenRoute(() => ({ status: 503, json: { error: 'backend_error' } }));
    await expectAuthError(getAccessToken(), 'refresh_failed');
    expect(loadTokens()).not.toBeNull();
    expect(g.notifications).toHaveLength(0);
  });

  test('API calls retry once with a refreshed token after a 401', async () => {
    connectWith([SCOPE.gmailRead], { now: g.now });
    tokenRoute(() => ({ json: { access_token: 'access-2', expires_in: 3600 } }));
    g.on('GET', 'https://gmail.googleapis.com/gmail/v1/users/me/profile', req =>
      req.headers.authorization === 'Bearer access-2'
        ? { json: { emailAddress: 'owner@example.com' } }
        : { status: 401, json: { error: { code: 401, message: 'Invalid Credentials' } } });
    const res = await googleRequest<{ emailAddress: string }>({ url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile' });
    expect(res.emailAddress).toBe('owner@example.com');
    expect(g.find('POST', '/token')).toHaveLength(1);
  });
});

describe('disconnect', () => {
  test('revokes the refresh token and forgets the tokens', async () => {
    configureClient();
    connectWith([SCOPE.gmailRead], { now: g.now });
    g.on('POST', REVOKE_URL, () => ({ json: {} }));
    const res = await disconnectGoogle();
    expect(res.revoked).toBe(true);
    expect(g.find('POST', '/revoke')[0]!.form().get('token')).toBe('refresh-1');
    expect(loadTokens()).toBeNull();
  });

  test('still forgets the tokens when Google is unreachable', async () => {
    configureClient();
    connectWith([SCOPE.gmailRead], { now: g.now });
    g.on('POST', REVOKE_URL, () => { throw new Error('offline'); });
    expect((await disconnectGoogle()).revoked).toBe(false);
    expect(loadTokens()).toBeNull();
  });
});

describe('status', () => {
  test('flags a reconnect when the level was raised after connecting', () => {
    configureClient({ gmail: 'read', calendar: 'off' });
    connectWith([SCOPE.gmailRead], { now: g.now });
    expect(googleStatus().needsReconnect).toBe(false);
    updateGoogleSettings(s => ({ ...s, gmail: 'send' }));
    const s = googleStatus();
    expect(s.needsReconnect).toBe(true);
    expect(s.missingScopes).toContain(SCOPE.gmailSend);
    expect(loadGoogleSettings().gmail).toBe('send');
  });

  test('never exposes the client secret or tokens', () => {
    configureClient();
    connectWith([SCOPE.gmailRead], { now: g.now });
    const text = JSON.stringify(googleStatus());
    for (const secret of [CLIENT_SECRET, 'access-1', 'refresh-1', CLIENT_ID]) expect(text.includes(secret)).toBe(false);
  });
});
