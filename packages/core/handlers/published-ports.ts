/**
 * HTTP handlers for the ports a session publishes to a remote viewer.
 *
 *   GET    /sessions/:id/published-ports              → list
 *   POST   /sessions/:id/published-ports              → open { port, publicPort?, host?, label? }
 *   DELETE /sessions/:id/published-ports/:publicPort  → close one
 *
 * The agent drives these through the `ui_forward_port` MCP tools; this is the
 * same thing for the popover, so a user can publish a port the agent forgot to
 * or take one down without asking. Distinct from ./port-forwards.ts, which
 * tunnels a *remote* machine's port back here over SSH — this one pushes a
 * local port out to a browser somewhere else. See network/port-forward.ts.
 */

import { corsHeaders } from '../config/config';
import { sessions } from '../session/sessions';
import {
  PortInUseError,
  closePortForward,
  isTargetListening,
  listPortForwards,
  openPortForward,
  type SessionPortForward,
} from '../network/port-forward';
import { publishedPortUrl, publishedUrlIsGuess } from '../network/remote-viewer';

export type PublishedPortDTO = SessionPortForward & { url: string; urlIsGuess: boolean };

function toDTO(f: SessionPortForward): PublishedPortDTO {
  return { ...f, url: publishedPortUrl(f.publicPort), urlIsGuess: publishedUrlIsGuess() };
}

export function publishedPortsFor(sessionId: string): PublishedPortDTO[] {
  return listPortForwards(sessionId).map(toDTO);
}

function badRequest(msg: string): Response {
  return Response.json({ error: msg }, { status: 400, headers: corsHeaders });
}

export function handleListPublishedPorts(sessionId: string): Response {
  return Response.json(publishedPortsFor(sessionId), { headers: corsHeaders });
}

export async function handleAddPublishedPort(sessionId: string, req: Request): Promise<Response> {
  if (!sessions.has(sessionId)) {
    return Response.json({ error: 'Session not found' }, { status: 404, headers: corsHeaders });
  }
  let body: { port?: number; publicPort?: number | null; host?: string; label?: string } = {};
  try { body = await req.json() as typeof body; } catch {}
  if (!body.port || !Number.isInteger(body.port)) return badRequest('port is required (integer).');

  try {
    const forward = await openPortForward({
      sessionId,
      targetPort: body.port,
      targetHost: body.host,
      publicPort: body.publicPort ?? undefined,
      label: body.label ?? null,
    });
    // A forward opened against a port nothing is serving is legal — the dev
    // server may still be booting — but the popover should say so rather than
    // show a confident "Live" pill over a dead port.
    const listening = await isTargetListening(forward.targetHost, forward.targetPort);
    return Response.json({ ...toDTO(forward), listening }, { headers: corsHeaders });
  } catch (err) {
    // 409 so the UI can tell "that port is taken" apart from "you typed
    // nonsense" without matching on the message text.
    if (err instanceof PortInUseError) {
      return Response.json({ error: err.message, port: err.port }, { status: 409, headers: corsHeaders });
    }
    return badRequest(err instanceof Error ? err.message : String(err));
  }
}

export function handleRemovePublishedPort(sessionId: string, publicPort: number): Response {
  if (!Number.isInteger(publicPort)) return badRequest('publicPort must be an integer.');
  if (!closePortForward(publicPort, sessionId)) {
    return Response.json(
      { error: `This session is not publishing port ${publicPort}.` },
      { status: 404, headers: corsHeaders },
    );
  }
  return Response.json({ ok: true }, { headers: corsHeaders });
}
