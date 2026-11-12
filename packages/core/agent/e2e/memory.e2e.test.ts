/**
 * E2E — `/new` from a channel: the agent gets its consolidation turn, the
 * provider thread is replaced, and what it remembered is still there in the
 * fresh thread.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { getSessionState } from '../../session/state';
import { runningChannel } from '../channels/manager';
import type { TelegramChannel } from '../channels/telegram/adapter';
import { loadMemorySettings, memoryStateStore, patchMemorySettings } from '../memory/settings';
import { AGENT_SESSION_ID, getAgentSession } from '../session';
import { api, bootAgent, OWNER_TG_CHAT, waitFor, type AgentHarness } from './harness';

let h: AgentHarness;
let tgId: string;
let consolidateBefore = true;
const telegram = () => runningChannel(tgId) as TelegramChannel;

beforeAll(async () => {
  h = await bootAgent();
  tgId = (await h.addChannel({ type: 'telegram', name: 'Telegram' })).id;
  consolidateBefore = loadMemorySettings().consolidateOnRotate;
  patchMemorySettings({ consolidateOnRotate: true });
});

afterAll(async () => {
  patchMemorySettings({ consolidateOnRotate: consolidateBefore });
  await h.shutdown();
});

beforeEach(() => h.reset());

describe('memory end to end', () => {
  test('8 · /new rotates the thread; memory saved before (and during consolidation) is recalled after', async () => {
    const tg = h.transports.tg(tgId);

    // 1. The owner tells the agent something worth keeping.
    h.agent.brain = async (_msg, turn) => {
      await turn.mcp('remember', { content: 'Prefers window seats on flights', kind: 'preference', tags: ['travel'] });
      turn.say('Anotado: prefieres ventanilla.').end();
    };
    await telegram().handleUpdate(tg.messageUpdate(OWNER_TG_CHAT, 'recuerda que prefiero ventanilla en los vuelos'));
    await h.agent.idle();
    await waitFor(() => tg.texts(OWNER_TG_CHAT).at(-1) === 'Anotado: prefieres ventanilla.', 'the first reply');
    const firstThread = getAgentSession()!.claudeSessionId;
    expect(firstThread).toMatch(/^fake-thread-/);

    // 2. /new — the agent gets one turn to save what it learned, then the thread is replaced.
    let consolidationPrompt = '';
    h.agent.brain = async (msg, turn) => {
      consolidationPrompt = msg.text;
      await turn.mcp('remember', { content: 'Flies to Mexico City every month for work', kind: 'fact', tags: ['travel'] });
      turn.say('NO_REPLY').end();
    };
    const before = tg.visible(OWNER_TG_CHAT).length;
    await telegram().handleUpdate(tg.messageUpdate(OWNER_TG_CHAT, '/new'));
    await h.agent.idle();

    expect(consolidationPrompt).toStartWith('[Memory · before a fresh thread — New conversation]');
    expect(consolidationPrompt).toContain('reply with exactly NO_REPLY');
    // The command itself never reached the agent as a message.
    expect(h.agent.received.map(m => m.text).some(t => t.includes('/new'))).toBe(false);
    // The command answers for itself (its wording is the channels area's) and
    // ends on the fresh-thread confirmation; the consolidation turn's NO_REPLY
    // never shows, and no "Working…" bubble is left behind.
    await waitFor(() => tg.texts(OWNER_TG_CHAT).length > before && tg.texts(OWNER_TG_CHAT).at(-1)!.startsWith('🆕'), 'the /new confirmation');
    const shown = tg.texts(OWNER_TG_CHAT).slice(before);
    expect(shown.at(-1)).toMatch(/^🆕 .*fresh/i);
    expect(shown.filter(t => t.includes('NO_REPLY') || t.startsWith('⏳'))).toEqual([]);

    // The provider thread is gone; the transcript marks the cut; consolidation is recorded.
    expect(getAgentSession()!.claudeSessionId).toBeNull();
    const marker = getSessionState(AGENT_SESSION_ID).messages.findLast(m => m.role === 'system');
    expect(marker?.content).toContain('New conversation: the agent starts a fresh thread here (memory is kept)');
    expect(memoryStateStore.get().lastConsolidation).toMatchObject({ reason: 'New conversation', outcome: 'done', saved: 1 });

    // 3. A fresh thread: the agent recalls both facts.
    const recalled: string[] = [];
    h.agent.brain = async (_msg, turn) => {
      recalled.push(await turn.mcp('recall', { query: 'window seats flights' }));
      recalled.push(await turn.mcp('recall', { query: 'Mexico City' }));
      turn.say('Te gusta la **ventanilla**.').end();
    };
    await telegram().handleUpdate(tg.messageUpdate(OWNER_TG_CHAT, '¿dónde me gusta sentarme en el avión?'));
    await h.agent.idle();

    const secondThread = getAgentSession()!.claudeSessionId;
    expect(secondThread).toMatch(/^fake-thread-/);
    expect(secondThread).not.toBe(firstThread);
    expect(recalled[0]).toContain('Prefers window seats on flights');
    expect(recalled[1]).toContain('Flies to Mexico City every month for work');
    await waitFor(() => tg.texts(OWNER_TG_CHAT).at(-1) === 'Te gusta la *ventanilla*.', 'the answer from the fresh thread');

    // The Agent view's memory list shows both as well.
    const listed = await api('GET', '/agent/memory?limit=200');
    const contents = (listed.body.items as { content: string }[]).map(m => m.content);
    expect(contents).toEqual(expect.arrayContaining(['Prefers window seats on flights', 'Flies to Mexico City every month for work']));
  });
});
