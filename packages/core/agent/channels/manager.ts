/**
 * Channel lifecycle: builds an adapter per enabled channel config, registers
 * it with the outbox, and restarts just that one when its settings change.
 * Channels only run while the agent runs on this host (onAgentStart /
 * onAgentStop), so two hosts with the same bot token don't fight over it.
 */

import { log, logError } from '../../lib/logger';
import { transcribeAudioBuffer } from '../../integrations/deepgram';
import { registerChannel, unregisterChannel } from '../outbox';
import type { ChannelAdapter } from '../types';
import { getChannelConfig, getChannelSecret, listChannelConfigs, type ChannelConfig, type WhatsAppChannelConfig } from './config';
import { createTelegramApi } from './telegram/api';
import { TelegramChannel } from './telegram/adapter';
import { bunCliRunner } from './whatsapp/cli';
import { WhatsAppChannel } from './whatsapp/adapter';
import { WebhookChannel } from './webhook/adapter';

export type ChannelFactory = (cfg: ChannelConfig) => ChannelAdapter;

async function transcribe(audio: Uint8Array): Promise<string> {
  return (await transcribeAudioBuffer(audio)).transcript;
}

export function whatsappChannelFor(cfg: WhatsAppChannelConfig): WhatsAppChannel {
  return new WhatsAppChannel(cfg, { run: bunCliRunner, transcribe }, () => getChannelSecret(cfg.id, 'token'));
}

const defaultFactory: ChannelFactory = (cfg) => {
  switch (cfg.type) {
    case 'telegram': {
      const token = getChannelSecret(cfg.id, 'token');
      return new TelegramChannel(cfg.id, cfg.name, { api: createTelegramApi(token ?? ''), transcribe, poll: true }, !!token);
    }
    case 'whatsapp':
      return whatsappChannelFor(cfg);
    case 'http_webhook':
    case 'ios_shortcut':
      return new WebhookChannel(cfg, {}, {
        token: () => getChannelSecret(cfg.id, 'token'),
        signing: () => getChannelSecret(cfg.id, 'signing'),
      });
  }
};

let factory: ChannelFactory = defaultFactory;
const running = new Map<string, ChannelAdapter>();
const startErrors = new Map<string, string>();
let active = false;
/** Serialises start/stop so a config save during boot can't double-start a bot. */
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

async function startOne(cfg: ChannelConfig): Promise<void> {
  if (running.has(cfg.id)) return;
  startErrors.delete(cfg.id);
  let adapter: ChannelAdapter;
  try {
    adapter = factory(cfg);
  } catch (err) {
    startErrors.set(cfg.id, err instanceof Error ? err.message : String(err));
    return;
  }
  running.set(cfg.id, adapter);
  registerChannel(adapter);
  try {
    await adapter.start();
    log(`[channels] Started ${cfg.name} (${cfg.type})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    startErrors.set(cfg.id, message);
    logError(`[channels] ${cfg.name} failed to start: ${message}`);
  }
}

async function stopOne(id: string): Promise<void> {
  const adapter = running.get(id);
  if (!adapter) return;
  running.delete(id);
  unregisterChannel(id);
  try {
    await adapter.stop();
  } catch (err) {
    logError(`[channels] ${adapter.name} failed to stop cleanly: ${err instanceof Error ? err.message : err}`);
  }
}

export function startChannels(): Promise<void> {
  return serial(async () => {
    active = true;
    for (const cfg of listChannelConfigs()) if (cfg.enabled) await startOne(cfg);
  });
}

export function stopChannels(): Promise<void> {
  return serial(async () => {
    active = false;
    for (const id of [...running.keys()]) await stopOne(id);
  });
}

/** Apply a config change to one channel: stop it, then start it again if it should run. */
export function restartChannel(id: string): Promise<void> {
  return serial(async () => {
    await stopOne(id);
    if (!active) return;
    const cfg = getChannelConfig(id);
    if (cfg?.enabled) await startOne(cfg);
  });
}

export function runningChannel(id: string): ChannelAdapter | null {
  return running.get(id) ?? null;
}

export function runningChannels(): ChannelAdapter[] {
  return [...running.values()];
}

export function channelStartError(id: string): string | null {
  return startErrors.get(id) ?? null;
}

/** True while the agent (and so its channels) runs on this host. */
export function channelsActive(): boolean {
  return active;
}

/** Tests only. */
export function _setChannelFactory(f: ChannelFactory | null): void {
  factory = f ?? defaultFactory;
}
