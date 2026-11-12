import { describe, expect, test } from 'bun:test';
import { loadOrCreateMobileToken } from '../config/config';
import { callerInput, isOwnerVerifiedRequest } from '../network/local-trust';
import { listRoutes } from './registry';
import { handleAgentRoute, isSensitiveRoute } from './routes';
import type { AgentRoute } from './types';

// What index.ts passes for `curl localhost:3111/...` from the agent's Bash, and for the app.
const localCli = { authenticated: true, ownerVerified: false };
const owner = { authenticated: true, ownerVerified: true };

const get = (path: string, auth: Parameters<typeof handleAgentRoute>[2]) => {
  const url = new URL(`http://127.0.0.1${path}`);
  return handleAgentRoute(new Request(url), url, auth);
};

const route = (method: AgentRoute['method'], path: string, extra: Partial<AgentRoute> = {}): AgentRoute =>
  ({ method, path, handler: () => new Response('x'), ...extra });

describe('GET routes that reveal the owner or secret names', () => {
  test('GET /agent/config (owner chat ids, numbers, emails) needs the token or the app', async () => {
    const shell = await get('/agent/config', localCli);
    expect(shell!.status).toBe(403);
    const refusal = await shell!.text();
    expect(refusal).not.toMatch(/telegramChatIds/);
    expect(JSON.parse(refusal).error).toMatch(/only be read from the Codiby app/);
    const app = await get('/agent/config', owner);
    expect(app!.status).toBe(200);
    expect(await app!.json()).toHaveProperty('owner');
  });

  test('the vault\'s routes and a channel\'s secret are sensitive whatever the area registering them says', () => {
    expect(isSensitiveRoute(route('GET', '/agent/secrets'))).toBe(true);
    expect(isSensitiveRoute(route('GET', '/agent/secrets', { sensitive: false }))).toBe(true);
    expect(isSensitiveRoute(route('GET', '/agent/secrets/site/:domain'))).toBe(true);
    expect(isSensitiveRoute(route('GET', '/agent/channels/:id/secret'))).toBe(true);
    // Lookalikes are not swept in, and public routes keep authenticating themselves.
    expect(isSensitiveRoute(route('GET', '/agent/secretsauce'))).toBe(false);
    expect(isSensitiveRoute(route('GET', '/agent/status'))).toBe(false);
    expect(isSensitiveRoute(route('POST', '/agent/channels/:id/inbound', { public: true }))).toBe(false);
  });

  test('reads of personal data (messages, people, memory, channels, activity, approvals) need the token or the app', async () => {
    const reads = ['/agent/messages', '/agent/people', '/agent/people/:id', '/agent/memory', '/agent/memory/settings', '/agent/channels', '/agent/activity', '/agent/approvals'];
    for (const path of reads) expect(isSensitiveRoute(route('GET', path)), path).toBe(true);
    // An area saying otherwise doesn't reopen them.
    expect(isSensitiveRoute(route('GET', '/agent/messages', { sensitive: false }))).toBe(true);
    // Neighbours stay as they were.
    expect(isSensitiveRoute(route('GET', '/agent/channels/alerts'))).toBe(false);
    expect(isSensitiveRoute(route('GET', '/agent/peoplex'))).toBe(false);
    expect(isSensitiveRoute(route('GET', '/agent/heartbeat'))).toBe(false);
    for (const r of listRoutes().filter(r => r.method === 'GET' && reads.includes(r.path))) {
      const path = r.path.replace(/:[^/]+/g, 'x');
      expect((await get(path, localCli))!.status, path).toBe(403);
    }
    expect((await get('/agent/messages?limit=1', owner))!.status).toBe(200);
  });

  test('every registered route under /agent/secrets is refused to a bare localhost caller', async () => {
    const secretRoutes = listRoutes().filter(r => r.path.startsWith('/agent/secrets'));
    for (const r of secretRoutes) expect(isSensitiveRoute(r)).toBe(true);
    if (secretRoutes.some(r => r.method === 'GET' && r.path === '/agent/secrets')) {
      expect((await get('/agent/secrets?prefix=site:', localCli))!.status).toBe(403);
    }
  });

  test('the desktop app still passes: a same-origin GET carries Sec-Fetch-Site, a remote viewer an Origin', () => {
    const token = loadOrCreateMobileToken();
    const verify = (headers: Record<string, string>, peer = '127.0.0.1') => {
      const url = new URL('http://127.0.0.1:3111/agent/config');
      return isOwnerVerifiedRequest(callerInput(new Request(url, { headers: { host: '127.0.0.1:3111', ...headers } }), url, peer), token);
    };
    expect(verify({ 'sec-fetch-site': 'same-origin' })).toBe(true);
    expect(verify({ origin: 'http://localhost:3111', 'sec-fetch-site': 'cross-site' })).toBe(true);
    expect(verify({ authorization: `Bearer ${token}` }, '192.168.1.20')).toBe(true);
    // curl from the agent's shell: no Origin, no Sec-Fetch-Site, no token.
    expect(verify({})).toBe(false);
  });
});
