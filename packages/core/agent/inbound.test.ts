import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { eq } from 'drizzle-orm';
import { database } from '../database';
import { agentMessages } from '../database/schema';
import { loadAgentConfig, reloadAgentConfig, saveAgentConfig } from './config';
import { _resetDispatch } from './dispatch';
import { deliverInbound, safeName, saveAttachment, withFallbackExternalId } from './inbound';
import { agentDataDir } from './store';
import { _setAgentDepsForTest, agentDeps, hasAgentDeps } from './runtime';
import type { AgentDeps, InboundEnvelope } from './types';

describe('externalId fallback', () => {
  const base: InboundEnvelope = { channelId: 'fb-ch', channelType: 'http_webhook', peer: 'p1', trusted: true, text: 'hola' };

  test('an envelope with the sender\'s timestamp and no id gets a stable one', () => {
    const a = withFallbackExternalId({ ...base, receivedAt: 1_700_000_000_000 });
    const b = withFallbackExternalId({ ...base, receivedAt: 1_700_000_000_000 });
    expect(a.externalId).toMatch(/^auto:[0-9a-f]{32}$/);
    expect(b.externalId).toBe(a.externalId!);
  });

  test('any part that identifies the message changes the id', () => {
    const id = (env: Partial<InboundEnvelope>) => withFallbackExternalId({ ...base, receivedAt: 1, ...env }).externalId;
    const ref = id({});
    expect(id({ channelId: 'other' })).not.toBe(ref);
    expect(id({ peer: 'p2' })).not.toBe(ref);
    expect(id({ receivedAt: 2 })).not.toBe(ref);
    expect(id({ text: 'adiós' })).not.toBe(ref);
    // Two photos sent in the same second with no caption are two messages.
    const photo = (data: string) => id({ text: '', attachments: [{ kind: 'image', mime: 'image/jpeg', data }] });
    expect(photo(Buffer.from('one').toString('base64'))).not.toBe(photo(Buffer.from('two').toString('base64')));
  });

  test('a channel-native id is kept, and without a timestamp nothing is invented', () => {
    expect(withFallbackExternalId({ ...base, receivedAt: 5, externalId: 'tg-42' }).externalId).toBe('tg-42');
    expect(withFallbackExternalId(base).externalId).toBeUndefined();
    expect(withFallbackExternalId({ ...base, receivedAt: Number.NaN }).externalId).toBeUndefined();
  });
});

describe('deliverInbound with the fallback id', () => {
  const sentToAgent: string[] = [];
  let prev: AgentDeps | null;

  beforeEach(() => {
    sentToAgent.length = 0;
    prev = hasAgentDeps() ? agentDeps() : null;
    saveAgentConfig({ ...loadAgentConfig(), enabled: true });
    _resetDispatch();
    _setAgentDepsForTest({
      port: 0,
      async sendMessage(_sid, text) { sentToAgent.push(text); return { ok: true }; },
      interruptSession() {},
      broadcastToSession() {},
      broadcastSessionList() {},
    });
  });

  afterEach(() => {
    _setAgentDepsForTest(prev);
    reloadAgentConfig();
  });

  test('a sender retrying the same stamped message reaches the agent once', async () => {
    const channelId = `fb-${randomUUID().slice(0, 6)}`;
    const env: InboundEnvelope = { channelId, channelType: 'ios_shortcut', peer: 'owner', trusted: true, text: 'remind me at 5', receivedAt: Date.now() - 1_000 };
    expect((await deliverInbound(env)).outcome).toBe('agent');
    expect((await deliverInbound({ ...env })).outcome).toBe('duplicate');
    expect(sentToAgent).toHaveLength(1);
    const rows = database.select().from(agentMessages).where(eq(agentMessages.channelId, channelId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.externalId).toMatch(/^auto:/);
    // Sent again later (a new timestamp), it is a new message.
    expect((await deliverInbound({ ...env, receivedAt: env.receivedAt! + 60_000 })).outcome).toBe('agent');
    expect(sentToAgent).toHaveLength(2);
  });

  test('untrusted copies are deduplicated the same way', async () => {
    const channelId = `fb-u-${randomUUID().slice(0, 6)}`;
    const env: InboundEnvelope = { channelId, channelType: 'http_webhook', peer: 'stranger', trusted: false, text: 'hi', receivedAt: 1_700_000_000_123 };
    expect((await deliverInbound(env)).outcome).toBe('untrusted');
    expect((await deliverInbound(env)).outcome).toBe('duplicate');
  });
});

describe('saveAttachment keeps files inside the files folder', () => {
  const day = () => new Date().toISOString().slice(0, 10);
  const filesDir = () => agentDataDir('files', day());
  const data = Buffer.from('payload').toString('base64');
  const inside = (p: string) => dirname(p) === filesDir();

  test('traversal, absolute and Windows-style names become one safe segment', () => {
    for (const name of ['../../../.ssh/authorized_keys', '/etc/hosts', 'C:\\Windows\\System32\\evil.exe', '..', '.', 'a/../../b', 'x\u0000y.txt', '   ', '..\\..\\up.txt']) {
      const p = saveAttachment({ kind: 'file', mime: 'application/octet-stream', name, data })!;
      expect(inside(p), `${name} → ${p}`).toBe(true);
      expect(basename(p)).toMatch(/^[0-9a-f]{8}-[\w.\- ]+$/);
      expect(readFileSync(p, 'utf-8')).toBe('payload');
    }
    expect(safeName('../../../.ssh/authorized_keys')).toBe('authorized_keys');
    expect(safeName('C:\\Windows\\evil.exe')).toBe('evil.exe');
  });

  test('the mime type cannot smuggle a path into a generated name', () => {
    const p = saveAttachment({ kind: 'file', mime: 'application/../../x;evil=1', data })!;
    expect(inside(p)).toBe(true);
    expect(basename(p)).toMatch(/^[0-9a-f]{8}-file-\d+\.[\w.+-]+$/);
  });

  test('saved files are private to the owner', () => {
    const p = saveAttachment({ kind: 'file', mime: 'text/plain', name: 'note.txt', data })!;
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  test('a files folder that is a symlink to somewhere else is refused; nothing is written there', () => {
    const outside = mkdtempSync(join(tmpdir(), 'codiby-outside-'));
    const dir = filesDir();
    const backup = `${dir}.bak-${randomUUID().slice(0, 6)}`;
    const had = existsSync(dir);
    if (had) renameSync(dir, backup);
    try {
      symlinkSync(outside, dir);
      expect(() => saveAttachment({ kind: 'file', mime: 'text/plain', name: 'x.plist', data })).toThrow(/outside/);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(dir, { force: true });
      if (had) renameSync(backup, dir);
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
