/**
 * Bridge → viewer → Electron SSH-forward request/response plumbing.
 *
 * `ui_forward_port` used to have exactly one move: publish the port on this
 * machine's `0.0.0.0` and hand the agent a URL built from this machine's
 * hostname. For a session the user is watching over an SSH tunnel that is the
 * wrong move — the bridge is on the far end, so the published port lives on a
 * host the viewer may not be able to route to, the URL is a guess, and the
 * close button in the popover talks to the viewer's own bridge, which has
 * never heard of that port. (See handlers/published-ports.ts.)
 *
 * The viewer already knows how to do this properly: "Add forward" in the port
 * popover opens an `-L` over the SSH ControlMaster that Electron main owns,
 * and the result is a `localhost:<port>` that works because it is genuinely
 * local. This module lets the agent ask for that same forward.
 *
 * The shape is lifted from provider/browser-cdp.ts, which delegates CDP calls
 * the same way — the bridge cannot reach the OS the viewer is sitting at, so
 * it asks whoever is subscribed to the session to act on its behalf.
 *
 * Deciding who *can* forward is the viewer's job, not ours: this bridge has no
 * idea whether the client reached it directly or through a tunnel. A viewer
 * with no SSH route for the session answers `unsupported`, and the caller
 * falls back to publishing.
 */
import { randomUUID } from 'crypto';

const DEFAULT_TIMEOUT_MS = 15_000;

type Pending = {
  resolve: (result: ViewerForwardResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, Pending>();

export type ViewerForwardResult =
  | { ok: true; localPort: number }
  /** The viewer has no SSH route to this session's host — publish instead. */
  | { ok: false; unsupported: true };

/** Sends the request to every forward-capable viewer; returns how many got it. */
export type SendForwardRequest = (sessionId: string, msg: object) => number;

/**
 * Asks a viewer to tunnel `remotePort` back to its own machine.
 *
 * Rejects on timeout or on an error from the viewer's SSH layer; resolves with
 * `unsupported` when no viewer can do it. Both cases are recoverable by the
 * caller — the point is never to leave the agent without a working URL.
 */
export async function requestViewerForward(
  sessionId: string,
  remotePort: number,
  label: string | null,
  send: SendForwardRequest,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ViewerForwardResult> {
  const requestId = randomUUID();
  return await new Promise<ViewerForwardResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`The viewer did not answer the forward request within ${timeoutMs}ms.`));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });

    const reached = send(sessionId, {
      type: 'remote_forward_request',
      sessionId,
      requestId,
      remotePort,
      label,
    });

    // Nobody to ask — a web viewer, a phone, or nothing attached at all. Settle
    // now rather than burn the full timeout on a request with no recipient.
    if (reached === 0) {
      pending.delete(requestId);
      clearTimeout(timer);
      resolve({ ok: false, unsupported: true });
    }
  });
}

export function handleViewerForwardResponse(msg: {
  requestId?: string;
  localPort?: number;
  unsupported?: boolean;
  error?: string;
}): void {
  const id = msg.requestId;
  if (!id) return;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  if (typeof msg.error === 'string' && msg.error.length > 0) {
    p.reject(new Error(msg.error));
  } else if (msg.unsupported === true || typeof msg.localPort !== 'number') {
    p.resolve({ ok: false, unsupported: true });
  } else {
    p.resolve({ ok: true, localPort: msg.localPort });
  }
}
