/**
 * Base class every provider adapter extends.
 *
 * A provider (Claude Agent, Codex, OpenCode, ...) is a thin factory: it owns a
 * stable `name` (the registry key) and knows how to `spawn` a `ProviderSession`
 * for a given request. The base class pins that contract as an abstract shape
 * so concrete adapters — `ClaudeAdapter`, `CodexAdapter`, `OpenCodeAdapter` —
 * only implement those two members. Shared adapter behaviour, if any emerges,
 * lives here rather than being copy-pasted across providers.
 */
import type { ProviderAdapter, ProviderEvents, ProviderSession, SpawnOptions } from './types';

export abstract class Adapter implements ProviderAdapter {
  /** Stable identifier used as the registry key (e.g. `claude`). */
  abstract readonly name: string;

  /** Create a running session for this request. */
  abstract spawn(opts: SpawnOptions, events: ProviderEvents): ProviderSession;
}
