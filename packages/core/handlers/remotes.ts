/** Bun owns the remote registry and MCP tunnels. Electron owns separate UI tunnels. */

import { pairings } from '../network/pairings';
import { peers } from '../network/peers';
import { disconnectTunnel } from '../network/ssh-tunnel';
import { corsHeaders } from '../config/config';
import {
  remotes,
  listRemotes,
  addRemote,
  updateRemote,
  removeRemote,
  validateRemoteInput,
  type AddRemoteInput,
} from '../network/remotes';

function badRequest(msg: string): Response {
  return Response.json({ error: msg }, { status: 400, headers: corsHeaders });
}

function notFound(msg: string): Response {
  return Response.json({ error: msg }, { status: 404, headers: corsHeaders });
}

function remoteToJSON(id: string) {
  return remotes.get(id) ?? null;
}

export function handleListRemotes(): Response {
  return Response.json(listRemotes(), { headers: corsHeaders });
}

export async function handleAddRemote(req: Request): Promise<Response> {
  let body: Partial<AddRemoteInput> = {};
  try { body = await req.json() as Partial<AddRemoteInput>; } catch {}
  const err = validateRemoteInput(body);
  if (err) return badRequest(err.message);
  try {
    const r = addRemote(body as AddRemoteInput);
    return Response.json(remoteToJSON(r.id), { headers: corsHeaders });
  } catch (e: any) {
    return badRequest(e?.message || 'Failed to add remote');
  }
}

export async function handleUpdateRemote(id: string, req: Request): Promise<Response> {
  if (!remotes.has(id)) return notFound(`Remote ${id} not found`);
  let body: Partial<AddRemoteInput> = {};
  try { body = await req.json() as Partial<AddRemoteInput>; } catch {}
  if (remotes.get(id)?.pairingId) return badRequest('Unpair these hosts before changing their connection or permissions');
  try {
    const r = updateRemote(id, body);
    await disconnectTunnel(id);
    // The renderer separately invalidates Electron's direct UI connection.
    return Response.json(remoteToJSON(r.id), { headers: corsHeaders });
  } catch (e: any) {
    return badRequest(e?.message || 'Failed to update remote');
  }
}

export async function handleRemoveRemote(id: string): Promise<Response> {
  if (!remotes.has(id)) return notFound(`Remote ${id} not found`);
  const pairingId = remotes.get(id)?.pairingId;
  if (pairingId) await pairings.unpair(pairingId);
  // An automatically created return record is already removed by unpairing.
  if (!remotes.has(id)) return Response.json({ ok: true }, { headers: corsHeaders });
  const removed = removeRemote(id);
  await disconnectTunnel(id);
  if (!removed) return notFound(`Remote ${id} not found`);
  return Response.json({ ok: true }, { headers: corsHeaders });
}

/** Test the independent Bun-to-Bun path used by MCP. */
export async function handleTestRemote(id: string): Promise<Response> {
  const remote = remotes.get(id);
  if (!remote) return notFound('Remote not found');
  const result = await peers.inspect(remote);
  return Response.json({ ok: result.status === 'online', reason: result.error, hostId: result.hostId, coordination: result.coordination }, { headers: corsHeaders });
}
