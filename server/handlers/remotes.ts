/**
 * HTTP handlers for /remotes/* — CRUD over the configured remotes plus a
 * Test Connection probe used by the Settings UI.
 *
 * Editing or removing a remote tears down its active SSH tunnel (if any) so
 * the next first-click respawns with the updated config.
 */

import { corsHeaders } from '../config';
import {
  remotes,
  listRemotes,
  addRemote,
  updateRemote,
  removeRemote,
  validateRemoteInput,
  type AddRemoteInput,
} from '../remotes';
import { disconnectTunnel, getTunnelStatus, probeRemoteHealth } from '../ssh-tunnel';
import { logError } from '../logger';

function badRequest(msg: string): Response {
  return Response.json({ error: msg }, { status: 400, headers: corsHeaders });
}

function notFound(msg: string): Response {
  return Response.json({ error: msg }, { status: 404, headers: corsHeaders });
}

function remoteToJSON(id: string) {
  const r = remotes.get(id);
  if (!r) return null;
  const { status, lastError } = getTunnelStatus(id);
  return { ...r, status, lastError };
}

export function handleListRemotes(): Response {
  const list = listRemotes().map(r => {
    const { status, lastError } = getTunnelStatus(r.id);
    return { ...r, status, lastError };
  });
  return Response.json(list, { headers: corsHeaders });
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
  const before = remotes.get(id)!;
  try {
    const r = updateRemote(id, body);
    // Connection-affecting fields require the master to be torn down so the
    // next first-click respawns with the new config. Cosmetic edits (name,
    // color) don't disturb the tunnel.
    const aliasChanged = before.alias !== r.alias;
    const portChanged = before.bunPort !== r.bunPort;
    if (aliasChanged || portChanged) {
      await disconnectTunnel(id);
    }
    return Response.json(remoteToJSON(r.id), { headers: corsHeaders });
  } catch (e: any) {
    return badRequest(e?.message || 'Failed to update remote');
  }
}

export async function handleRemoveRemote(id: string): Promise<Response> {
  if (!remotes.has(id)) return notFound(`Remote ${id} not found`);
  await disconnectTunnel(id);
  const removed = removeRemote(id);
  if (!removed) return notFound(`Remote ${id} not found`);
  return Response.json({ ok: true }, { headers: corsHeaders });
}

/**
 * Bring the tunnel up just long enough to GET /health on the remote bridge.
 * Used by Settings → Test Connection. Never throws — always returns a
 * JSON body the UI can render.
 */
export async function handleTestRemote(id: string): Promise<Response> {
  if (!remotes.has(id)) return notFound(`Remote ${id} not found`);
  try {
    const result = await probeRemoteHealth(id);
    return Response.json(result, { headers: corsHeaders });
  } catch (e: any) {
    logError(`[remotes] probe failed: ${e}`);
    return Response.json(
      { ok: false, reason: e?.message || String(e) },
      { headers: corsHeaders },
    );
  }
}
