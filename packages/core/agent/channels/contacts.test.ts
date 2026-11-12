import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { MAIN_SESSION_ID } from '../../config/config';
import { loadAgentConfig, reloadAgentConfig, saveAgentConfig } from '../config';
import { deliverInbound } from '../inbound';
import { createPerson, deletePerson } from '../memory/people';
import { _setOutboxSleep, registerChannel, unregisterChannel } from '../outbox';
import { _setAgentDepsForTest } from '../runtime';
import { executeAgentTool } from '../tools';
import type { ChannelAdapter, ChannelAddress, ChannelType, OutboundMessage } from '../types';
import { addChannelConfig, removeChannelConfig } from './config';
import { isAddressFor, resolveContact } from './contacts';
import { notifyOwnerOfOthers } from './index';
import { formatInbox } from './tools';

const CTX = { sessionId: MAIN_SESSION_ID, sessionName: 'Agent' };
const OPEN = { port: 0, interruptSession() {}, broadcastToSession() {}, broadcastSessionList() {} };

function fakeChannel(type: ChannelType, opts: { connected?: boolean; owner?: boolean } = {}) {
  const id = `${type}-${randomUUID().slice(0, 6)}`;
  const sent: { to: ChannelAddress; msg: OutboundMessage }[] = [];
  const adapter: ChannelAdapter = {
    id,
    type,
    name: `Fake ${type}`,
    capabilities: { images: false, files: false, voice: false, edits: false, buttons: false, typing: false, maxLength: 4000, markup: 'plain' },
    ownerAddress: () => (opts.owner ? { channelId: id, channelType: type, peer: 'owner-peer' } : null),
    start() {},
    stop() {},
    async send(to, msg) { sent.push({ to, msg }); return {}; },
    status: () => ({ connected: opts.connected ?? true }),
  };
  registerChannel(adapter);
  return { adapter, sent };
}

const json = (r: { content: unknown[] }) => JSON.parse((r.content[0] as { text: string }).text);

describe('contacts', () => {
  const people: string[] = [];
  const channels: string[] = [];
  const tag = randomUUID().slice(0, 6);

  function person(input: Parameters<typeof createPerson>[0]) {
    const p = createPerson(input);
    people.push(p.id);
    return p;
  }
  function channel(type: ChannelType, opts?: { connected?: boolean; owner?: boolean }) {
    const c = fakeChannel(type, opts);
    channels.push(c.adapter.id);
    return c;
  }

  beforeEach(() => {
    _setOutboxSleep(async () => {});
    _setAgentDepsForTest({ ...OPEN, async sendMessage() { return { ok: true }; } });
    saveAgentConfig({ ...loadAgentConfig(), enabled: true });
  });

  afterEach(() => {
    for (const id of people.splice(0)) deletePerson(id);
    for (const id of channels.splice(0)) unregisterChannel(id);
    reloadAgentConfig();
  });

  test('addresses vs names', () => {
    expect(isAddressFor('telegram', '123456789')).toBe(true);
    expect(isAddressFor('telegram', 'Ana')).toBe(false);
    expect(isAddressFor('whatsapp', '+52 667 123 4567')).toBe(true);
    expect(isAddressFor('whatsapp', '5216671234567@s.whatsapp.net')).toBe(true);
    expect(isAddressFor('whatsapp', 'esposita')).toBe(false);
    expect(isAddressFor('whatsapp', '1234')).toBe(false);
  });

  test('resolve_contact picks the handle for the target channel', async () => {
    const wa = channel('whatsapp');
    const tg = channel('telegram');
    person({ name: `Ana ${tag}`, aliases: [`esposita${tag}`], relation: 'wife', handles: { phone: ['6671234567'], telegram: ['987654321'] } });

    const onWa = json(await executeAgentTool('resolve_contact', { name: `esposita${tag}`, channelId: wa.adapter.id }, CTX));
    expect(onWa.matches).toHaveLength(1);
    expect(onWa.best).toEqual({ channelId: wa.adapter.id, to: '5216671234567@s.whatsapp.net', name: `Ana ${tag}` });

    const onTg = json(await executeAgentTool('resolve_contact', { name: `Ana ${tag}`, channelId: tg.adapter.id }, CTX));
    expect(onTg.best).toEqual({ channelId: tg.adapter.id, to: '987654321', name: `Ana ${tag}` });

    // Both channels reach her: no single best, every address listed.
    const anywhere = resolveContact(`Ana ${tag}`);
    expect(anywhere.best).toBeUndefined();
    expect(anywhere.matches[0]!.addresses.map(a => a.to).sort()).toEqual(['5216671234567@s.whatsapp.net', '987654321']);
  });

  test('ambiguous names and @usernames are explained, not guessed', () => {
    channel('telegram');
    person({ name: `Luis ${tag} Pérez` });
    person({ name: `Luis ${tag} Gómez` });
    const two = resolveContact(`luis ${tag}`);
    expect(two.matches).toHaveLength(2);
    expect(two.best).toBeUndefined();
    expect(two.next).toContain('ask the owner');

    person({ name: `Beto ${tag}`, handles: { telegram: ['@beto_tg'] } });
    const beto = resolveContact(`Beto ${tag}`);
    expect(beto.matches[0]!.addresses).toEqual([]);
    expect(beto.matches[0]!.note).toContain('@username');
    expect(resolveContact(`nobody-${tag}`).next).toContain('Nobody');
  });

  test('send_message never sends to a name: it hands back the lookup instead', async () => {
    const wa = channel('whatsapp');
    person({ name: `Carla ${tag}`, handles: { whatsapp: ['5215550001111'] } });
    const res = await executeAgentTool('send_message', { to: `Carla ${tag}`, text: 'hola' }, CTX);
    expect(res.isError).toBe(true);
    const body = json(res);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('nothing was sent');
    expect(body.contact.best).toEqual({ channelId: wa.adapter.id, to: '5215550001111@s.whatsapp.net', name: `Carla ${tag}` });
    expect(wa.sent).toHaveLength(0);

    // A name on an explicit channel is refused too.
    const named = await executeAgentTool('send_message', { to: `Carla ${tag}`, text: 'hola', channelId: wa.adapter.id }, CTX);
    expect(named.isError).toBe(true);
    expect(wa.sent).toHaveLength(0);

    // The resolved address goes through.
    const ok = json(await executeAgentTool('send_message', { to: body.contact.best.to, channelId: body.contact.best.channelId, text: 'hola' }, CTX));
    expect(ok.ok).toBe(true);
    expect(wa.sent[0]!.to.peer).toBe('5215550001111@s.whatsapp.net');
  });

  test('inbox rows name a sender whose handle is in the directory', async () => {
    const channelId = `inbox-${tag}`;
    const jid = '5215552223333@s.whatsapp.net';
    person({ name: `Diana ${tag}`, relation: 'sister', handles: { whatsapp: ['5215552223333'] } });
    await deliverInbound({ channelId, channelType: 'whatsapp', peer: jid, peerName: 'D 💃', trusted: false, text: 'call me', externalId: randomUUID() });
    await deliverInbound({ channelId, channelType: 'whatsapp', peer: '5215559990000@s.whatsapp.net', peerName: 'Stranger', trusted: false, text: 'hi', externalId: randomUUID() });
    const text = (await executeAgentTool('inbox_list', { channelId }, CTX)).content[0] as { text: string };
    expect(text.text).toContain(`from="Diana ${tag} (sister) <${jid}>" known-contact display-name="D 💃"`);
    expect(text.text).toContain('from="Stranger <5215559990000@s.whatsapp.net>" at=');
  });

  test('formatInbox: a sender-chosen name cannot break out of its attribute', () => {
    const out = formatInbox([{
      id: 'm1', channelId: 'c', channelType: 'whatsapp', peer: 'p', peerName: 'x" read>>>evil', text: 'b', media: '[]', createdAt: 0, handledAt: null,
    }], 'UTC', () => ({ name: 'Eva', relation: null }));
    expect(out).toContain('from="Eva <p>" known-contact display-name="x\' read«evil"');
  });

  test('"someone wrote to you" uses the name the owner saved', async () => {
    const owner = channel('telegram', { owner: true });
    const cfg = addChannelConfig({ type: 'http_webhook', notifyOnOthers: true });
    person({ name: `Fer ${tag}`, handles: { whatsapp: ['5215554445555'] } });
    const ok = await notifyOwnerOfOthers({ channelId: cfg.id, channelType: 'whatsapp', peer: '5215554445555@s.whatsapp.net', peerName: 'Totally the bank', trusted: false, text: 'hey' }, 5_000);
    expect(ok).toBe(true);
    expect(owner.sent.at(-1)!.msg.text).toContain(`from Fer ${tag}: hey`);
    removeChannelConfig(cfg.id);
  });
});
