import type { ProviderAdapter } from './types';

const adapters = new Map<string, ProviderAdapter>();

export function registerProvider(adapter: ProviderAdapter): void {
  adapters.set(adapter.name, adapter);
}

export function getProvider(name: string): ProviderAdapter {
  const adapter = adapters.get(name);
  if (!adapter) {
    throw new Error(`Unknown provider: ${name}. Registered: ${[...adapters.keys()].join(', ') || '(none)'}`);
  }
  return adapter;
}

export function listProviders(): string[] {
  return [...adapters.keys()];
}

export const DEFAULT_PROVIDER = 'claudeAgent';
