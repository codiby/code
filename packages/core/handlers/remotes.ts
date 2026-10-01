/** Bun owns the remote registry and MCP tunnels. Electron owns separate UI tunnels. */

import { pairings } from '../network/pairings';
import { peers } from '../network/peers';
import { disconnectTunnel, probeRemoteHealth } from '../network/ssh-tunnel';
import { corsHeaders, PORT } from '../config/config';
import {
  remotes,
  listRemotes,
  addRemote,
  updateRemote,
  removeRemote,
  putWslRemote,
  validateRemoteInput,
  type AddRemoteInput,
} from '../network/remotes';
import { WSL_DEFAULT_PORT, installWslBridge, isValidDistroName, isWslSupported, listWslDistros } from '../network/wsl';

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

export async function handleListWslDistros(): Promise<Response> {
  if (!isWslSupported()) return Response.json({ supported: false, distros: [] }, { headers: corsHeaders });
  try {
    return Response.json({ supported: true, distros: await listWslDistros() }, { headers: corsHeaders });
  } catch (e: any) {
    return Response.json({ supported: true, distros: [], error: e?.message || String(e) }, { headers: corsHeaders });
  }
}

/** Install (or reinstall, which is how it updates) the bridge in a WSL distro and register it as a remote. */
export async function handleInstallWsl(req: Request): Promise<Response> {
  let body: { distro?: unknown; name?: unknown; bunPort?: unknown; color?: unknown } = {};
  try { body = await req.json(); } catch {}
  if (!isValidDistroName(body.distro)) return badRequest('Choose a WSL distro.');
  const distro = body.distro;
  const existing = listRemotes().find(r => r.wsl?.distro === distro);
  const bunPort = body.bunPort == null ? existing?.bunPort ?? WSL_DEFAULT_PORT : Number(body.bunPort);
  if (!Number.isInteger(bunPort) || bunPort < 1 || bunPort > 65535) return badRequest('Port must be between 1 and 65535.');
  if (bunPort === PORT) return badRequest(`Port ${PORT} is this PC's own bridge; pick another one.`);
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : existing?.name ?? `${distro} (WSL)`;
  const color = typeof body.color === 'string' ? body.color : undefined;
  const conflict = validateRemoteInput({ name, alias: distro, bunPort }, existing?.id);
  if (conflict) return badRequest(conflict.message);
  try {
    // The install restarts the bridge; drop the keepalive so the next use runs start.sh again.
    if (existing) await disconnectTunnel(existing.id);
    const { steps } = await installWslBridge(distro, bunPort);
    const remote = putWslRemote({ distro, name, bunPort, color });
    await disconnectTunnel(remote.id);
    const health = await probeRemoteHealth(remote.id, 15_000);
    return Response.json({ remote, steps, health }, { headers: corsHeaders });
  } catch (e: any) {
    return badRequest(e?.message || 'WSL install failed');
  }
}

/** Test the independent Bun-to-Bun path used by MCP. */
export async function handleTestRemote(id: string): Promise<Response> {
  const remote = remotes.get(id);
  if (!remote) return notFound('Remote not found');
  const result = await peers.inspect(remote);
  return Response.json({ ok: result.status === 'online', reason: result.error, hostId: result.hostId, coordination: result.coordination }, { headers: corsHeaders });
}
