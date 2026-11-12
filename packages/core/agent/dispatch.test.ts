/**
 * Provider failures reaching channels: driven through the real bridge events
 * (createBridgeEvents), so what is asserted is what a channel receives when
 * the provider reports a turn the way the adapters do.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { createBridgeEvents } from '../provider/bridge';
import type { ProviderEvents } from '../provider/types';
import { addMessage, getSessionState, updateSessionState } from '../session/state';
import { loadAgentConfig, reloadAgentConfig, saveAgentConfig } from './config';
import { readFileSync, statSync, writeFileSync } from 'fs';
import {
  CODIBY_NOTICE_PREFIX,
  RESTART_NOTICE,
  RESUME_PROMPT,
  _dispatchIdle,
  _resetDispatch,
  _restoredOrigins,
  _simulateDispatchRestart,
  _startRestoreWatch,
  _tickRestoreWatch,
  primeDispatch,
  providerFailure,
} from './dispatch';
import { agentDataDir } from './store';
import { deliverInbound } from './inbound';
import { _setOutboxSleep, registerChannel, unregisterChannel } from './outbox';
import { onAgentTurnComplete } from './registry';
import { _setAgentDepsForTest, agentDeps, configureAgentRuntime, hasAgentDeps } from './runtime';
import { AGENT_SESSION_ID, ensureAgentSession } from './session';
import type { AgentDeps, ChannelAdapter, ChannelAddress } from './types';

const NOT_LOGGED_IN = 'Not logged in · Please run /login';

let sent: string[];
let finished: number;
let owner: ChannelAddress;
let adapter: ChannelAdapter;
let events: ProviderEvents;
let prevDeps: AgentDeps | null;

const fakeDeps: AgentDeps = {
  port: 0,
  // Like index.ts sendMessageToSession: the message lands in the transcript and the turn starts.
  async sendMessage(sid, text) {
    addMessage(sid, { id: randomUUID(), role: 'user', content: text, timestamp: Date.now() });
    updateSessionState(sid, s => ({ ...s, isStreaming: true, wasInterrupted: false }));
    return { ok: true };
  },
  interruptSession() {},
  broadcastToSession() {},
  broadcastSessionList() {},
};

let seq = 0;
const ask = (text: string) => deliverInbound({ ...owner, trusted: true, text, externalId: `disp-${++seq}-${randomUUID().slice(0, 4)}` });
const delivered = async () => { await _dispatchIdle(); return sent; };

beforeEach(() => {
  sent = [];
  finished = 0;
  prevDeps = hasAgentDeps() ? agentDeps() : null;
  saveAgentConfig({ ...loadAgentConfig(), enabled: true });
  _setOutboxSleep(async () => {});
  _setAgentDepsForTest(fakeDeps);
  _resetDispatch();
  const id = `disp-${randomUUID().slice(0, 6)}`;
  owner = { channelId: id, channelType: 'telegram', peer: 'owner-chat', peerName: 'Owner' };
  adapter = {
    id,
    type: 'telegram',
    name: 'Dispatch test',
    capabilities: { images: false, files: false, voice: false, edits: false, buttons: false, typing: false, maxLength: 4096, markup: 'markdown' },
    ownerAddress: () => owner,
    start() {},
    stop() {},
    async send(_to, msg) { sent.push(msg.text); return {}; },
    turnFinished() { finished++; },
    status: () => ({ connected: true }),
  };
  registerChannel(adapter);
  const session = ensureAgentSession();
  events = createBridgeEvents(session, { broadcastToSession() {}, sendBrowserRequest() {}, broadcastSessionList() {} });
  updateSessionState(AGENT_SESSION_ID, s => ({ ...s, isStreaming: false, wasInterrupted: false, permRequest: null }));
});

afterEach(() => {
  unregisterChannel(adapter.id);
  _setAgentDepsForTest(prevDeps);
  updateSessionState(AGENT_SESSION_ID, s => ({ ...s, isStreaming: false, wasInterrupted: false }));
  reloadAgentConfig();
});

describe('provider failures reach the channel as Codiby notices', () => {
  test('an is_error result ("Not logged in") is a notice, not the agent speaking', async () => {
    await ask('hola');
    events.onTurnComplete({ stopReason: null, resultText: NOT_LOGGED_IN, isError: true, costUsd: 0, durationMs: 3 });
    expect(await delivered()).toEqual([`⚠️ Codiby: ${NOT_LOGGED_IN}`]);
    expect(CODIBY_NOTICE_PREFIX).toBe('⚠️ Codiby: ');
  });

  test('the CLI\'s own failure text is recognised even before the adapter flags isError', async () => {
    await ask('hola');
    events.onTurnComplete({ stopReason: null, resultText: NOT_LOGGED_IN, costUsd: 0, durationMs: 3 });
    expect(await delivered()).toEqual([`⚠️ Codiby: ${NOT_LOGGED_IN}`]);
  });

  test('the same words from the agent itself are delivered as its reply', async () => {
    await ask('what does that error mean?');
    events.onAssistantText('API Error 529 means Anthropic is overloaded; try again in a minute.');
    events.onTurnComplete({ stopReason: 'end_turn' });
    events.onTurnComplete({ stopReason: 'end_turn', resultText: 'API Error 529 means Anthropic is overloaded; try again in a minute.', costUsd: 0.01, durationMs: 9 });
    expect(await delivered()).toEqual(['API Error 529 means Anthropic is overloaded; try again in a minute.']);
  });

  test('what the agent said before the failure still goes, then the notice; internal diagnostics are dropped', async () => {
    await ask('book it');
    events.onAssistantText('Checking availability…');
    events.onTurnComplete({ stopReason: null, isError: true, errors: ['[ede_diagnostic] result_type=user last_content_type=tool_result', 'Overloaded'], costUsd: 0.01, durationMs: 9 });
    expect(await delivered()).toEqual(['Checking availability…', '⚠️ Codiby: Overloaded']);
  });

  test('a failure with no detail still says what happened', async () => {
    await ask('hola');
    events.onTurnComplete({ stopReason: null, isError: true, costUsd: 0, durationMs: 1 });
    expect(await delivered()).toEqual(['⚠️ Codiby: The agent\'s turn failed with a provider error.']);
  });

  test('a turn stopped in the app tells the waiting channel it was interrupted', async () => {
    await ask('long task');
    // What index.ts interruptSessionNow does before the provider reports back.
    updateSessionState(AGENT_SESSION_ID, s => ({ ...s, isStreaming: false, wasInterrupted: true }));
    events.onTurnComplete({ stopReason: null, isError: true, errors: ['[ede_diagnostic] aborted'], costUsd: 0, durationMs: 2 });
    expect(await delivered()).toEqual(['⚠️ Codiby: The agent\'s turn was interrupted before it finished.']);
  });

  test('Codex\'s "interrupted" stop reason is a notice too', async () => {
    await ask('long task');
    events.onTurnComplete({ stopReason: 'interrupted' });
    expect(await delivered()).toEqual(['⚠️ Codiby: The agent\'s turn was interrupted before it finished.']);
  });

  test('a stop asked for from a channel (/stop, a denial) gets no extra notice — the channel already answered', async () => {
    configureAgentRuntime(fakeDeps);
    await ask('long task');
    await agentDeps().interruptSession(AGENT_SESSION_ID);
    updateSessionState(AGENT_SESSION_ID, s => ({ ...s, isStreaming: false, wasInterrupted: true }));
    events.onTurnComplete({ stopReason: null, isError: true, costUsd: 0, durationMs: 2 });
    expect(await delivered()).toEqual([]);
    expect(finished).toBe(1);
  });

  test('a provider error that kills the turn is relayed once, and a late completion still delivers', async () => {
    await ask('hola');
    events.onError(new Error('Claude Code process exited with code 1'));
    events.onError(new Error('Claude Code process exited with code 1'));
    expect(await delivered()).toEqual(['⚠️ Codiby: The agent\'s provider failed: Claude Code process exited with code 1']);
    // The provider recovers and finishes the turn after all.
    events.onAssistantText('Hola, aquí estoy.');
    events.onTurnComplete({ stopReason: 'end_turn' });
    expect(await delivered()).toEqual(['⚠️ Codiby: The agent\'s provider failed: Claude Code process exited with code 1', 'Hola, aquí estoy.']);
  });

  test('an error outside a running turn tells nobody', async () => {
    await ask('hola');
    events.onAssistantText('Listo.');
    events.onTurnComplete({ stopReason: 'end_turn' });
    events.onError(new Error('Claude Code process exited with code 1'));
    expect(await delivered()).toEqual(['Listo.']);
  });

  test('two queued turns failing with the same error both reach their channel', async () => {
    await ask('one');
    await ask('two');
    events.onTurnComplete({ stopReason: null, resultText: NOT_LOGGED_IN, isError: true, costUsd: 0, durationMs: 1 });
    // The provider then runs the queued message, and fails the same way.
    events.onTurnComplete({ stopReason: null, resultText: NOT_LOGGED_IN, isError: true, costUsd: 0, durationMs: 1 });
    expect(await delivered()).toEqual([`⚠️ Codiby: ${NOT_LOGGED_IN}`, `⚠️ Codiby: ${NOT_LOGGED_IN}`]);
  });

  test('turn listeners learn the turn failed', async () => {
    const seen: { texts: string[]; failure?: string }[] = [];
    const off = onAgentTurnComplete((_sid, d) => seen.push(d));
    try {
      await ask('hola');
      events.onTurnComplete({ stopReason: null, resultText: NOT_LOGGED_IN, isError: true, costUsd: 0, durationMs: 1 });
      expect(seen.at(-1)).toEqual({ texts: [], failure: NOT_LOGGED_IN });
    } finally {
      off();
    }
  });

  test('the transcript keeps the error where the app shows it', async () => {
    await ask('hola');
    events.onTurnComplete({ stopReason: null, resultText: NOT_LOGGED_IN, isError: true, costUsd: 0, durationMs: 1 });
    expect(getSessionState(AGENT_SESSION_ID).messages.at(-1)?.content).toBe(NOT_LOGGED_IN);
  });
});

describe('providerFailure', () => {
  test('ordinary turns are not failures', () => {
    expect(providerFailure({ stopReason: 'end_turn', resultText: 'Hi' }, [])).toBeNull();
    expect(providerFailure(undefined, [])).toBeNull();
  });

  test('the unflagged fallback only matches the CLI\'s own failure lines, as the turn\'s only output', () => {
    const resultOnly = (content: string) => [{ id: 'r', role: 'assistant' as const, content, timestamp: 0, costUsd: 0, durationMs: 1 }];
    expect(providerFailure({}, resultOnly(NOT_LOGGED_IN))).toBe(NOT_LOGGED_IN);
    expect(providerFailure({}, resultOnly('API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'))).toMatch(/^API Error: 529/);
    expect(providerFailure({}, resultOnly('Credit balance is too low'))).toBe('Credit balance is too low');
    // Replies that only talk about errors are the agent's words.
    expect(providerFailure({}, resultOnly('API Error 529 means the API is overloaded.'))).toBeNull();
    expect(providerFailure({}, resultOnly('Not logged in to Gmail yet — want me to open the login page?'))).toBeNull();
    expect(providerFailure({}, resultOnly('prompt is too long for the summary, I trimmed it'))).toBeNull();
    // Streamed text next to the result means the model answered.
    expect(providerFailure({}, [{ id: 'a', role: 'assistant', content: NOT_LOGGED_IN, timestamp: 0 }, ...resultOnly(NOT_LOGGED_IN)])).toBeNull();
  });

  test('"error" uses the provider\'s text when there is one', () => {
    expect(providerFailure({ stopReason: 'error', resultText: 'Rate limited' }, [])).toBe('Rate limited');
    expect(providerFailure({ stopReason: 'error' }, [])).toBe('The agent\'s turn ended with a provider error.');
  });
});

describe('a bridge restart under a channel message', () => {
  const FILE = agentDataDir('inflight-replies.json');
  const onDisk = () => JSON.parse(readFileSync(FILE, 'utf-8')) as { at: number; pending: { addr: ChannelAddress; noticed: boolean }[]; carried: ChannelAddress[] };
  let offered: boolean;
  const restart = () => {
    _simulateDispatchRestart({ resumeOffered: () => offered, channelPollMs: 1 });
    primeDispatch();
  };
  /** What index.ts does on POST /interrupted-sessions/resume. */
  const resume = () => {
    offered = false;
    addMessage(AGENT_SESSION_ID, { id: randomUUID(), role: 'user', content: RESUME_PROMPT, timestamp: Date.now() });
    updateSessionState(AGENT_SESSION_ID, s => ({ ...s, isStreaming: true, wasInterrupted: false }));
  };

  beforeEach(() => { offered = true; });

  test('the origin is written owner-only when its message arrives, and cleared once answered', async () => {
    await ask('hola');
    expect(statSync(FILE).mode & 0o777).toBe(0o600);
    expect(onDisk().pending.map(p => p.addr)).toEqual([{ channelId: owner.channelId, channelType: 'telegram', peer: 'owner-chat', peerName: 'Owner' }]);
    events.onAssistantText('¡Hola!');
    events.onTurnComplete({ stopReason: 'end_turn' });
    expect(await delivered()).toEqual(['¡Hola!']);
    expect(onDisk()).toMatchObject({ pending: [], carried: [] });
  });

  test('not resumed: the channel is told to send it again', async () => {
    await ask('book the flight');
    restart();
    expect(_restoredOrigins().map(a => a.channelId)).toEqual([owner.channelId]);
    _startRestoreWatch();
    expect(await delivered()).toEqual([]); // still offered for resume
    offered = false; // dismissed in the app
    _tickRestoreWatch();
    expect(await delivered()).toEqual([RESTART_NOTICE]);
    expect(onDisk().pending).toEqual([]);
    // A late completion of something else does not reach it again.
    events.onAssistantText('unrelated');
    events.onTurnComplete({ stopReason: 'end_turn' });
    expect(await delivered()).toEqual([RESTART_NOTICE]);
  });

  test('nothing was offered for resume: the notice goes out as the agent starts', async () => {
    await ask('hola');
    offered = false;
    restart();
    _startRestoreWatch();
    expect(await delivered()).toEqual([RESTART_NOTICE]);
  });

  test('resumed: the origin keeps waiting and gets the reply', async () => {
    await ask('book the flight');
    restart();
    _startRestoreWatch();
    resume();
    _tickRestoreWatch();
    expect(_restoredOrigins()).toEqual([]);
    // Still on disk: a second restart before the reply must not lose it.
    expect(onDisk().pending).toHaveLength(1);
    events.onAssistantText('Booked: AM 123 at 9:05.');
    events.onTurnComplete({ stopReason: 'end_turn' });
    expect(await delivered()).toEqual(['Booked: AM 123 at 9:05.']);
    expect(onDisk().pending).toEqual([]);
  });

  test('resumed and finished before the watch looked: the reply still arrives', async () => {
    await ask('hola');
    restart();
    resume();
    events.onAssistantText('Aquí sigo.');
    events.onTurnComplete({ stopReason: 'end_turn' });
    expect(await delivered()).toEqual(['Aquí sigo.']);
  });

  test('a new message before any resume: the lost one gets its notice first', async () => {
    await ask('first');
    restart();
    await ask('second');
    events.onAssistantText('Answer to second.');
    events.onTurnComplete({ stopReason: 'end_turn' });
    expect(await delivered()).toEqual([RESTART_NOTICE, 'Answer to second.']);
  });

  test('the grace period running out tells the channel even while the offer stands', async () => {
    await ask('hola');
    restart();
    _startRestoreWatch();
    _tickRestoreWatch();
    expect(await delivered()).toEqual([]);
    _tickRestoreWatch(true);
    expect(await delivered()).toEqual([RESTART_NOTICE]);
  });

  test('a channel already told the provider failed is not told again', async () => {
    await ask('hola');
    events.onError(new Error('Claude Code process exited with code 1'));
    expect(await delivered()).toHaveLength(1);
    expect(onDisk().pending[0]!.noticed).toBe(true);
    offered = false;
    restart();
    _startRestoreWatch();
    expect(await delivered()).toHaveLength(1);
  });

  test('carried origins count only when the agent was mid-turn as the bridge stopped', async () => {
    const carried: ChannelAddress = { channelId: owner.channelId, channelType: 'telegram', peer: 'owner-chat' };
    writeFileSync(FILE, JSON.stringify({ at: Date.now(), pending: [], carried: [carried] }));
    offered = false;
    restart();
    expect(_restoredOrigins()).toEqual([]);
    writeFileSync(FILE, JSON.stringify({ at: Date.now(), pending: [], carried: [carried] }));
    offered = true;
    restart();
    expect(_restoredOrigins()).toEqual([carried]);
  });

  test('stale or malformed entries are dropped without a word', async () => {
    const addr: ChannelAddress = { channelId: owner.channelId, channelType: 'telegram', peer: 'owner-chat' };
    writeFileSync(FILE, JSON.stringify({ at: Date.now() - 13 * 3_600_000, pending: [{ addr }], carried: [] }));
    restart();
    expect(_restoredOrigins()).toEqual([]);
    writeFileSync(FILE, JSON.stringify({
      at: Date.now(),
      pending: [{ addr: { ...addr, channelType: 'pager' } }, { addr: { ...addr, peer: '' } }, { addr: { ...addr, peer: 'x'.repeat(600) } }, 'junk', { addr }],
      carried: 'nope',
    }));
    restart();
    expect(_restoredOrigins()).toEqual([addr]);
    writeFileSync(FILE, '{oops');
    restart();
    expect(_restoredOrigins()).toEqual([]);
  });
});

describe('per-channel delivery queues', () => {
  test('a channel stuck on a send does not hold up another channel\'s reply', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const slowSent: string[] = [];
    const slow: ChannelAdapter = { ...adapter, id: `${adapter.id}-slow`, async send(_to, msg) { await gate; slowSent.push(msg.text); return {}; } };
    registerChannel(slow);
    try {
      await deliverInbound({ ...owner, channelId: slow.id, trusted: true, text: 'a', externalId: `q-${randomUUID()}` });
      await ask('b');
      events.onAssistantText('Both answered.');
      events.onTurnComplete({ stopReason: 'end_turn' });
      await new Promise(r => setTimeout(r, 10));
      // The fast channel has its reply while the slow one is still sending.
      expect(sent).toEqual(['Both answered.']);
      expect(slowSent).toEqual([]);
      release();
      await _dispatchIdle();
      expect(slowSent).toEqual(['Both answered.']);
    } finally {
      unregisterChannel(slow.id);
    }
  });
});
