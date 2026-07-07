/**
 * Base class every concrete provider session extends.
 *
 * A `ProviderSession` is the per-request runtime an adapter's `spawn()` returns.
 * Across providers the transport differs wildly (Claude's continuous `query()`,
 * Codex's per-turn runs, opencode's event loop), but the scaffolding is the
 * same: a stable `sessionId`, the owning `provider` name, the bridge `events`
 * sink, and a `closed` guard that makes every method a no-op after teardown.
 *
 * That shared state lives here so concrete sessions carry only their
 * provider-specific machinery (queues, pending-permission maps, SDK handles)
 * rather than re-declaring the same four members each time.
 */
import type { ImageInput, PermissionMode, ProviderEvents, ProviderSession } from './types';

export abstract class ProviderSessionBase implements ProviderSession {
  readonly sessionId: string;
  readonly provider: string;
  protected readonly events: ProviderEvents;
  protected closed = false;

  constructor(provider: string, sessionId: string, events: ProviderEvents) {
    this.provider = provider;
    this.sessionId = sessionId;
    this.events = events;
  }

  /**
   * Flip the `closed` guard exactly once. Returns `true` the first time (the
   * caller should run its teardown) and `false` on every later call (already
   * closed — the caller should early-return).
   */
  protected beginClose(): boolean {
    if (this.closed) return false;
    this.closed = true;
    return true;
  }

  abstract sendUserMessage(input: { text: string; images?: ImageInput[] }): Promise<void>;
  abstract interrupt(): Promise<void>;
  abstract setModel(model: string | null): Promise<void>;
  abstract setPermissionMode(mode: PermissionMode): Promise<void>;
  abstract close(): Promise<void>;
}
