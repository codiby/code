export type ConnStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface ConnHooks {
  /** Re-derive the http base (remote: current tunnel port). Null if not ready. */
  resolveBase: () => Promise<string | null>;
  token: () => string | null;
  onMessage: (msg: Record<string, unknown>, remoteId: string | null) => void;
  onStatus: (remoteId: string | null, status: ConnStatus) => void;
  /** Sent once per connected socket before session subscriptions. */
  onOpen?: (send: (msg: object) => void) => void;
  /** Reconnect backoff override (tests). Production default: 2000ms. */
  reconnectDelayMs?: number;
}

/**
 * One WebSocket connection to a bridge — the local bun sidecar, or a remote
 * reached directly through its SSH tunnel (a plain `127.0.0.1:<tunnelPort>`
 * base). Owns its own reconnect loop and subscription set so the ClaudeClient
 * can hold a collection: one local + one per active remote. The remote base
 * can change when the tunnel respawns on a new local port — `setBase()` and
 * the reconnect path both re-derive it.
 *
 * INVARIANT: at most one live socket per Conn, ever. Historically this class
 * leaked "orphan" sockets — a reconnect timer scheduled by an old socket's
 * `onclose` could fire after `reopen()` had already built a healthy socket,
 * and the new `connect()` overwrote `this.ws` without closing the previous
 * one. The orphan stayed open, re-subscribed itself (its `onopen` replays
 * `activeSubs`), and double-delivered every broadcast — visible as terminal
 * keystrokes echoing 2-3+ times, one extra per minimize/restore cycle
 * (Electron throttles background timers, so the stale timer reliably fired
 * right after the visibility-driven reopen). Three rules enforce the
 * invariant now:
 *   1. Every socket callback checks `this.ws === ws` and does nothing for a
 *      socket that is no longer current (deliberate closes null `this.ws`
 *      first, so they never schedule a resurrect).
 *   2. `connect()` is epoch-guarded across its awaits and closes any
 *      previous socket before installing a new one.
 *   3. `reopen()` cancels a pending reconnect timer before connecting.
 */
export class Conn {
  ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  readonly activeSubs = new Set<string>();
  private closed = false;
  private base: string | null;
  /** Bumped by each connect() attempt; an attempt that resumes from an await
   *  and finds itself superseded must abandon without touching `this.ws`. */
  private connectEpoch = 0;
  private readonly reconnectDelayMs: number;

  constructor(
    readonly remoteId: string | null,
    base: string | null,
    private readonly hooks: ConnHooks,
  ) {
    this.base = base;
    this.reconnectDelayMs = hooks.reconnectDelayMs ?? 2000;
    void this.connect();
  }

  /** Point at a new base (e.g. the tunnel came online on a fresh port). */
  setBase(base: string | null) {
    if (base && base !== this.base) {
      this.base = base;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) this.reopenSoon(0);
    }
  }

  private async connect() {
    if (this.closed) return;
    const epoch = ++this.connectEpoch;
    if (!this.base) {
      this.base = await this.hooks.resolveBase();
      if (this.closed || epoch !== this.connectEpoch) return;
    }
    if (!this.base) { this.reopenSoon(this.reconnectDelayMs); return; }
    const token = this.hooks.token();
    const wsBase = this.base.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws';
    const url = token ? `${wsBase}?t=${encodeURIComponent(token)}` : wsBase;
    this.hooks.onStatus(this.remoteId, 'connecting');
    // Never stack sockets: whatever was current is dead to us now.
    if (this.ws) {
      const prev = this.ws;
      this.ws = null;
      try { prev.close(); } catch {}
    }
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) { try { ws.close(); } catch {} return; }
      this.hooks.onStatus(this.remoteId, 'connected');
      this.hooks.onOpen?.((msg) => {
        try { ws.send(JSON.stringify(msg)); } catch {}
      });
      for (const sid of this.activeSubs) {
        try { ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid })); } catch {}
      }
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      try { this.hooks.onMessage(JSON.parse(event.data), this.remoteId); } catch {}
    };
    ws.onclose = () => {
      // Stale socket (deliberately closed or superseded): its close must not
      // drive the shared reconnect loop — that resurrection is exactly how
      // orphans used to accumulate.
      if (this.ws !== ws) return;
      this.ws = null;
      this.hooks.onStatus(this.remoteId, 'disconnected');
      if (!this.closed) {
        // Re-derive the base on reconnect — a remote tunnel may have respawned
        // on a different local port.
        this.base = null;
        this.reopenSoon(this.reconnectDelayMs);
      }
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.hooks.onStatus(this.remoteId, 'error');
    };
  }

  private reopenSoon(delay: number) {
    if (this.closed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect(); }, delay);
  }

  send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
  subscribe(sessionId: string) { this.activeSubs.add(sessionId); this.send({ type: 'subscribe', sessionId }); }
  unsubscribe(sessionId: string) { this.activeSubs.delete(sessionId); this.send({ type: 'unsubscribe', sessionId }); }

  /** Close the socket for bfcache/background without forgetting subs. Nulling
   *  `this.ws` before close() means the socket's own `onclose` sees itself as
   *  stale and won't schedule a background resurrection. */
  closeForBackground() {
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch {}
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }
  /** Reopen if the socket isn't open (foreground / pageshow). */
  reopen() {
    if (this.closed) return;
    // A reconnect timer scheduled before we were backgrounded (or by a socket
    // that died since) must not fire on top of the connection we make now.
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      const prev = this.ws;
      this.ws = null;
      try { prev?.close(); } catch {}
      this.base = null;
      void this.connect();
    }
  }
  destroy() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch {}
  }
}
