/**
 * Bridge → frontend → Electron CDP request/response plumbing.
 *
 * The SDK tools defined in `sdk-tools.ts` (browser_snapshot,
 * browser_click, …) call into `cdpRequest()` here. It:
 *
 *   1. Mints a `requestId`.
 *   2. Stores a pending promise in `pending` keyed by that id.
 *   3. Sends a `browser_request` to desktop clients subscribed to the session.
 *   4. Waits up to `timeoutMs` for the corresponding `browser_response`.
 *
 * `handleBrowserResponse` is called from the WS frontend message handler
 * (`server/index.ts`) and resolves / rejects the pending promise.
 *
 * No persistence — requests are in-flight ephemeral state. On bridge
 * restart, in-flight requests die with it; the SDK call surfaces a timeout.
 */
import { randomUUID } from 'crypto';

const DEFAULT_TIMEOUT_MS = 10_000;

type Pending = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, Pending>();

export type CdpAction =
  | 'snapshot'
  | 'take_screenshot'
  | 'click'
  | 'hover'
  | 'type'
  | 'press_key'
  | 'select_option'
  | 'scroll'
  | 'navigate'
  | 'evaluate'
  | 'wait_for'
  | 'console_messages'
  | 'network_requests'
  | 'handle_dialog';

export async function cdpRequest(
  sessionId: string,
  name: string,
  action: CdpAction,
  args: Record<string, unknown>,
  sendBrowserRequest: (sessionId: string, msg: object) => void,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const requestId = randomUUID();
  return await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`browser_${action}(${name}) timed out after ${timeoutMs}ms — is the "${name}" browser preview open in the desktop app?`));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    sendBrowserRequest(sessionId, {
      type: 'browser_request',
      sessionId,
      // `name` identifies which preview within the session this targets.
      // The desktop frontend uses it to build the correct OS-level webview
      // label (`browser-<sessionId>-<name>`).
      name,
      requestId,
      action,
      args,
    });
  });
}

export function handleBrowserResponse(msg: {
  requestId?: string;
  result?: unknown;
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
  } else {
    p.resolve(msg.result);
  }
}
