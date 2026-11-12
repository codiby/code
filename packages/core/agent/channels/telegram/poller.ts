/**
 * Long-polling loop for one bot, with the self-healing the old Telegraf
 * integration had: when getUpdates fails it backs off and resumes instead of
 * dying silently (the bot used to look alive while receiving nothing).
 *
 * 409 Conflict means another process polls the same token — typically a
 * second Codiby host with the agent enabled. Backing off slowly lets the
 * rival's lease lapse without the two fighting every second.
 */

import { log, logError } from '../../../lib/logger';
import { TelegramApiError, type TelegramApi, type TgUpdate } from './api';

const LONG_POLL_SEC = 50;
const ALLOWED_UPDATES = ['message', 'callback_query'];

/** Conflict: 60 s growing linearly to 5 min. Other failures: 5 s doubling to 5 min. */
export function pollBackoffMs(kind: 'conflict' | 'transient', failures: number): number {
  const n = Math.max(1, failures);
  if (kind === 'conflict') return Math.min(60_000 * n, 300_000);
  return Math.min(5_000 * 2 ** (n - 1), 300_000);
}

export interface PollerHooks {
  onUpdate(update: TgUpdate): Promise<void> | void;
  /** A getUpdates round trip succeeded. */
  onHealthy(): void;
  /** Polling failed; it retries after `retryInMs` unless `fatal`. */
  onError(message: string, info: { retryInMs: number | null; fatal: boolean }): void;
}

export class TelegramPoller {
  private stopped = true;
  private abort: AbortController | null = null;
  private wake: (() => void) | null = null;
  private offset: number | undefined;
  private loop: Promise<void> | null = null;

  constructor(private readonly api: TelegramApi, private readonly hooks: PollerHooks) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    this.wake?.();
    try { await this.loop; } catch {}
    this.loop = null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.wake = null; resolve(); }, ms);
      this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
    });
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        const updates = await this.api.getUpdates({ offset: this.offset, timeout: LONG_POLL_SEC, allowedUpdates: ALLOWED_UPDATES }, this.abort.signal);
        if (failures > 0) log('[telegram] Polling resumed');
        failures = 0;
        this.hooks.onHealthy();
        for (const update of updates) {
          // Advance first: a handler that throws must not wedge the queue on one update.
          this.offset = update.update_id + 1;
          try {
            await this.hooks.onUpdate(update);
          } catch (err) {
            logError(`[telegram] Update ${update.update_id} failed: ${err instanceof Error ? err.message : err}`);
          }
        }
      } catch (err) {
        if (this.stopped) break;
        failures++;
        const code = err instanceof TelegramApiError ? err.code : 0;
        const message = err instanceof Error ? err.message : String(err);
        if (code === 401 || code === 404) {
          this.hooks.onError('The bot token was rejected by Telegram', { retryInMs: null, fatal: true });
          break;
        }
        if (code === 409 && /webhook/i.test(message)) {
          this.hooks.onError('This bot has a webhook set, so it cannot be polled. Remove the webhook (deleteWebhook) to use it here.', { retryInMs: null, fatal: true });
          break;
        }
        const conflict = code === 409;
        const delay = code === 429 && err instanceof TelegramApiError && err.retryAfter
          ? err.retryAfter * 1000
          : pollBackoffMs(conflict ? 'conflict' : 'transient', failures);
        if (conflict) log(`[telegram] getUpdates conflict — another instance polls this bot. Retrying in ${Math.round(delay / 1000)}s`);
        else logError(`[telegram] Polling failed: ${message}. Retrying in ${Math.round(delay / 1000)}s`);
        this.hooks.onError(conflict ? 'Another Codiby instance is polling this bot' : message, { retryInMs: delay, fatal: false });
        await this.sleep(delay);
      } finally {
        this.abort = null;
      }
    }
  }
}
