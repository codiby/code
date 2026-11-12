/**
 * E2E — approvals and policy. A provider turn asks for permission through
 * the real bridge (`onPermissionRequest`), the policy decides, the approval
 * fans out to every owner channel, and the owner answers from one of them.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { loadAgentConfig } from '../config';
import { getSessionState } from '../../session/state';
import { runningChannel } from '../channels/manager';
import type { TelegramChannel } from '../channels/telegram/adapter';
import { listPendingApprovals } from '../policy/approvals';
import { evaluateToolCall } from '../policy/evaluate';
import { AGENT_SESSION_ID } from '../session';
import { agentDataDir } from '../store';
import {
  AGENT_CTX,
  api,
  bootAgent,
  BRIDGE_PORT,
  OWNER_TG_CHAT,
  OWNER_WA,
  stillPending,
  STRANGER_WA,
  waitFor,
  wacliPayload,
  within,
  type AgentHarness,
} from './harness';
import { executeAgentTool } from '../tools';

let h: AgentHarness;
let tgId: string;
let waId: string;

const inboundPath = (id: string) => `/agent/channels/${encodeURIComponent(id)}/inbound`;
const waToken = () => h.transports.wa(waId).registeredToken(`http://127.0.0.1:${BRIDGE_PORT}${inboundPath(waId)}`)!;
const telegram = () => runningChannel(tgId) as TelegramChannel;

interface ActivityItem { requestId: string | null; toolName: string; category: string; decision: string; decidedVia: string | null }
async function activityFor(requestId: string): Promise<ActivityItem | undefined> {
  const res = await api<{ items: ActivityItem[] }>('GET', '/agent/activity?limit=200');
  return res.body.items.find(i => i.requestId === requestId);
}

beforeAll(async () => {
  h = await bootAgent();
  tgId = (await h.addChannel({ type: 'telegram', name: 'Telegram' })).id;
  waId = (await h.addChannel({ type: 'whatsapp', name: 'WhatsApp', binary: '/opt/fake/wacli', account: 'codiby' })).id;
});

afterAll(async () => {
  await h.shutdown();
});

beforeEach(() => h.reset());

describe('approvals end to end', () => {
  test('3 · send_message to a non-owner: prompt on every owner channel, "si <code>" on WhatsApp approves, Telegram shows Approved, activity says whatsapp', async () => {
    const tg = h.transports.tg(tgId);
    const wacli = h.transports.wa(waId);
    const input = { channelId: waId, to: STRANGER_WA, text: 'Hola Bob, Jova llega a las 5.' };
    let call: { requestId: string; decision: Promise<unknown> } | null = null;
    let decided: unknown = null;

    // The owner asks on Telegram; the agent wants to message Bob, which needs approval.
    h.agent.brain = async (_msg, turn) => {
      call = turn.call('mcp__codiby-code__send_message', input);
      decided = await call.decision;
      if (!(decided as { allow: boolean }).allow) { turn.say('No le escribí a Bob.').end(); return; }
      const out = await executeAgentTool('send_message', input, AGENT_CTX);
      turn.result(call.requestId, (out.content[0] as { text: string }).text);
      turn.say('Listo, le avisé a Bob.').end();
    };
    await telegram().handleUpdate(tg.messageUpdate(OWNER_TG_CHAT, 'dile a Bob que llego a las 5'));
    const { requestId, decision } = await waitFor(() => call, 'the agent\'s permission request');

    // Not auto-allowed: the turn waits for the owner.
    expect(await stillPending(decision)).toBe(true);
    expect(getSessionState(AGENT_SESSION_ID).permRequest?.requestId).toBe(requestId);

    // Telegram: a message with Approve / Deny buttons.
    const tgPrompt = await waitFor(() => tg.visible(OWNER_TG_CHAT).find(m => m.buttons?.includes(`pa:${requestId}`)), 'the Telegram approval');
    expect(tgPrompt.buttons).toEqual([`pa:${requestId}`, `pd:${requestId}`]);
    expect(tgPrompt.text).toContain('Send a message');
    expect(tgPrompt.text).toContain('Hola Bob, Jova llega a las 5.');

    // WhatsApp: the same request as text with a code to answer.
    const waPrompt = await waitFor(() => wacli.textsTo(OWNER_WA).find(t => /\bSI \d{4}\b/.test(t)), 'the WhatsApp approval');
    const code = /\bSI (\d{4})\b/.exec(waPrompt)![1]!;
    expect(waPrompt).toContain(`NO ${code}`);
    expect(waPrompt).toContain('Send a message');
    expect(tgPrompt.text).toContain(`SI ${code}`);
    // Bob has not heard anything yet.
    expect(wacli.textsTo(STRANGER_WA)).toEqual([]);

    const listed = (await api('GET', '/agent/approvals')).body.approvals.find((a: { requestId: string }) => a.requestId === requestId);
    expect(listed).toMatchObject({ code, category: 'send_external', sessionId: AGENT_SESSION_ID });

    // Bob saw nothing, but say he guesses the code: other people never answer approvals.
    await api('POST', inboundPath(waId), wacliPayload({ chat: STRANGER_WA, from: STRANGER_WA, pushName: 'Bob', text: `SI ${code}` }),
      { authenticated: false, headers: { 'x-codiby-token': waToken() } });
    // Nor does the owner's own number writing in a group.
    await api('POST', inboundPath(waId), wacliPayload({ chat: '120363000000000001@g.us', isGroup: true, from: OWNER_WA, text: `SI ${code}` }),
      { authenticated: false, headers: { 'x-codiby-token': waToken() } });
    expect(await stillPending(decision, 60)).toBe(true);

    // The owner answers on WhatsApp.
    const answer = await api('POST', inboundPath(waId), wacliPayload({ text: `si ${code}` }), { authenticated: false, headers: { 'x-codiby-token': waToken() } });
    expect(answer.status).toBe(200);
    expect(await within(decision, 'the approval to resolve')).toEqual({ allow: true, updatedInput: input });
    await h.agent.idle();

    // "si 4821" was consumed by the approval interceptor — it never became a prompt.
    expect(h.agent.received).toHaveLength(1);
    // WhatsApp confirms; Bob gets the approved message.
    await waitFor(() => wacli.textsTo(OWNER_WA).includes('✅ Approved.'), 'the WhatsApp confirmation');
    expect(wacli.textsTo(STRANGER_WA)).toEqual(['Hola Bob, Jova llega a las 5.']);

    // Telegram: the approval message now says Approved (via whatsapp) and its buttons are gone…
    const settled = await waitFor(() => tg.visible(OWNER_TG_CHAT).find(m => m.id === tgPrompt.id && m.text.startsWith('✅')), 'the Telegram approval to settle');
    expect(settled.text.startsWith('✅ Approved (via whatsapp)')).toBe(true);
    expect(settled.buttons).toBeNull();
    // …and the working bubble became the agent's answer.
    expect(tg.texts(OWNER_TG_CHAT)).toContain('Listo, le avisé a Bob.');
    expect(getSessionState(AGENT_SESSION_ID).permRequest).toBeNull();

    // Activity log: asked, then approved via whatsapp.
    expect(await activityFor(requestId)).toMatchObject({
      toolName: 'mcp__codiby-code__send_message',
      category: 'send_external:message',
      decision: 'approved',
      decidedVia: 'whatsapp',
    });
    expect((await api('GET', '/agent/approvals')).body.approvals.some((a: { requestId: string }) => a.requestId === requestId)).toBe(false);

    // The code died with the request: answering again is refused, and still not a prompt.
    await api('POST', inboundPath(waId), wacliPayload({ text: `si ${code}` }), { authenticated: false, headers: { 'x-codiby-token': waToken() } });
    await waitFor(() => wacli.textsTo(OWNER_WA).some(t => t.includes(`Approval ${code} was already answered or has expired`)), 'the refusal of a stale code');
    expect(h.agent.received).toHaveLength(1);
  });

  test('3b · a denial from a Telegram button interrupts the turn and is logged as denied via telegram', async () => {
    const tg = h.transports.tg(tgId);
    const wacli = h.transports.wa(waId);
    const turn = h.agent.turn();
    const { requestId, decision } = turn.call('mcp__codiby-code__send_message', { channelId: waId, to: STRANGER_WA, text: 'te debo dinero' });
    const prompt = await waitFor(() => tg.visible(OWNER_TG_CHAT).find(m => m.buttons?.includes(`pd:${requestId}`)), 'the Telegram approval');

    await telegram().handleUpdate(tg.tapUpdate(OWNER_TG_CHAT, prompt.id, `pd:${requestId}`));
    expect(await within(decision, 'the denial')).toEqual({ allow: false, interrupt: true });
    expect(h.agent.interrupts).toContain(AGENT_SESSION_ID);
    const settled = await waitFor(() => tg.visible(OWNER_TG_CHAT).find(m => m.id === prompt.id && !m.buttons), 'the Telegram approval to settle');
    expect(settled.text.startsWith('❌ Denied')).toBe(true);
    expect(await activityFor(requestId)).toMatchObject({ decision: 'denied', decidedVia: 'telegram' });
    expect(wacli.textsTo(STRANGER_WA)).not.toContain('te debo dinero');
  });

  test('3d · an approval nobody answers expires: denied, and every channel says so', async () => {
    const tg = h.transports.tg(tgId);
    const wacli = h.transports.wa(waId);
    const { requestId, decision } = h.agent.turn().call('mcp__codiby-code__send_message', { channelId: waId, to: STRANGER_WA, text: 'ping' });
    const prompt = await waitFor(() => tg.visible(OWNER_TG_CHAT).find(m => m.buttons?.includes(`pa:${requestId}`)), 'the Telegram approval');
    const code = /\bSI (\d{4})\b/.exec(prompt.text)![1]!;
    const timer = await waitFor(() => h.expiries.at(-1), 'the expiry timer');
    expect(timer.ms).toBeGreaterThan(60_000);

    timer.fn(); // the approval timeout elapses
    const d = await within(decision, 'the expiry') as { allow: boolean; message?: string };
    expect(d.allow).toBe(false);
    expect(d.message).toMatch(/didn't answer within/);
    await waitFor(() => tg.visible(OWNER_TG_CHAT).find(m => m.id === prompt.id && !m.buttons), 'the Telegram approval to settle');
    expect(tg.visible(OWNER_TG_CHAT).find(m => m.id === prompt.id)!.text.startsWith('⌛ Expired')).toBe(true);
    // The owner is told on a channel that it was not run.
    await waitFor(() => [...tg.texts(OWNER_TG_CHAT), ...wacli.textsTo(OWNER_WA)].some(t => t.includes(`Approval ${code} expired`)), 'the expiry notice');
    expect(await activityFor(requestId)).toMatchObject({ decision: 'expired', decidedVia: 'expired' });
    expect(wacli.textsTo(STRANGER_WA)).not.toContain('ping');
  });

  test('3e · typing "si <code>" in the Telegram chat leaves the pending turn\'s Working bubble to the turn\'s own answer', async () => {
    // The Working bubble above the prompt belongs to the turn waiting on this
    // approval: the "si <code>" confirmation must not take it over, so the
    // turn's own answer is what finally replaces it.
    const tg = h.transports.tg(tgId);
    const input = { channelId: waId, to: STRANGER_WA, text: 'hola bob' };
    let call: { requestId: string; decision: Promise<unknown> } | null = null;
    h.agent.brain = async (_msg, turn) => {
      call = turn.call('mcp__codiby-code__send_message', input);
      await call.decision;
      turn.result(call.requestId, 'ok');
      turn.say('Listo, le avisé a Bob.').end();
    };
    await telegram().handleUpdate(tg.messageUpdate(OWNER_TG_CHAT, 'avísale a Bob'));
    const { requestId, decision } = await waitFor(() => call, 'the permission request');
    const bubble = tg.visible(OWNER_TG_CHAT).find(m => m.text.startsWith('⏳'))!;
    const prompt = await waitFor(() => tg.visible(OWNER_TG_CHAT).find(m => m.buttons?.includes(`pa:${requestId}`)), 'the approval');
    const code = /\bSI (\d{4})\b/.exec(prompt.text)![1]!;
    await telegram().handleUpdate(tg.messageUpdate(OWNER_TG_CHAT, `si ${code}`));
    await within(decision, 'the approval');
    await h.agent.idle();
    expect(tg.visible(OWNER_TG_CHAT).find(m => m.id === bubble.id)!.text).toBe('Listo, le avisé a Bob.');
  });

  test('3f · an approval answered while its fan-out is still in flight leaves no live prompt on any channel', async () => {
    // A slow or retrying Bot API can hold the fan-out on Telegram while the
    // owner answers in the app. The prompt that lands there afterwards must
    // be settled (no buttons left), and no channel may be handed a prompt
    // for a request that is already answered. Whether the fan-out runs the
    // channels one by one or together, a WhatsApp prompt sent while the
    // request was still pending is fine; one sent after it is not.
    const tg = h.transports.tg(tgId);
    expect((await api('PUT', '/agent/config', { preferredChannel: tgId })).status).toBe(200);
    let release!: () => void;
    tg.holdButtons = new Promise<void>(r => { release = r; });
    const wa = runningChannel(waId)!;
    const originalSend = wa.send.bind(wa);
    const waPrompts: { text: string; pendingAtSend: string[] }[] = [];
    (wa as { send: typeof wa.send }).send = async (to, msg) => {
      if (msg.kind === 'approval' || /\bSI \d{4}\b/.test(msg.text ?? '')) {
        waPrompts.push({ text: msg.text ?? '', pendingAtSend: listPendingApprovals().map(a => a.requestId) });
      }
      return originalSend(to, msg);
    };
    try {
      const { requestId, decision } = h.agent.turn().call('mcp__codiby-code__send_message', { channelId: waId, to: STRANGER_WA, text: 'x' });
      await waitFor(() => listPendingApprovals().some(a => a.requestId === requestId), 'the pending approval');
      expect((await api('POST', `/agent/approvals/${requestId}`, { allow: true })).status).toBe(200);
      await within(decision, 'the app approval');
      release();
      await waitFor(() => tg.visible(OWNER_TG_CHAT).find(m => m.text.includes('Send a message') && m.id === tg.visible(OWNER_TG_CHAT).at(-1)!.id), 'the late Telegram prompt');
      await h.agent.idle();
      expect(tg.visible(OWNER_TG_CHAT).filter(m => m.buttons?.includes(`pa:${requestId}`))).toEqual([]);
      expect(waPrompts.filter(p => !p.pendingAtSend.includes(requestId)).map(p => p.text)).toEqual([]);
    } finally {
      (wa as { send: typeof wa.send }).send = originalSend;
      tg.holdButtons = null;
      release?.();
      await api('PUT', '/agent/config', { preferredChannel: null });
    }
  });

  test('3c · a settled Telegram approval no longer shows "Approval needed" or the reply-code instructions', async () => {
    // The policy area writes the prompt (🔐 header, "Reply SI <code>…",
    // expiry); the channel has to clear all of it once the request is answered.
    const tg = h.transports.tg(tgId);
    const { requestId, decision } = h.agent.turn().call('mcp__codiby-code__send_message', { channelId: waId, to: STRANGER_WA, text: 'x' });
    const prompt = await waitFor(() => tg.visible(OWNER_TG_CHAT).find(m => m.buttons?.includes(`pa:${requestId}`)), 'the Telegram approval');
    await telegram().handleUpdate(tg.tapUpdate(OWNER_TG_CHAT, prompt.id, `pa:${requestId}`));
    await within(decision, 'the approval');
    const settled = await waitFor(() => tg.visible(OWNER_TG_CHAT).find(m => m.id === prompt.id && !m.buttons), 'the settle');
    expect(settled.text).not.toContain('Approval needed');
    expect(settled.text).not.toMatch(/Reply \*?SI \d+/);
  });
});

describe('policy end to end', () => {
  const CONFIG_URL = `http://localhost:${BRIDGE_PORT}/agent/config`;

  test('4 · Bash "curl -X PUT …/agent/config" is never auto-allowed (blocked, or asked and denied) and the config stays', async () => {
    const tg = h.transports.tg(tgId);
    const command = `curl -s -X PUT ${CONFIG_URL} -H 'content-type: application/json' -d '{"enabled":false}'`;
    // Either answer is acceptable here; the policy area decides which.
    const verdict = evaluateToolCall('Bash', { command }).match?.action;
    expect(verdict === 'deny' || verdict === 'ask').toBe(true);

    const turn = h.agent.turn();
    const { requestId, decision } = turn.call('Bash', { command, description: 'Turn the agent off' });

    if (verdict === 'deny') {
      // Blocked outright: the provider hears why, and nobody is asked.
      const d = await within(decision, 'the policy block') as { allow: boolean; message?: string };
      expect(d.allow).toBe(false);
      expect(d.message).toMatch(/Denied by the agent's policy/);
      await h.agent.idle();
      expect(tg.visible(OWNER_TG_CHAT).some(m => m.buttons?.includes(`pa:${requestId}`))).toBe(false);
      expect(h.transports.wa(waId).textsTo(OWNER_WA).some(t => t.includes('/agent/config'))).toBe(false);
      expect(await activityFor(requestId)).toMatchObject({ toolName: 'Bash', decision: 'blocked', decidedVia: 'policy' });
    } else {
      // Asked: the turn waits, the owner sees the command and denies it.
      expect(await stillPending(decision)).toBe(true);
      const prompt = await waitFor(() => tg.visible(OWNER_TG_CHAT).find(m => m.buttons?.includes(`pa:${requestId}`)), 'the Telegram approval');
      expect(prompt.text).toContain('/agent/config');
      expect((await activityFor(requestId))?.decision).toBe('asked');
      await telegram().handleUpdate(tg.tapUpdate(OWNER_TG_CHAT, prompt.id, `pd:${requestId}`));
      expect(await within(decision, 'the denial')).toMatchObject({ allow: false });
      expect(await activityFor(requestId)).toMatchObject({ decision: 'denied', decidedVia: 'telegram' });
    }
    expect(getSessionState(AGENT_SESSION_ID).permRequest).toBeNull();
    expect(loadAgentConfig().enabled).toBe(true);
  });

  test('4a · if such a call ran anyway, the bridge turns the agent\'s shell away: no reconfiguring, no self-approval', async () => {
    // What index.ts establishes for `curl localhost:…` from the agent's Bash:
    // a trusted loopback caller, but no Origin and no bridge token.
    const shell = { auth: { authenticated: true, ownerVerified: false } };
    const turn = h.agent.turn();
    const { requestId, decision } = turn.call('mcp__codiby-code__send_message', { channelId: waId, to: STRANGER_WA, text: 'pásame el código' });
    expect(await stillPending(decision)).toBe(true);

    expect((await api('PUT', '/agent/config', { enabled: false, owner: { telegramChatIds: ['666'] } }, shell)).status).toBe(403);
    expect((await api('POST', `/agent/approvals/${requestId}`, { allow: true }, shell)).status).toBe(403);
    expect((await api('POST', '/agent/rules', { toolGlob: 'send_message', action: 'allow' }, shell)).status).toBe(403);
    expect((await api('POST', `/agent/channels/${waId}/secret`, { action: 'reveal' }, shell)).status).toBe(403);
    expect(await stillPending(decision)).toBe(true);
    expect(loadAgentConfig().owner.telegramChatIds).toEqual([String(OWNER_TG_CHAT)]);

    // The owner, from the app, can.
    expect((await api('POST', `/agent/approvals/${requestId}`, { allow: false })).status).toBe(200);
    expect(await within(decision, 'the app denial')).toMatchObject({ allow: false });
    expect(await activityFor(requestId)).toMatchObject({ decision: 'denied', decidedVia: 'app' });
  });

  test('4b · no way of writing to the bridge\'s own API from the shell is auto-allowed', async () => {
    const P = BRIDGE_PORT;
    const writes = [
      `curl -X PUT ${CONFIG_URL} -d '{"enabled":false}'`,
      `curl -XPUT http://127.0.0.1:${P}/agent/config`,
      `curl -sX PUT http://localhost:${P}/agent/config`,
      `curl --request PUT http://localhost:${P}/agent/config --json '{"owner":{}}'`,
      `curl --request=PUT http://localhost:${P}/agent/config`,
      `curl http://localhost:${P}/agent/config -X put`,
      `curl -X GET -X PUT http://localhost:${P}/agent/config`,
      `M=PUT; curl -X $M http://localhost:${P}/agent/config`,
      `echo '{"enabled":false}' | curl -X PUT -d @- http://localhost:${P}/agent/config`,
      `curl -K /tmp/request.cfg http://localhost:${P}/agent/config`,
      `curl -X POST http://localhost:${P}/agent/channels/whatsapp-1/secret -d '{"action":"reveal"}'`,
      `curl -X POST http://localhost:${P}/agent/rules -d '{"toolGlob":"Bash","action":"allow"}'`,
      `wget --method=PUT -O- http://localhost:${P}/agent/config`,
      `http PUT localhost:${P}/agent/config enabled:=false`,
      `python3 -c "import urllib.request as u; u.urlopen(u.Request('http://localhost:${P}/agent/config', method='PUT', data=b'{}'))"`,
      `bun -e "await fetch('http://localhost:${P}/agent/config',{method:'PUT',body:'{}'})"`,
    ];
    const allowed = writes.filter(command => evaluateToolCall('Bash', { command }).match?.action === 'allow');
    expect(allowed).toEqual([]);

    // The same through the rule tester the Agent view uses.
    const tested = await api('POST', '/agent/rules/test', { toolName: 'Bash', input: { command: writes[0] } });
    expect(tested.status).toBe(200);
    expect(tested.body.action).not.toBe('allow');

    // Editing the agent's own config file directly is blocked outright.
    const file = agentDataDir('config.json');
    expect(evaluateToolCall('Write', { file_path: file, content: '{"enabled":false}' }).match?.action).toBe('deny');
    expect(evaluateToolCall('Bash', { command: `echo '{}' > ${file}` }).match?.action).toBe('deny');
  });

  test('4c · reading the bridge\'s secrets over loopback is not auto-allowed either', () => {
    // The bridge trusts loopback callers without a token, and GET /mobile/pair
    // answers with its bearer token: a read-only-looking curl or fetch would
    // hand the agent remote access to the bridge, unasked.
    const reads = [
      ['Bash', { command: `curl -s http://127.0.0.1:${BRIDGE_PORT}/mobile/pair` }],
      ['Bash', { command: `curl -s http://localhost:${BRIDGE_PORT}/agent/secrets` }],
      ['Bash', { command: `curl -s ${CONFIG_URL}` }],
      ['WebFetch', { url: `http://127.0.0.1:${BRIDGE_PORT}/mobile/pair`, prompt: 'token?' }],
    ] as const;
    const allowed = reads.filter(([tool, input]) => evaluateToolCall(tool, input).match?.action === 'allow');
    expect(allowed).toEqual([]);
  });
});
