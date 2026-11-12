import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { registerProvider } from '../provider/registry';
import { isKnownProvider, loadAgentConfig, normalizeAgentConfig, patchAgentConfig, saveAgentConfig, type AgentConfig } from './config';
import { HttpError } from './http';
import { handleAgentRoute } from './routes';

// A uniquely named fake keeps the shared registry non-empty (so names are
// actually checked) without shadowing a real adapter other suites rely on.
const FAKE = 'config-test-provider';
const owner = { authenticated: true, ownerVerified: true };

const put = async (body: unknown) => {
  const url = new URL('http://127.0.0.1:3111/agent/config');
  const res = await handleAgentRoute(new Request(url, { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), url, owner);
  return { status: res!.status, body: await res!.json() as any };
};

let original: AgentConfig;
beforeAll(() => {
  registerProvider({ name: FAKE, spawn() { throw new Error('not spawned in this test'); } });
  original = loadAgentConfig();
});
afterAll(() => { saveAgentConfig(original); });

describe('agent config provider', () => {
  test('only registered providers (and the default) are known', () => {
    expect(isKnownProvider(FAKE)).toBe(true);
    expect(isKnownProvider('claude')).toBe(true);
    expect(isKnownProvider('no-such-provider')).toBe(false);
  });

  test('normalize keeps a registered provider and falls back to the default for anything else', () => {
    expect(normalizeAgentConfig({ provider: FAKE }).provider).toBe(FAKE);
    expect(normalizeAgentConfig({ provider: ` ${FAKE} ` }).provider).toBe(FAKE);
    expect(normalizeAgentConfig({ provider: 'no-such-provider' }).provider).toBe('claude');
    expect(normalizeAgentConfig({ provider: 42 }).provider).toBe('claude');
    expect(normalizeAgentConfig({ provider: '' }).provider).toBe('claude');
  });

  test('patch refuses an unknown provider with a 400 and keeps the previous one', () => {
    saveAgentConfig({ ...loadAgentConfig(), provider: FAKE });
    let thrown: unknown;
    try { patchAgentConfig({ provider: 'no-such-provider' }); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(400);
    expect(() => patchAgentConfig({ provider: 7 })).toThrow('provider must be a string');
    expect(loadAgentConfig().provider).toBe(FAKE);
    // null resets to the default.
    expect(patchAgentConfig({ provider: null }).provider).toBe('claude');
  });

  test('PUT /agent/config answers 400 for an unknown provider and saves nothing from that body', async () => {
    saveAgentConfig({ ...loadAgentConfig(), provider: 'claude', model: null });
    const bad = await put({ provider: 'no-such-provider', model: 'should-not-stick' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('Unknown provider');
    expect(bad.body.error).toContain(FAKE);
    expect(loadAgentConfig().provider).toBe('claude');
    expect(loadAgentConfig().model).toBeNull();

    const ok = await put({ provider: FAKE });
    expect(ok.status).toBe(200);
    expect(ok.body.provider).toBe(FAKE);
    expect(loadAgentConfig().provider).toBe(FAKE);
  });
});
