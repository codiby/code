import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'fs';
import { agentDataDir } from '../store';
import { handleAgentRoute } from '../routes';
import { _setAgentDepsForTest } from '../runtime';
import { getSecretJson, listSecrets } from '../vault';
import { parseFunnelBases } from './detect';
import './index';
import { REVOKE_URL, TOKEN_URL, USERINFO_URL, _pendingCountForTest, getAccessToken } from './oauth';
import { normalizeSiteDomain, type SiteLogin } from './secrets';
import { SCOPE, updateGoogleSettings } from './settings';
import { CLIENT_ID, CLIENT_SECRET, configureClient, connectWith, createFakeGoogle, resetGoogleState } from './test-helpers';

let g: ReturnType<typeof createFakeGoogle>;

async function call(method: string, path: string, body?: unknown, authenticated = true): Promise<Response> {
  const url = new URL(`http://127.0.0.1:3905${path}`);
  const req = new Request(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
  });
  const res = await handleAgentRoute(req, url, authenticated);
  if (!res) throw new Error(`no agent route for ${path}`);
  return res;
}

/** Trusted for being on localhost (the agent's own Bash or browser) — not the owner's app or token. */
const LOCAL_ONLY = { authenticated: true, ownerVerified: false };

async function cleanSites() {
  for (const s of listSecrets('site:')) {
    await call('DELETE', `/agent/secrets/site/${encodeURIComponent(s.name.slice(5))}`);
  }
}

beforeEach(() => {
  resetGoogleState();
  g = createFakeGoogle().install();
});

afterEach(async () => {
  resetGoogleState();
  await cleanSites();
  _setAgentDepsForTest(null);
});

describe('google routes', () => {
  test('everything but the callback needs the bridge token', async () => {
    expect((await call('GET', '/agent/google/status', undefined, false)).status).toBe(401);
    expect((await call('GET', '/agent/google/auth/start', undefined, false)).status).toBe(401);
    expect((await call('GET', '/agent/secrets?prefix=site:', undefined, false)).status).toBe(401);
    const cb = await call('GET', '/agent/google/callback?code=x&state=y', undefined, false);
    expect(cb.status).toBe(400);
    expect(cb.headers.get('content-type')).toContain('text/html');
  });

  test('client setup validates input and never echoes the secret', async () => {
    expect((await call('PUT', '/agent/google/client', { clientId: 'nope', clientSecret: 'x' })).status).toBe(400);
    const installed = await call('PUT', '/agent/google/client', { credentialsJson: JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } }) });
    expect(installed.status).toBe(400);
    expect(((await installed.json()) as { error: string }).error).toMatch(/Web application/);

    const ok = await call('PUT', '/agent/google/client', { credentialsJson: JSON.stringify({ web: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uris: [] } }) });
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(text.includes(CLIENT_SECRET)).toBe(false);
    expect(JSON.parse(text)).toMatchObject({ clientConfigured: true, configured: false, connected: false });
    expect(getSecretJson<{ client_id: string }>('google:oauth-client')!.client_id).toBe(CLIENT_ID);
  });

  test('settings validate the base URL and levels', async () => {
    expect((await call('PUT', '/agent/google/settings', { publicBaseUrl: 'http://agent.example.com' })).status).toBe(400);
    expect((await call('PUT', '/agent/google/settings', { gmail: 'everything' })).status).toBe(400);
    const res = await call('PUT', '/agent/google/settings', { publicBaseUrl: 'https://agent.example.ts.net:10000/', gmail: 'send', calendar: 'off' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      publicBaseUrl: 'https://agent.example.ts.net:10000',
      redirectUri: 'https://agent.example.ts.net:10000/agent/google/callback',
      services: { gmail: 'send', calendar: 'off' },
    });
  });

  test('start → callback → connected, with a page that leaks nothing', async () => {
    configureClient({ gmail: 'read', calendar: 'read' });
    g.on('POST', TOKEN_URL, () => ({ json: { access_token: 'tok-access', refresh_token: 'tok-refresh', expires_in: 3600, scope: `openid email ${SCOPE.gmailRead} ${SCOPE.calendarRead}` } }));
    g.on('GET', USERINFO_URL, () => ({ json: { email: 'owner@example.com' } }));

    const start = await call('GET', '/agent/google/auth/start');
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const state = new URL(url).searchParams.get('state')!;

    const cb = await call('GET', `/agent/google/callback?code=auth-code-123&state=${encodeURIComponent(state)}&scope=x`, undefined, false);
    expect(cb.status).toBe(200);
    const html = await cb.text();
    expect(html).toContain('Connected — you can close this tab');
    for (const leak of ['auth-code-123', state, 'tok-access', 'tok-refresh', CLIENT_SECRET]) expect(html.includes(leak)).toBe(false);
    expect(cb.headers.get('cache-control')).toBe('no-store');
    expect(cb.headers.get('referrer-policy')).toBe('no-referrer');
    expect(cb.headers.get('content-security-policy')).toContain("default-src 'none'");

    const replay = await call('GET', `/agent/google/callback?code=auth-code-123&state=${encodeURIComponent(state)}`, undefined, false);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain('expired or was already used');

    const status = (await (await call('GET', '/agent/google/status')).json()) as Record<string, unknown>;
    expect(status).toMatchObject({ connected: true, email: 'owner@example.com', configured: true, needsReconnect: false });
  });

  test('auth start explains what is missing', async () => {
    const res = await call('GET', '/agent/google/auth/start');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/client ID/);
  });

  test('disconnect revokes and forgets', async () => {
    configureClient();
    connectWith([SCOPE.gmailRead], { now: g.now });
    g.on('POST', REVOKE_URL, () => ({ json: {} }));
    const res = await call('POST', '/agent/google/disconnect');
    expect(await res.json()).toEqual({ ok: true, revoked: true });
    expect(((await (await call('GET', '/agent/google/status')).json()) as { connected: boolean }).connected).toBe(false);
  });

  test('changing to another OAuth client drops the old connection', async () => {
    configureClient();
    connectWith([SCOPE.gmailRead], { now: g.now });
    g.on('POST', REVOKE_URL, () => ({ json: {} }));
    const typo = await call('PUT', '/agent/google/client', { clientId: '999-other.apps.google.com', clientSecret: 'GOCSPX-another-one' });
    expect(typo.status).toBe(400);
    expect(g.find('POST', '/revoke')).toHaveLength(0); // an invalid client keeps the connection
    const same = await call('PUT', '/agent/google/client', { clientId: CLIENT_ID, clientSecret: 'GOCSPX-rotated-secret' });
    expect(((await same.json()) as { connected: boolean }).connected).toBe(true); // a rotated secret keeps it too
    const res = await call('PUT', '/agent/google/client', { clientId: '999-other.apps.googleusercontent.com', clientSecret: 'GOCSPX-another-one' });
    expect(((await res.json()) as { connected: boolean }).connected).toBe(false);
    expect(g.find('POST', '/revoke')).toHaveLength(1);
  });

  test('detects the Tailscale Funnel URL for this bridge', async () => {
    _setAgentDepsForTest({ port: 3111, async sendMessage() { return { ok: true }; }, interruptSession() {}, broadcastToSession() {}, broadcastSessionList() {} });
    g.setCommandOutput({ stdout: FUNNEL_SAMPLE });
    const res = (await (await call('GET', '/agent/google/detect-base-url')).json()) as { url: string | null };
    expect(res.url).toBe('https://box.tail0000.ts.net:10000');
    expect(g.commands[0]).toEqual(['/usr/bin/tailscale', 'funnel', 'status']);
  });
});

const FUNNEL_SAMPLE = `
# Funnel on:
#     - https://box.tail0000.ts.net
#     - https://box.tail0000.ts.net:10000

https://box.tail0000.ts.net:10000 (Funnel on)
|-- / proxy http://127.0.0.1:3111

https://box.tail0000.ts.net (Funnel on)
|-- /                                              proxy http://127.0.0.1:3000
|-- /cc                                            proxy http://127.0.0.1:3115
|-- /src                                           proxy http://127.0.0.1:4323/src

https://box.tail0000.ts.net:8443 (tailnet only)
|-- / proxy http://127.0.0.1:3111
`;

describe('google oauth: who may start it, and what leaks', () => {
  test('only the owner can start a sign-in: a localhost caller gets 403 and no state', async () => {
    configureClient();
    const url = new URL('http://127.0.0.1:3905/agent/google/auth/start');
    const res = (await handleAgentRoute(new Request(url), url, LOCAL_ONLY))!;
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('accounts.google.com');
    expect(_pendingCountForTest()).toBe(0);
  });

  test('the redirect URI is fixed when the sign-in starts, whatever settings say at callback time', async () => {
    configureClient();
    const start = (await (await call('GET', '/agent/google/auth/start')).json()) as { url: string; redirectUri: string };
    const authUrl = new URL(start.url);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('redirect_uri')).toBe(start.redirectUri);
    updateGoogleSettings(s => ({ ...s, publicBaseUrl: 'https://elsewhere.example.net' }));
    let exchangedWith = '';
    g.on('POST', TOKEN_URL, req => { exchangedWith = req.form().get('redirect_uri') ?? ''; return { json: { access_token: 'at-x', refresh_token: 'rt-x', expires_in: 3600, scope: SCOPE.gmailRead } }; });
    g.on('GET', USERINFO_URL, () => ({ json: { email: 'owner@example.com' } }));
    const cb = await call('GET', `/agent/google/callback?code=c&state=${encodeURIComponent(authUrl.searchParams.get('state')!)}`, undefined, false);
    expect(cb.status).toBe(200);
    expect(exchangedWith).toBe(start.redirectUri);
  });

  test('tokens live only in the vault (encrypted), never in logs, status or callback pages', async () => {
    const logs: string[] = [];
    const record = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    const spies = [spyOn(console, 'log').mockImplementation(record), spyOn(console, 'error').mockImplementation(record)];
    try {
      configureClient();
      g.on('POST', TOKEN_URL, req => req.form().get('grant_type') === 'refresh_token'
        ? { json: { access_token: 'tok-access-2', expires_in: 3600, scope: SCOPE.gmailRead } }
        : { json: { access_token: 'tok-access-1', refresh_token: 'tok-refresh-1', expires_in: 1, scope: SCOPE.gmailRead } });
      g.on('GET', USERINFO_URL, () => ({ json: { email: 'owner@example.com' } }));
      const { url } = (await (await call('GET', '/agent/google/auth/start')).json()) as { url: string };
      const cb = await call('GET', `/agent/google/callback?code=c&state=${encodeURIComponent(new URL(url).searchParams.get('state')!)}`, undefined, false);
      const page = await cb.text();
      // Expired at once: this refreshes.
      expect(await getAccessToken()).toBe('tok-access-2');
      const status = await (await call('GET', '/agent/google/status')).text();
      const vaultRaw = readFileSync(agentDataDir('vault.json'), 'utf-8');
      for (const secret of ['tok-access-1', 'tok-access-2', 'tok-refresh-1', CLIENT_SECRET]) {
        expect(page.includes(secret), `callback page: ${secret}`).toBe(false);
        expect(status.includes(secret), `status: ${secret}`).toBe(false);
        expect(logs.join('\n').includes(secret), `logs: ${secret}`).toBe(false);
        expect(vaultRaw.includes(secret), `vault file: ${secret}`).toBe(false);
      }
      expect(getSecretJson<{ refresh_token: string }>('google:tokens')!.refresh_token).toBe('tok-refresh-1');
      // The logs were really captured (the check above isn't vacuous).
      expect(logs.join('\n')).toContain('[google] Connected owner@example.com');
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe('funnel parsing', () => {
  test('finds public mounts that proxy to the port root', () => {
    expect(parseFunnelBases(FUNNEL_SAMPLE, 3111)).toEqual(['https://box.tail0000.ts.net:10000']);
    expect(parseFunnelBases(FUNNEL_SAMPLE, 3115)).toEqual(['https://box.tail0000.ts.net/cc']);
    expect(parseFunnelBases(FUNNEL_SAMPLE, 4323)).toEqual([]);
    expect(parseFunnelBases('', 3111)).toEqual([]);
  });
});

describe('saved logins', () => {
  test('values go into the vault and never come back', async () => {
    const put = await call('PUT', '/agent/secrets/site/GitHub.com', { username: 'jova@example.com', password: 'hunter2-very-secret' });
    expect(put.status).toBe(200);
    const putText = await put.text();
    expect(putText.includes('hunter2-very-secret')).toBe(false);
    expect(putText.includes('jova@example.com')).toBe(false);
    expect(JSON.parse(putText)).toMatchObject({ ok: true, name: 'site:github.com', domain: 'github.com' });

    const stored = getSecretJson<SiteLogin>('site:github.com')!;
    expect(stored.username).toBe('jova@example.com');
    expect(stored.password).toBe('hunter2-very-secret');

    const list = await call('GET', '/agent/secrets?prefix=site:');
    const listText = await list.text();
    expect(listText.includes('hunter2-very-secret')).toBe(false);
    expect(listText.includes('jova@example.com')).toBe(false);
    const { secrets } = JSON.parse(listText) as { secrets: { name: string; domain: string; updatedAt: number }[] };
    expect(secrets).toEqual([{ name: 'site:github.com', domain: 'github.com', updatedAt: expect.any(Number) }]);

    expect((await call('DELETE', '/agent/secrets/site/github.com')).status).toBe(200);
    expect((await call('DELETE', '/agent/secrets/site/github.com')).status).toBe(404);
    expect(getSecretJson('site:github.com')).toBeNull();
  });

  test('input is validated', async () => {
    expect((await call('PUT', '/agent/secrets/site/github.com', { username: 'a' })).status).toBe(400);
    expect((await call('PUT', '/agent/secrets/site/github.com', { username: 'a\nb', password: 'x' })).status).toBe(400);
    expect((await call('PUT', `/agent/secrets/site/${encodeURIComponent('evil.com:80')}`, { username: '', password: 'x' })).status).toBe(400);
    expect((await call('GET', '/agent/secrets?prefix=../')).status).toBe(400);
  });

  test('domains are canonicalised', () => {
    expect(normalizeSiteDomain(' Accounts.Google.com. ')).toBe('accounts.google.com');
    expect(normalizeSiteDomain('münchen.de')).toBe('xn--mnchen-3ya.de');
    expect(normalizeSiteDomain('192.168.1.1')).toBe('192.168.1.1');
    for (const bad of ['', 'localhost:3000', 'https://x.com', 'x.com/login', 'user@x.com', '*.x.com', 'nodot', '-x.com', 'a..b']) {
      expect(() => normalizeSiteDomain(bad)).toThrow();
    }
  });
});
