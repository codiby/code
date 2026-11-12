/**
 * Owner slash commands, on every channel (`/new`, `/stop`, `/status`,
 * `/model`, `/help`). They run as an inbound interceptor, so they only ever
 * see trusted envelopes and never reach the agent as text. Telegram's
 * `/start` stays in the Telegram adapter because it also drives pairing.
 */

import { log, logError } from '../../lib/logger';
import { effectiveModel } from '../../provider/default-model';
import { saveSessions } from '../../session/sessions';
import { getSessionState } from '../../session/state';
import { loadAgentConfig, patchAgentConfig } from '../config';
import { isRotating } from '../memory/rotation';
import { memoryStateStore } from '../memory/settings';
import { getChannel, listChannels, sendTo, sendToOwner } from '../outbox';
import { addInboundInterceptor } from '../registry';
import { agentDeps } from '../runtime';
import { AGENT_SESSION_ID, ensureAgentSession, rotateAgentThread } from '../session';
import type { InboundEnvelope, OutboundMessage } from '../types';

/** `/model@MyBot opus` → { name: 'model', args: 'opus' }. */
export function parseCommand(text: string): { name: string; args: string } | null {
  const m = /^\/([a-z0-9_]{1,32})(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return m ? { name: m[1]!.toLowerCase(), args: (m[2] ?? '').trim() } : null;
}

export const HELP_TEXT = [
  'Commands:',
  '/new — start a fresh conversation (memory is kept)',
  '/stop — stop what the agent is doing',
  '/status — agent and channel status',
  '/model <id> — switch the model (/model default to reset)',
  '/help — this list',
].join('\n');

export function statusText(): string {
  const cfg = loadAgentConfig();
  const session = ensureAgentSession();
  const state = getSessionState(AGENT_SESSION_ID);
  const activity = state.permRequest
    ? `waiting for approval (${state.permRequest.toolName})`
    : state.isStreaming ? 'working' : session.providerSession ? 'idle' : 'asleep';
  const model = effectiveModel(session) || 'default';
  const lines = [`${cfg.persona.emoji ? `${cfg.persona.emoji} ` : ''}${cfg.persona.name} — ${activity} · ${model}`];
  const channels = listChannels();
  if (channels.length) {
    lines.push('', 'Channels:');
    for (const ch of channels) {
      const st = ch.status();
      const state = st.connected ? 'connected' : `offline${st.lastError ? ` (${st.lastError})` : ''}`;
      lines.push(`• ${ch.name} — ${state}${st.detail ? ` · ${st.detail}` : ''}`);
    }
  }
  return lines.join('\n');
}

async function setModel(arg: string): Promise<string> {
  const session = ensureAgentSession();
  if (!arg) return `Current model: ${effectiveModel(session) || 'default'}\n\nUsage: /model <id> — e.g. /model opus, /model sonnet, /model default`;
  if (!/^[\w.:\-[\]/]{1,100}$/.test(arg)) return 'That does not look like a model id.';
  const next = arg.toLowerCase() === 'default' ? null : arg;
  session.model = next;
  saveSessions();
  // Keep the agent config in step so a thread rotation or respawn keeps the choice.
  patchAgentConfig({ model: next });
  log(`[channels] Agent model set to ${next ?? 'default'}`);
  if (!session.providerSession) return `Model set to ${next ?? 'default'} (applies when the agent wakes up).`;
  try {
    await session.providerSession.setModel(effectiveModel(session));
    return `Model set to ${next ?? 'default'}.`;
  } catch (err) {
    return `Saved ${next ?? 'default'}, but the live switch failed: ${err instanceof Error ? err.message : err}`;
  }
}

// ---------------------------------------------------------------------------
// /new — a fresh thread, after the agent saves what it learned
// ---------------------------------------------------------------------------

export const NEW_THREAD_REASON = 'New conversation';
export const NEW_THREAD_ACK = '🧠 Saving what I learned, then starting a fresh thread…';
export const NEW_THREAD_BUSY = '⏳ A fresh thread is already on its way — I\'ll tell you when it\'s ready.';

let rotate: (reason: string) => Promise<void> = rotateAgentThread;
/** Tests only: stand in for rotateAgentThread (which loads the provider bridge). */
export function _setThreadRotatorForTest(fn: ((reason: string) => Promise<void>) | null): void {
  rotate = fn ?? rotateAgentThread;
}

let freshThread: Promise<void> | null = null;

/** Resolves when the /new started last has finished and been reported (tests). */
export function pendingFreshThread(): Promise<void> | null {
  return freshThread;
}

/** What the owner hears once the fresh thread is ready, from memory's consolidation record. */
export function freshThreadText(startedAt: number): string {
  let last = null;
  try { last = memoryStateStore.get().lastConsolidation; } catch {}
  const record = last && last.at >= startedAt ? last : null;
  const saved = record && (record.outcome === 'done' || record.outcome === 'timeout') ? record.saved : 0;
  const learned = saved > 0 ? ` Saved ${saved} thing${saved === 1 ? '' : 's'} I learned.` : '';
  if (record?.outcome === 'failed') return '🆕 Fresh thread started — but saving what I learned failed, so some of it may be missing.';
  if (record?.outcome === 'timeout') return `🆕 Fresh thread started.${learned} Saving took too long, so some of it may be missing.`;
  return `🆕 Fresh thread started.${learned || ' Memory is kept.'}`;
}

/**
 * Webhook / Shortcut peers are one HTTP request, already answered with the
 * acknowledgement: the "ready" note goes to the channel's owner address (its
 * callback URL) instead, or nowhere if it has none.
 */
async function reportLater(env: InboundEnvelope, msg: OutboundMessage): Promise<void> {
  const type = getChannel(env.channelId)?.type ?? env.channelType;
  if (type === 'http_webhook' || type === 'ios_shortcut') {
    await sendToOwner(msg, { channelId: env.channelId });
    return;
  }
  const res = await sendTo({ channelId: env.channelId, channelType: env.channelType, peer: env.peer, peerName: env.peerName }, msg);
  if (!res.ok) log(`[channels] Could not report the fresh thread on ${env.channelType}: ${res.error}`);
}

/**
 * The consolidation turn before a rotation can take up to two minutes, and
 * awaiting it here would hold the channel's inbound path (Telegram's
 * per-chat queue, a webhook request) the whole time. So: acknowledge now,
 * rotate in the background, report when it's done. Messages sent meanwhile
 * are held by memory until the rotation finishes, so they reach the new thread.
 */
async function startFreshThread(env: InboundEnvelope): Promise<void> {
  if (freshThread || isRotating()) {
    await sendTo(env, { kind: 'text', text: NEW_THREAD_BUSY });
    return;
  }
  const startedAt = Date.now();
  // Started before the acknowledgement goes out, so consolidation is already
  // in flight (and holding new messages) by the time the owner reads it.
  let rotation: Promise<void>;
  try { rotation = rotate(NEW_THREAD_REASON); } catch (err) { rotation = Promise.reject(err); }
  const outcome = rotation.then(() => null, (err: unknown) => err ?? new Error('unknown error'));
  const ack = sendTo(env, { kind: 'text', text: NEW_THREAD_ACK });
  freshThread = (async () => {
    // The "ready" note waits for the acknowledgement, so it can never arrive first.
    await ack.catch(() => {});
    const err = await outcome;
    if (err) logError(`[channels] /new: rotating the agent thread failed: ${err instanceof Error ? err.stack || err.message : err}`);
    // 'normal' priority: posted on its own, so on Telegram it doesn't take
    // over the working bubble of a message sent in the meantime.
    await reportLater(env, {
      kind: 'text',
      priority: 'normal',
      text: err ? `⚠️ Could not start a fresh thread: ${err instanceof Error ? err.message : err}` : freshThreadText(startedAt),
    });
  })()
    .catch(err => logError(`[channels] /new report failed: ${err instanceof Error ? err.message : err}`))
    .finally(() => { freshThread = null; });
  // Only the acknowledgement is awaited: the inbound path is free again as soon as it's out.
  await ack;
}

async function run(name: string, args: string, env: InboundEnvelope): Promise<string | null> {
  switch (name) {
    case 'stop':
      await agentDeps().interruptSession(AGENT_SESSION_ID);
      return '⏹ Stopped.';
    case 'status':
      return statusText();
    case 'model':
      return setModel(args);
    case 'help':
      return HELP_TEXT;
    case 'start':
      // Telegram's /start is handled (with pairing) by its adapter.
      return env.channelType === 'telegram' ? null : HELP_TEXT;
    default:
      return null;
  }
}

export async function interceptCommand(env: InboundEnvelope): Promise<boolean> {
  if (!env.trusted || (env.attachments?.length ?? 0) > 0) return false;
  const cmd = parseCommand(env.text);
  if (!cmd) return false;
  if (cmd.name === 'new') {
    await startFreshThread(env);
    return true;
  }
  const reply = await run(cmd.name, cmd.args, env);
  if (reply === null) return false;
  await sendTo(env, { kind: 'text', text: reply });
  return true;
}

let installed = false;
export function installCommandInterceptor(): void {
  if (installed) return;
  installed = true;
  addInboundInterceptor(interceptCommand);
}
