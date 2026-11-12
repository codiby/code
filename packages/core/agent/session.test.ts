import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { rmSync } from 'fs';
import { loadAgentConfig, reloadAgentConfig, saveAgentConfig } from './config';
import { deliverInbound } from './inbound';
import { registerChannel, unregisterChannel } from './outbox';
import { onBeforeThreadRotate } from './registry';
import { handleAgentRoute } from './routes';
import { _setAgentDepsForTest } from './runtime';
import { agentRotation, ensureAgentSession, rotateAgentThread } from './session';
import type { AgentDeps, ChannelAdapter, ChannelAddress } from './types';
import type { ProviderSession } from '../provider/types';

const tick = () => new Promise(r => setTimeout(r, 5));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await tick();
  }
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(r => { open = r; });
  return { promise, open };
}

function deps(sendMessage: AgentDeps['sendMessage']): AgentDeps {
  return { port: 0, sendMessage, interruptSession() {}, broadcastToSession() {}, broadcastSessionList() {} };
}

describe('rotateAgentThread', () => {
  beforeEach(() => {
    // No runtime while the rotation starts: memory's consolidation hook (when
    // another suite registered it) then returns at once instead of waiting
    // for a real consolidation turn.
    _setAgentDepsForTest(null);
  });

  afterEach(() => {
    _setAgentDepsForTest(null);
  });

  test('forgets the old thread before awaiting close, and joins concurrent requests', async () => {
    const session = ensureAgentSession();
    session.claudeSessionId = 'old-thread';
    session.providerCwd = '/tmp/old-cwd';
    const closing = gate();
    let closeStarted = false;
    session.providerSession = {
      async close() { closeStarted = true; await closing.promise; },
    } as unknown as ProviderSession;

    const rotation = rotateAgentThread('Test rotation');
    expect(agentRotation()).toBe(rotation);
    await until(() => closeStarted);

    // Mid-close: a message that respawned the provider now would start fresh.
    expect(session.claudeSessionId).toBeNull();
    expect(session.providerCwd).toBeNull();
    expect(session.providerSession).toBeNull();
    // A `/new` during the rotation joins it instead of running a second one.
    expect(rotateAgentThread('Second request')).toBe(rotation);

    closing.open();
    await rotation;
    expect(agentRotation()).toBeNull();
  });

  test('a provider spawned during close keeps its new thread', async () => {
    const session = ensureAgentSession();
    session.claudeSessionId = 'old-thread';
    const closing = gate();
    let closeStarted = false;
    session.providerSession = { async close() { closeStarted = true; await closing.promise; } } as unknown as ProviderSession;
    const rotation = rotateAgentThread('Test rotation');
    await until(() => closeStarted);
    // Something spawned the new thread meanwhile and it reported its id.
    const fresh = { async close() {} } as unknown as ProviderSession;
    session.providerSession = fresh;
    session.claudeSessionId = 'new-thread';
    session.runtimeStatus = 'running';
    closing.open();
    await rotation;
    expect(session.claudeSessionId).toBe('new-thread');
    expect(session.providerSession).toBe(fresh);
    expect(session.runtimeStatus).toBe('running');
    session.providerSession = null;
    session.claudeSessionId = null;
  });
});

describe('inbound during a rotation', () => {
  let channel: ChannelAdapter;
  const owner: ChannelAddress = { channelId: '', channelType: 'telegram', peer: 'owner-chat' };

  beforeEach(() => {
    _setAgentDepsForTest(null);
    saveAgentConfig({ ...loadAgentConfig(), enabled: true });
    owner.channelId = 'rot-' + randomUUID().slice(0, 6);
    channel = {
      id: owner.channelId,
      type: 'telegram',
      name: 'Rotation test',
      capabilities: { images: false, files: false, voice: false, edits: false, buttons: false, typing: false, maxLength: 4096, markup: 'plain' },
      ownerAddress: () => owner,
      start() {},
      stop() {},
      async send() { return {}; },
      status: () => ({ connected: true }),
    };
    registerChannel(channel);
  });

  afterEach(() => {
    unregisterChannel(channel.id);
    _setAgentDepsForTest(null);
    reloadAgentConfig();
  });

  test('an owner message waits for the fresh thread instead of resuming the old one', async () => {
    const session = ensureAgentSession();
    session.claudeSessionId = 'old-thread';
    const hook = gate();
    let hookEntered = false;
    const off = onBeforeThreadRotate(async () => { hookEntered = true; await hook.promise; });
    const sent: { text: string; threadAtSend: string | null }[] = [];
    try {
      const rotation = rotateAgentThread('Test rotation');
      await until(() => hookEntered);
      _setAgentDepsForTest(deps(async (_sid, text) => {
        sent.push({ text, threadAtSend: session.claudeSessionId });
        return { ok: true };
      }));

      const delivery = deliverInbound({ ...owner, trusted: true, text: 'hola', externalId: `rot-${randomUUID()}` });
      await tick();
      await tick();
      expect(sent).toHaveLength(0); // held while the rotation's hooks run

      hook.open();
      const res = await delivery;
      await rotation;
      expect(res.outcome).toBe('agent');
      expect(sent).toHaveLength(1);
      expect(sent[0]!.threadAtSend).toBeNull();
      expect(sent[0]!.text).toMatch(/hola$/);
    } finally {
      off();
      hook.open();
    }
  });

  test('a model or workspace saved in the Agent view reaches the existing agent session', async () => {
    const original = loadAgentConfig();
    const session = ensureAgentSession();
    const prevSession = { model: session.model, cwd: session.cwd };
    const put = (body: unknown) => {
      const url = new URL('http://localhost/agent/config');
      return handleAgentRoute(new Request(url, { method: 'PUT', body: JSON.stringify(body) }), url, true);
    };
    const dir = `${original.workspaceDir}-moved-${randomUUID().slice(0, 6)}`;
    try {
      session.model = 'picked-in-the-tab';
      // A save that doesn't touch the model leaves the tab's choice alone.
      expect((await put({ persona: { style: 'model-sync-test' } }))!.status).toBe(200);
      expect(session.model).toBe('picked-in-the-tab');

      expect((await put({ model: 'claude-test-model', workspaceDir: dir }))!.status).toBe(200);
      // Before: both stayed whatever the session was created with.
      expect(session.model).toBe('claude-test-model');
      expect(session.cwd).toBe(dir);
    } finally {
      saveAgentConfig(original);
      session.model = prevSession.model;
      session.cwd = prevSession.cwd;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('without a rotation, messages go straight through', async () => {
    const sent: string[] = [];
    _setAgentDepsForTest(deps(async (_sid, text) => { sent.push(text); return { ok: true }; }));
    expect(agentRotation()).toBeNull();
    const res = await deliverInbound({ ...owner, trusted: true, text: 'direct', externalId: `rot-${randomUUID()}` });
    expect(res.outcome).toBe('agent');
    expect(sent).toHaveLength(1);
  });
});
