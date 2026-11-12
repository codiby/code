/**
 * Channels (workstream 1): Telegram, WhatsApp (wacli), HTTP webhook and iOS
 * Shortcut adapters; owner slash commands and approval codes; the untrusted
 * inbox tools.
 *
 * Imported for its side effects by agent/index.ts: routes, tools and the
 * prompt section register even while the agent is off (so the UI can set
 * channels up); the channels themselves only run between onAgentStart and
 * onAgentStop.
 */

import { log } from '../../lib/logger';
import { channelLabel } from '../inbound';
import { sendToOwner } from '../outbox';
import { onAgentStart, onAgentStop, onAgentToolUse, onApproval, onUntrustedInbound } from '../registry';
import { AGENT_SESSION_ID } from '../session';
import type { InboundEnvelope } from '../types';
import { installApprovalReplyInterceptor, noteApprovalSettled } from './approvals';
import { installCommandInterceptor } from './commands';
import { getChannelConfig, loadChannelsFile } from './config';
import { contactForPeer } from './contacts';
import { runningChannels, startChannels, stopChannels } from './manager';
import { registerChannelsPrompt } from './prompt';
import { registerChannelRoutes } from './routes';
import { TelegramChannel } from './telegram/adapter';
import { registerChannelTools } from './tools';

registerChannelRoutes();
registerChannelTools();
registerChannelsPrompt();
installApprovalReplyInterceptor();
installCommandInterceptor();

onAgentStart('channels', async () => {
  loadChannelsFile();
  await startChannels();
});
onAgentStop('channels', () => stopChannels());

onAgentToolUse((sessionId, toolName, summary) => {
  if (sessionId !== AGENT_SESSION_ID) return;
  for (const ch of runningChannels()) if (ch instanceof TelegramChannel) ch.onToolUse(toolName, summary);
});

onApproval({
  onResolved(event) {
    // First, and for every channel type: a prompt still on its way to WhatsApp
    // or a webhook checks this when its send (or retry) comes up.
    noteApprovalSettled(event);
    for (const ch of runningChannels()) if (ch instanceof TelegramChannel) void ch.onApprovalResolved(event);
  },
});

// "Someone wrote to you" — opt-in per channel, at most once per sender every 10 minutes.
const NOTIFY_THROTTLE_MS = 10 * 60_000;
const lastNotified = new Map<string, number>();

export async function notifyOwnerOfOthers(env: InboundEnvelope, now = Date.now()): Promise<boolean> {
  const cfg = getChannelConfig(env.channelId);
  if (!cfg?.notifyOnOthers) return false;
  const key = `${env.channelId}:${env.peer}`;
  const prev = lastNotified.get(key);
  if (prev && now - prev < NOTIFY_THROTTLE_MS) return false;
  lastNotified.set(key, now);
  if (lastNotified.size > 1000) lastNotified.delete(lastNotified.keys().next().value!);
  const preview = env.text.replace(/\s+/g, ' ').trim();
  // A saved contact is named the way the owner knows them, not by the display name the sender chose.
  const who = contactForPeer(env.channelType, env.channelId, env.peer)?.name || env.peerName || env.peer;
  const text = `New ${channelLabel(env)} message from ${who}: ${preview.slice(0, 80)}${preview.length > 80 ? '…' : ''}`;
  const res = await sendToOwner({ kind: 'text', text, priority: 'low' });
  if (!res.ok) log(`[channels] Could not tell the owner about a message from ${who}: ${res.error}`);
  return res.ok;
}

onUntrustedInbound(env => { void notifyOwnerOfOthers(env); });

export { channelsStatus } from './tools';
export { restartChannel, runningChannel, startChannels, stopChannels } from './manager';
