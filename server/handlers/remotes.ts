/**
 * HTTP handlers for /remotes/* — CRUD over the configured remotes. Persistence
 * (~/.codiby/ui-remotes.json) stays here on the local bun sidecar, but SSH
 * tunnels + live status + Test Connection now live in the Electron main
 * process, which the renderer drives via IPC. So these handlers no longer
 * touch the tunnel: status is merged in by the renderer from main.
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
  try {
    const r = updateRemote(id, body);
    // The tunnel (owned by Electron main) is torn down by the renderer via IPC
    // when alias/port change — bun no longer manages it.
    return Response.json(remoteToJSON(r.id), { headers: corsHeaders });
  } catch (e: any) {
    return badRequest(e?.message || 'Failed to update remote');
  }
}

export async function handleRemoveRemote(id: string): Promise<Response> {
  if (!remotes.has(id)) return notFound(`Remote ${id} not found`);
  const removed = removeRemote(id);
  if (!removed) return notFound(`Remote ${id} not found`);
  return Response.json({ ok: true }, { headers: corsHeaders });
}

/**
 * Test Connection now runs in the Electron main process (it owns the tunnel),
 * so this local endpoint is a no-op stub. The renderer calls the
 * `remote_test` IPC instead.
 */
export async function handleTestRemote(id: string): Promise<Response> {
  if (!remotes.has(id)) return notFound(`Remote ${id} not found`);
  return Response.json(
    { ok: false, reason: 'Test Connection runs in the desktop app.' },
    { headers: corsHeaders },
  );
}
