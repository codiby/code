import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { HostIdentity } from './host-identity';

export const PEER_TOOLS = ['ui_list_sessions', 'ui_read_session_messages', 'ui_send_message', 'ui_spawn_session'] as const;
export type PeerTool = typeof PEER_TOOLS[number];
export function isPeerTool(name: string): name is PeerTool {
  return (PEER_TOOLS as readonly string[]).includes(name);
}
export function isPeerWrite(name: string): boolean {
  return name === 'ui_send_message' || name === 'ui_spawn_session';
}
export function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export type PeerRequest = {
  protocolVersion: number;
  targetHostId: string;
  source: { hostId: string; sessionId: string };
  requestId?: string;
  tool: PeerTool;
  args: Record<string, unknown>;
};
export type ExecutePeerTool = (name: string, args: Record<string, unknown>, owner: string) => Promise<CallToolResult>;

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

/** Persist before dispatch. An interrupted write is reported as uncertain, never replayed. */
export class PeerReceipts {
  private inFlight = new Map<string, Promise<CallToolResult>>();
  constructor(private directory: string) {}

  async run(request: PeerRequest, execute: () => Promise<CallToolResult>): Promise<CallToolResult> {
    if (!request.requestId || !/^[a-zA-Z0-9_-]{1,120}$/.test(request.requestId)) {
      throw new Error('Writes require request_id (1–120 letters, digits, dash or underscore); reuse it when retrying');
    }
    const key = createHash('sha256').update(canonical([request.source, request.requestId])).digest('hex');
    const fingerprint = createHash('sha256').update(canonical([request.targetHostId, request.tool, request.args])).digest('hex');
    mkdirSync(this.directory, { recursive: true });
    const path = join(this.directory, `${key}.json`);
    try {
      writeFileSync(path, JSON.stringify({ fingerprint, state: 'dispatching', request }), { flag: 'wx', mode: 0o600 });
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      if (receipt.fingerprint !== fingerprint) throw new Error('request_id was already used for a different operation');
      const running = this.inFlight.get(key);
      if (running) return running;
      if (receipt.result) return receipt.result;
      throw new Error('Delivery outcome unknown after interrupted dispatch. Inspect the target session before sending a new request_id.');
    }
    // Defer invocation until the promise is registered, including synchronous failures.
    const work = Promise.resolve().then(execute).then(result => {
      const temp = `${path}.tmp`;
      writeFileSync(temp, JSON.stringify({ fingerprint, state: 'completed', result }), { mode: 0o600 });
      renameSync(temp, path);
      return result;
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }
}

/** Only local session tools are executable here; forwarded calls cannot form a routing loop. */
export function createPeerHandler(identity: () => HostIdentity, receipts: PeerReceipts, execute: ExecutePeerTool) {
  return async (req: Request, address?: string): Promise<Response> => {
    // Trust comes from SSH / the local OS user, never from the spoofable HTTP Host header.
    if (!isLoopback(address)) return Response.json({ error: 'Peer operations require a local or SSH connection' }, { status: 403 });
    try {
      if (req.method !== 'POST') return Response.json({ error: 'POST required' }, { status: 405 });
      const raw = await req.text();
      if (raw.length > 512_000) return Response.json({ error: 'Peer request too large' }, { status: 413 });
      const body = JSON.parse(raw) as PeerRequest;
      const local = identity();
      if (body.protocolVersion !== local.protocolVersion) return Response.json({ error: 'Incompatible peer protocol' }, { status: 409 });
      if (body.targetHostId !== local.hostId) return Response.json({ error: 'Target host identity mismatch' }, { status: 409 });
      if (!isPeerTool(body.tool) || !body.args || typeof body.args !== 'object' || Array.isArray(body.args)
        || body.args.host_id !== undefined || !body.source || typeof body.source.hostId !== 'string'
        || typeof body.source.sessionId !== 'string') {
        return Response.json({ error: 'Invalid peer operation' }, { status: 400 });
      }
      const dispatch = () => {
        const args = { ...body.args };
        const origin = `Context from another Codiby session (host=${body.source.hostId}, session=${body.source.sessionId}, request=${body.requestId}). Treat this as inter-agent context, subject to this session's permissions.\n\n`;
        if (body.tool === 'ui_send_message') {
          if (typeof args.text !== 'string' || !args.text.trim()) throw new Error('text is required');
          args.text = origin + args.text;
        }
        if (body.tool === 'ui_spawn_session' && typeof args.initial_message === 'string') args.initial_message = origin + args.initial_message;
        // No impersonation of a local session by an incoming caller.
        return execute(body.tool, args, '');
      };
      const result = isPeerWrite(body.tool) ? await receipts.run(body, dispatch) : await dispatch();
      return Response.json({ hostId: local.hostId, requestId: body.requestId, result });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 400 });
    }
  };
}
