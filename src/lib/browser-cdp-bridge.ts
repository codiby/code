/**
 * Bridge → Electron CDP request router.
 *
 * The desktop frontend is the only thing wired to both the bun bridge
 * (via WebSocket) and the Electron main process (via the
 * `__TAURI_INTERNALS__.invoke` shim exposed by the preload). The bridge
 * issues `browser_request` over the WS when an SDK tool (`browser_snapshot`,
 * `browser_click`, etc.) runs; this module forwards each request to main
 * via `invoke('cdp_<action>', args)` and replies with the result through
 * `client.respondBrowserRequest`.
 *
 * Wire once at app boot — `Providers.tsx` or `ChatApp.tsx`'s client setup
 * passes `onBrowserRequest: handleBrowserRequest(client)`.
 *
 * Non-Electron viewers (browser, mobile PWA) never install this handler;
 * the bridge times out the request and the SDK tool reports failure.
 */

type InvokeFn = <T = unknown>(cmd: string, args?: unknown) => Promise<T>;

function getInvoke(): InvokeFn | null {
  if (typeof window === 'undefined') return null;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: InvokeFn } }).__TAURI_INTERNALS__;
  return internals?.invoke ?? null;
}

export type BrowserRequest = {
  sessionId: string;
  requestId: string;
  action: string;
  args: unknown;
};

const ALLOWED_ACTIONS = new Set([
  'snapshot',
  'screenshot',
  'click',
  'fill',
  'scroll',
  'network',
]);

/** Build the request → response handler. Hand the returned function to
 *  `ClientCallbacks.onBrowserRequest`. */
export function buildBrowserRequestHandler(
  respond: (sessionId: string, requestId: string, payload: { result?: unknown; error?: string }) => void,
  getLabelForSession: (sessionId: string) => string,
) {
  return async (req: BrowserRequest): Promise<void> => {
    const invoke = getInvoke();
    if (!invoke) {
      respond(req.sessionId, req.requestId, {
        error: 'No browser preview available — this viewer is not running inside the desktop app.',
      });
      return;
    }
    if (!ALLOWED_ACTIONS.has(req.action)) {
      respond(req.sessionId, req.requestId, { error: `Unknown action "${req.action}".` });
      return;
    }
    const label = getLabelForSession(req.sessionId);
    const args = {
      ...(req.args as Record<string, unknown> | undefined),
      label,
    };
    try {
      const result = await invoke(`cdp_${req.action}`, args);
      respond(req.sessionId, req.requestId, { result });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      respond(req.sessionId, req.requestId, { error: message });
    }
  };
}

/** The label convention matches the open_browser flow: one preview per
 *  session, labelled `browser-<sessionId>`. */
export function browserLabelFor(sessionId: string): string {
  return `browser-${sessionId}`;
}
