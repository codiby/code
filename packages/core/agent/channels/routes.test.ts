import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { loadAgentConfig, reloadAgentConfig, saveAgentConfig } from '../config';
import { listRoutes } from '../registry';
import { handleAgentRoute, isSensitiveRoute } from '../routes';
import './index';
import { addChannelConfig, getChannelSecret, removeChannelConfig, type ChannelConfig } from './config';

/** Trusted for being on localhost (curl, the agent's own Bash) — not the owner's app or token. */
const LOCAL_ONLY = { authenticated: true, ownerVerified: false };

const SENSITIVE: [string, string][] = [
  ['POST', '/agent/channels'],
  ['PATCH', '/agent/channels/:id'],
  ['DELETE', '/agent/channels/:id'],
  ['POST', '/agent/channels/:id/pairings/:chatId'],
  ['POST', '/agent/channels/:id/unpair'],
  ['POST', '/agent/channels/:id/secret'],
  ['POST', '/agent/channels/:id/webhook/register'],
];

describe('channel routes: who may call them', () => {
  let hook: ChannelConfig;

  beforeAll(() => {
    saveAgentConfig({ ...loadAgentConfig(), enabled: true });
    hook = addChannelConfig({ type: 'http_webhook' });
  });

  afterAll(() => {
    removeChannelConfig(hook.id);
    reloadAgentConfig();
  });

  test('owner-creating and secret routes are explicitly sensitive', () => {
    for (const [method, path] of SENSITIVE) {
      const route = listRoutes().find(r => r.method === method && r.path === path);
      expect(route, `${method} ${path}`).toBeDefined();
      expect(route!.sensitive, `${method} ${path}`).toBe(true);
      expect(isSensitiveRoute(route!)).toBe(true);
    }
    // The webhook endpoints authenticate with the channel token instead.
    const inbound = listRoutes().find(r => r.path === '/agent/channels/:id/inbound')!;
    expect(inbound.public).toBe(true);
    expect(isSensitiveRoute(inbound)).toBe(false);
  });

  test('a localhost caller without the bridge token cannot reveal a token or pair a chat', async () => {
    const call = (method: string, path: string, body: unknown) => {
      const url = new URL(`http://127.0.0.1${path}`);
      return handleAgentRoute(new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), url, LOCAL_ONLY);
    };
    const reveal = (await call('POST', `/agent/channels/${hook.id}/secret`, { action: 'reveal' }))!;
    expect(reveal.status).toBe(403);
    expect(await reveal.text()).not.toContain(getChannelSecret(hook.id, 'token')!);
    expect((await call('POST', `/agent/channels/${hook.id}/pairings/123456`, { approve: true }))!.status).toBe(403);
    expect((await call('POST', '/agent/channels', { type: 'http_webhook' }))!.status).toBe(403);
    // The list says which channels reach the owner: the app and token holders read it, a bare local caller doesn't.
    const listUrl = new URL('http://127.0.0.1/agent/channels');
    expect((await handleAgentRoute(new Request(listUrl), listUrl, LOCAL_ONLY))!.status).toBe(403);
    const list = (await handleAgentRoute(new Request(listUrl), listUrl, { authenticated: true, ownerVerified: true }))!;
    expect(list.status).toBe(200);
    expect(await list.text()).not.toContain(getChannelSecret(hook.id, 'token')!);
  });
});
