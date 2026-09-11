/** Bun owns the remote registry. Electron only owns its direct SSH tunnels. */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CODIBY_DIR = join(homedir(), '.codiby');
export interface Remote {
  id: string;
  name: string;
  alias: string;
  bunPort: number;
  color: string;
  createdAt: number;
  ssh?: { identityFile: string; knownHostsFile: string; hostKeyAlias: string; port: number };
}

let registryUrl: (() => Promise<string>) | undefined;
export function configureRemoteRegistry(resolveUrl: () => Promise<string>) {
  registryUrl = resolveUrl;
}

export async function loadRemotes(): Promise<Remote[]> {
  if (!registryUrl) throw new Error('Remote registry is not configured');
  const response = await fetch(`${await registryUrl()}/remotes`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Remote registry unavailable (HTTP ${response.status})`);
  const data = await response.json();
  if (!Array.isArray(data) || data.some(r => !r || typeof r.id !== 'string'
    || typeof r.alias !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(r.alias)
    || !Number.isInteger(r.bunPort) || r.bunPort < 1 || r.bunPort > 65535)) {
    throw new Error('Invalid remote registry response');
  }
  return data as Remote[];
}

export async function getRemote(id: string): Promise<Remote | null> {
  return (await loadRemotes()).find(r => r.id === id) ?? null;
}
