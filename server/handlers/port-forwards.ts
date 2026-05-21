/**
 * HTTP handlers for per-session port forwards on remote sessions.
 *
 *   GET    /sessions/:id/port-forwards          → list (from local config)
 *   POST   /sessions/:id/port-forwards          → add { remotePort, localPort?, label? }
 *   DELETE /sessions/:id/port-forwards/:lp/:rp  → cancel one
 *
 * Only meaningful for remote sessions. The `-L` is opened via the SSH
 * ControlMaster (multiplexed on top of the existing master).
 */

import { corsHeaders } from '../config';
import { resolveSessionRemote, proxyHttpToRemote } from '../gateway';
import {
  addPortForward as sshAddForward,
  removePortForward as sshRemoveForward,
  listActiveForwards,
} from '../ssh-tunnel';

function badRequest(msg: string): Response {
  return Response.json({ error: msg }, { status: 400, headers: corsHeaders });
}

export function handleListPortForwards(sessionId: string): Response {
  const remoteId = resolveSessionRemote(sessionId);
  if (!remoteId) return badRequest('Port forwards are only available on remote sessions.');
  return Response.json(listActiveForwards(remoteId), { headers: corsHeaders });
}

export async function handleAddPortForward(sessionId: string, req: Request): Promise<Response> {
  const remoteId = resolveSessionRemote(sessionId);
  if (!remoteId) return badRequest('Port forwards are only available on remote sessions.');
  let body: { remotePort?: number; localPort?: number | null; label?: string } = {};
  try { body = await req.json() as typeof body; } catch {}
  if (!body.remotePort || !Number.isInteger(body.remotePort)) {
    return badRequest('remotePort is required (integer).');
  }
  try {
    const { localPort } = await sshAddForward(remoteId, body.remotePort, body.localPort ?? null, body.label);
    // Mirror in the remote's persisted Session.portForwards so it survives
    // reconnects and other clients see it too. Best-effort — the local
    // tunnel forward is the authority for live state.
    try {
      await proxyHttpToRemote(
        new Request(`http://x/sessions/${sessionId}/port-forwards`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ remotePort: body.remotePort, localPort, label: body.label }),
        }),
        remoteId,
      );
    } catch {}
    return Response.json({ localPort, remotePort: body.remotePort, label: body.label }, { headers: corsHeaders });
  } catch (e: any) {
    return badRequest(e?.message || 'Failed to add port forward');
  }
}

export async function handleRemovePortForward(sessionId: string, localPort: number, remotePort: number): Promise<Response> {
  const remoteId = resolveSessionRemote(sessionId);
  if (!remoteId) return badRequest('Port forwards are only available on remote sessions.');
  try {
    await sshRemoveForward(remoteId, localPort, remotePort);
    try {
      await proxyHttpToRemote(
        new Request(`http://x/sessions/${sessionId}/port-forwards/${localPort}/${remotePort}`, {
          method: 'DELETE',
        }),
        remoteId,
      );
    } catch {}
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (e: any) {
    return badRequest(e?.message || 'Failed to remove port forward');
  }
}
