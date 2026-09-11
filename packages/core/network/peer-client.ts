import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Remote } from '../types';
import type { HostIdentity } from './host-identity';
import { isPeerWrite, type PeerTool } from './peer-protocol';

type PeerConnection = { baseUrl: string; release: () => void };
type Dependencies = {
  identity: () => HostIdentity;
  remotes: () => Remote[];
  pin: (id: string, hostId: string) => void;
  credentials?: (id: string) => Record<string, string>;
  connect: (remoteId: string) => Promise<PeerConnection>;
};
export type HostEntry = { hostId?: string; remoteId?: string; name: string; local: boolean; status: 'online' | 'offline' | 'disabled'; coordination: string; error?: string };

export class PeerClient {
  constructor(private deps: Dependencies) {}

  private async identityAt(baseUrl: string): Promise<HostIdentity> {
    const response = await fetch(`${baseUrl}/host`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Host discovery failed (HTTP ${response.status}); update the destination server`);
    const identity = await response.json() as HostIdentity;
    if (identity.protocolVersion !== this.deps.identity().protocolVersion || typeof identity.hostId !== 'string'
      || !/^host_[a-zA-Z0-9-]+$/.test(identity.hostId)) throw new Error('Incompatible host protocol');
    return identity;
  }

  private assertRoute(remote: Remote) {
    const current = this.deps.remotes().find(r => r.id === remote.id);
    if (!current || current.alias !== remote.alias || current.serverAlias !== remote.serverAlias || current.bunPort !== remote.bunPort) {
      throw new Error('Remote connection settings changed during setup; retry discovery');
    }
  }

  async inspect(remote: Remote): Promise<HostEntry> {
    const entry = { remoteId: remote.id, hostId: remote.hostId, name: remote.name, local: false, coordination: remote.coordination ?? 'off' };
    let connection: PeerConnection | undefined;
    try {
      connection = await this.deps.connect(remote.id);
      const identity = await this.identityAt(connection.baseUrl);
      if (identity.hostId === this.deps.identity().hostId) throw new Error('This remote points back to the local host');
      this.assertRoute(remote);
      this.deps.pin(remote.id, identity.hostId);
      return { ...entry, hostId: identity.hostId, status: 'online' };
    } catch (error: any) {
      return { ...entry, status: 'offline', error: error.message };
    } finally { connection?.release(); }
  }

  async listHosts(): Promise<HostEntry[]> {
    const local = this.deps.identity();
    const hosts: HostEntry[] = [{ hostId: local.hostId, name: local.name, local: true, status: 'online', coordination: 'write' }];
    // Sequential discovery bounds SSH process creation even with a large registry.
    for (const remote of this.deps.remotes()) {
      hosts.push(!remote.coordination || remote.coordination === 'off'
        ? { remoteId: remote.id, hostId: remote.hostId, name: remote.name, local: false, status: 'disabled', coordination: 'off' }
        : await this.inspect(remote));
    }
    return hosts;
  }

  async call(hostId: string, tool: PeerTool, args: Record<string, unknown>, owner: string): Promise<CallToolResult> {
    const local = this.deps.identity();
    let remote = this.deps.remotes().find(r => r.hostId === hostId || r.id === hostId);
    if (!remote) {
      await this.listHosts();
      remote = this.deps.remotes().find(r => r.hostId === hostId);
    }
    if (!remote) throw new Error(`Unknown host ${hostId}; configure it on this Bun server and call ui_list_hosts`);
    if (!remote.coordination || remote.coordination === 'off') throw new Error('MCP coordination is disabled for this host');
    if (isPeerWrite(tool) && remote.coordination !== 'write') throw new Error('This host permits read-only coordination');
    const requestId = isPeerWrite(tool) ? (args.request_id ?? randomUUID()) : undefined;
    const connection = await this.deps.connect(remote.id);
    try {
      const destination = await this.identityAt(connection.baseUrl);
      if (destination.hostId === local.hostId) throw new Error('Remote route points to the local host');
      this.assertRoute(remote);
      this.deps.pin(remote.id, destination.hostId);
      if (hostId !== remote.id && hostId !== destination.hostId) throw new Error('Target host identity mismatch');
      // Re-check after asynchronous connection setup: revocations take effect before dispatch.
      const current = this.deps.remotes().find(r => r.id === remote!.id);
      if (!current || current.coordination === 'off' || !current.coordination
        || (isPeerWrite(tool) && current.coordination !== 'write')) throw new Error('Host coordination permission was revoked');
      const { host_id: _, request_id: __, ...localArgs } = args;
      const response = await fetch(`${connection.baseUrl}/peer/tools`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...this.deps.credentials?.(remote.id) },
        signal: AbortSignal.timeout(isPeerWrite(tool) ? 120_000 : 15_000),
        body: JSON.stringify({ protocolVersion: local.protocolVersion, targetHostId: destination.hostId,
          source: { hostId: local.hostId, sessionId: owner }, requestId, tool, args: localArgs }),
      });
      const body = await response.json() as { error?: string; hostId?: string; result?: CallToolResult };
      if (!response.ok) throw new Error(body.error || `Peer HTTP ${response.status}`);
      if (body.hostId !== destination.hostId || !body.result || !Array.isArray(body.result.content)) throw new Error('Invalid peer response');
      return { ...body.result, content: [
        { type: 'text', text: `Host: ${destination.hostId} (${remote.name})${requestId ? ` · request_id: ${requestId}` : ''}` },
        ...body.result.content,
      ] };
    } catch (error: any) {
      throw new Error(`${error.message}${requestId ? ` · request_id: ${requestId}. Reuse this ID and the same arguments on retry.` : ''}`);
    } finally { connection.release(); }
  }
}
