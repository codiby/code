/**
 * Inbound — the one door into the agent.
 *
 * Every channel adapter calls `deliverInbound(envelope)`. Owner messages go
 * to the agent session (waking it if it idled out — no message is lost);
 * anyone else's are stored as untrusted content and never become a prompt.
 */

import { createHash, randomUUID } from 'crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { and, eq, ne } from 'drizzle-orm';
import { database } from '../database';
import { agentMessages } from '../database/schema';
import { log, logError } from '../lib/logger';
import { loadAgentConfig } from './config';
import { channelHeader } from './format';
import { emitUntrustedInbound, runInboundInterceptors } from './registry';
import { agentDeps } from './runtime';
import { AGENT_SESSION_ID, agentRotation, ensureAgentSession } from './session';
import { agentDataDir } from './store';
import { getChannel, rememberOwnerAddress } from './outbox';
import { recordTurnOrigin } from './dispatch';
import { contentId } from './channels/delivery';
import { getChannelConfig } from './channels/config';
import type { ChannelAddress, InboundAttachment, InboundEnvelope } from './types';

export interface InboundResult {
  ok: boolean;
  /** 'agent' — sent to the agent · 'untrusted' — stored only · 'consumed' — handled by a command/interceptor · 'duplicate' */
  outcome?: 'agent' | 'untrusted' | 'consumed' | 'duplicate';
  error?: string;
}

const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  http_webhook: 'Webhook',
  ios_shortcut: 'iOS Shortcut',
  app: 'App',
};

export function channelLabel(env: ChannelAddress): string {
  const adapter = getChannel(env.channelId);
  return adapter?.name || CHANNEL_LABELS[env.channelType] || env.channelType;
}

/** The sender's name as one path segment: its last component, safe characters only. */
export function safeName(name: string): string {
  return basename(name.replace(/\\/g, '/')).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
}

/**
 * Save non-image attachments under ~/.codiby/agent/files/YYYY-MM-DD/.
 *
 * What keeps a file inside that folder: the sender's name is reduced to one
 * segment of safe characters behind a random prefix (no separators, no
 * absolute paths, no `..`); the day folder must resolve to exactly
 * <agent dir>/files/<day> (a symlinked `files/` or day folder is refused);
 * and the file is created exclusively (O_EXCL), so nothing already at that
 * path — a file or a planted symlink — is ever written through.
 */
export function saveAttachment(att: InboundAttachment): string | null {
  if (att.path) return att.path;
  if (!att.data) return null;
  const day = new Date().toISOString().slice(0, 10);
  const dir = agentDataDir('files', day);
  mkdirSync(dir, { recursive: true });
  if (realpathSync(dir) !== join(realpathSync(agentDataDir()), 'files', day)) {
    throw new Error('the attachments folder points outside ~/.codiby/agent/files');
  }
  const ext = (att.mime.split('/')[1]?.split(';')[0] ?? '').replace(/[^\w.+-]+/g, '').slice(0, 20) || 'bin';
  const name = att.name ? safeName(att.name) : `${att.kind}-${Date.now()}.${ext}`;
  const path = join(dir, `${randomUUID().slice(0, 8)}-${name}`);
  writeFileSync(path, Buffer.from(att.data, 'base64'), { flag: 'wx', mode: 0o600 });
  return path;
}

/**
 * Image types the model accepts inline. Anything else (HEIC from an iPhone,
 * SVG, TIFF…) is rejected by the API — and the rejected message stays in the
 * conversation, so every later turn of the agent would fail with it.
 */
const INLINE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Text + images the agent receives for one envelope. */
export function composeAgentMessage(env: InboundEnvelope): { text: string; images: { media_type: string; data: string }[] } {
  const { persona } = loadAgentConfig();
  const lines: string[] = [channelHeader(channelLabel(env), env.receivedAt ?? Date.now(), persona.timezone)];
  if (env.text.trim()) lines.push(env.text.trim());
  const images: { media_type: string; data: string }[] = [];
  for (const att of env.attachments ?? []) {
    const mime = (att.mime || 'image/jpeg').toLowerCase().split(';')[0]!.trim().replace('image/jpg', 'image/jpeg');
    if (att.kind === 'image' && att.data && INLINE_IMAGE_TYPES.has(mime)) {
      images.push({ media_type: mime, data: att.data });
      continue;
    }
    if (att.kind === 'audio' && att.transcript) {
      lines.push(`🎙️ Voice note (transcribed): ${att.transcript.trim()}`);
      continue;
    }
    try {
      const path = saveAttachment(att);
      if (path) lines.push(`📎 ${att.kind} attached (${att.mime}) — saved at ${path}`);
    } catch (err) {
      lines.push(`📎 ${att.kind} attached but could not be saved: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { text: lines.join('\n'), images };
}

/** Identifies an attachment's content without putting megabytes of base64 into the id's input. */
function attachmentFingerprint(att: InboundAttachment): string {
  const body = att.data ? createHash('sha256').update(att.data).digest('hex').slice(0, 16) : att.path ?? '';
  return `${att.kind}:${att.mime}:${att.name ?? ''}:${body}`;
}

/**
 * An envelope without a channel-native id would reach the agent once per
 * delivery attempt — a sender retrying after a timeout gets the owner's
 * message answered twice. When the sender stamped it (`receivedAt`), the
 * same message always hashes to the same id, so the retry is dropped as a
 * duplicate. Without a timestamp there is nothing stable to hash (identical
 * text sent twice on purpose must not collapse), so it is left alone; the
 * adapters that need it keep their own RetryWindow (channels/delivery.ts).
 */
export function withFallbackExternalId(env: InboundEnvelope): InboundEnvelope {
  if (env.externalId || typeof env.receivedAt !== 'number' || !Number.isFinite(env.receivedAt)) return env;
  const externalId = contentId([env.channelId, env.peer, env.receivedAt, env.text, ...(env.attachments ?? []).map(attachmentFingerprint)]);
  return { ...env, externalId };
}

function alreadySeen(env: InboundEnvelope): boolean {
  if (!env.externalId) return false;
  try {
    // A copy that never reached the agent doesn't count: the sender retries
    // exactly those (a webhook after our error), and dropping the retry as a
    // duplicate would lose the message for good.
    const row = database.select({ id: agentMessages.id }).from(agentMessages)
      .where(and(
        eq(agentMessages.direction, 'in'),
        eq(agentMessages.channelId, env.channelId),
        eq(agentMessages.externalId, env.externalId),
        ne(agentMessages.status, 'failed'),
      ))
      .get();
    return !!row;
  } catch {
    return false;
  }
}

function logInbound(env: InboundEnvelope, status: string): string {
  const now = Date.now();
  const id = randomUUID();
  try {
    database.insert(agentMessages).values({
      id,
      direction: 'in',
      channelId: env.channelId,
      channelType: env.channelType,
      peer: env.peer,
      peerName: env.peerName ?? null,
      trusted: env.trusted,
      kind: 'text',
      text: env.text.slice(0, 20_000),
      media: JSON.stringify((env.attachments ?? []).map(a => ({ kind: a.kind, mime: a.mime, path: a.path ?? null, name: a.name ?? null, transcript: a.transcript ?? null }))),
      externalId: env.externalId ?? null,
      status,
      createdAt: env.receivedAt ?? now,
      updatedAt: now,
    }).run();
  } catch (err) {
    logError(`[agent] could not log inbound message: ${err}`);
  }
  return id;
}

/**
 * Never hold a message longer than this for a rotation: its consolidation
 * turn is capped at two minutes, and a close() that hangs past that must not
 * swallow the owner's messages. The old thread id is gone by then anyway.
 */
export const ROTATION_HOLD_MAX_MS = 180_000;

/** Wait out a thread rotation in progress (bounded, never throws). */
async function waitForRotation(): Promise<void> {
  const pending = agentRotation();
  if (!pending) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>(resolve => { timer = setTimeout(resolve, ROTATION_HOLD_MAX_MS); });
  try {
    await Promise.race([pending.catch(() => {}), cap]);
  } finally {
    clearTimeout(timer);
  }
}

function setStatus(id: string, status: string, error?: string) {
  try {
    database.update(agentMessages).set({ status, error: error ?? null, updatedAt: Date.now() }).where(eq(agentMessages.id, id)).run();
  } catch {}
}

/**
 * A configured channel the owner switched off. Its adapter is stopped, but a
 * message already in flight (a WhatsApp voice note still transcribing, a
 * webhook request mid-body) must not land after the switch.
 */
function channelDisabled(channelId: string): boolean {
  try {
    return getChannelConfig(channelId)?.enabled === false;
  } catch {
    return false;
  }
}

export async function deliverInbound(envelope: InboundEnvelope): Promise<InboundResult> {
  const cfg = loadAgentConfig();
  if (!cfg.enabled) return { ok: false, error: 'The agent is disabled on this host' };
  if (channelDisabled(envelope.channelId)) return { ok: false, error: 'This channel is disabled' };
  const env = withFallbackExternalId(envelope);
  if (alreadySeen(env)) return { ok: true, outcome: 'duplicate' };

  if (!env.trusted) {
    logInbound(env, 'received');
    emitUntrustedInbound(env);
    log(`[agent] stored untrusted ${env.channelType} message from ${env.peerName || env.peer}`);
    return { ok: true, outcome: 'untrusted' };
  }

  const rowId = logInbound(env, 'received');
  rememberOwnerAddress(env);

  if (await runInboundInterceptors(env)) {
    setStatus(rowId, 'consumed');
    return { ok: true, outcome: 'consumed' };
  }

  // After the interceptors: "/new" and approval codes are handled by them and
  // must not wait — the rotation's own consolidation turn may be waiting on
  // exactly that approval.
  await waitForRotation();
  ensureAgentSession();
  const { text, images } = composeAgentMessage(env);
  const forgetOrigin = recordTurnOrigin(env);
  let res: { ok: boolean; error?: string };
  try {
    res = await agentDeps().sendMessage(AGENT_SESSION_ID, text, images.length ? images : undefined, {
      source: { channelType: env.channelType, channelId: env.channelId, peerName: env.peerName, trusted: true },
    });
  } catch (err) {
    // A provider that can't be spawned at all (an unknown or uninstalled
    // CLI) throws instead of answering ok:false. The row must still end up
    // 'failed': left 'received', the sender's retry is dropped as a duplicate.
    res = { ok: false, error: err instanceof Error ? err.message : String(err) };
    logError(`[agent] could not hand a ${env.channelType} message to the agent: ${res.error}`);
  }
  if (!res.ok) {
    forgetOrigin();
    setStatus(rowId, 'failed', res.error);
    return { ok: false, error: res.error || 'Could not reach the agent session' };
  }
  setStatus(rowId, 'delivered');
  try { await getChannel(env.channelId)?.typing?.(env); } catch {}
  return { ok: true, outcome: 'agent' };
}
