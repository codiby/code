/**
 * Bridge → Electron CDP request router.
 *
 * The desktop frontend is the only thing wired to both the bun bridge
 * (via WebSocket) and the Electron main process (via `window.codiby.invoke`
 * exposed by the preload). The bridge issues `browser_request` over the WS
 * when an SDK tool (`browser_snapshot`, `browser_click`, etc.) runs; this
 * module forwards each request to main via `invoke('cdp_<action>', args)`
 * and replies with the result through `client.respondBrowserRequest`.
 *
 * Wire once at app boot — `Providers.tsx` or `ChatApp.tsx`'s client setup
 * passes `onBrowserRequest: handleBrowserRequest(client)`.
 *
 * Non-Electron viewers (browser, mobile PWA) never install this handler;
 * the bridge times out the request and the SDK tool reports failure.
 */

import { getNative } from './native';

export type BrowserRequest = {
  sessionId: string;
  /** Identifies which preview within the session this request targets.
   *  Combined with `sessionId` to build the OS-level webview label. */
  name: string;
  requestId: string;
  action: string;
  args: unknown;
};

const ALLOWED_ACTIONS = new Set([
  'snapshot',
  'take_screenshot',
  'click',
  'hover',
  'type',
  'press_key',
  'select_option',
  'scroll',
  'navigate',
  'evaluate',
  'wait_for',
  'console_messages',
  'network_requests',
  'handle_dialog',
]);

/** Build the request → response handler. Hand the returned function to
 *  `ClientCallbacks.onBrowserRequest`. */
export function buildBrowserRequestHandler(
  respond: (sessionId: string, requestId: string, payload: { result?: unknown; error?: string }) => void,
) {
  return async (req: BrowserRequest): Promise<void> => {
    const native = getNative();
    if (!native) {
      respond(req.sessionId, req.requestId, {
        error: 'No browser preview available — this viewer is not running inside the desktop app.',
      });
      return;
    }
    if (!ALLOWED_ACTIONS.has(req.action)) {
      respond(req.sessionId, req.requestId, { error: `Unknown action "${req.action}".` });
      return;
    }
    if (!req.name) {
      respond(req.sessionId, req.requestId, { error: 'browser_request missing `name` — the bridge must specify which preview to act on.' });
      return;
    }
    const label = browserLabelFor(req.sessionId, req.name);
    const args = {
      ...(req.args as Record<string, unknown> | undefined),
      label,
    };
    try {
      const result = await native.invoke(`cdp_${req.action}`, args);
      respond(req.sessionId, req.requestId, { result });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      respond(req.sessionId, req.requestId, { error: message });
    }
  };
}

/** OS-level webview label convention: `browser-<sessionId>-<name>`. Both
 *  parts pass the Electron-side `[a-zA-Z0-9_-]+` validator (sessionIds are
 *  UUIDs with dashes, names are validated kebab/snake-case at the bridge),
 *  so the concatenated string is always valid. */
export function browserLabelFor(sessionId: string, name: string): string {
  return `browser-${sessionId}-${name}`;
}
