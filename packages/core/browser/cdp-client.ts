/**
 * Minimal Chrome DevTools Protocol client over the browser-level WebSocket.
 *
 * One socket per browser; every page is reached through a flatten-mode
 * session (`Target.attachToTarget {flatten: true}`), so commands and events
 * for a page carry its `sessionId` on the same socket instead of needing one
 * socket per tab. Bun's native WebSocket is all it needs.
 */

export class CdpError extends Error {
  constructor(readonly method: string, readonly code: number | undefined, message: string) {
    super(`${method}: ${message}`);
    this.name = 'CdpError';
  }
}

export class CdpClosedError extends Error {
  constructor(message = 'The browser connection closed') {
    super(message);
    this.name = 'CdpClosedError';
  }
}

export class CdpTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`${method} timed out after ${timeoutMs}ms`);
    this.name = 'CdpTimeoutError';
  }
}

type Params = Record<string, unknown>;
type EventHandler = (params: any, sessionId: string | undefined) => void;
type SessionHandler = (method: string, params: any) => void;

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CdpSendOptions {
  /** Flatten-mode session the command targets; omitted for browser-level commands. */
  sessionId?: string;
  timeoutMs?: number;
}

export interface CreateTargetOptions {
  url?: string;
  browserContextId?: string;
  /** A tab in its own window is never a background tab, so headless never throttles its rendering. */
  newWindow?: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 10_000;

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventHandlers = new Map<string, Set<EventHandler>>();
  private readonly sessionHandlers = new Map<string, Set<SessionHandler>>();
  private readonly closeHandlers = new Set<(reason: string) => void>();
  private isClosed = false;

  private constructor(private readonly ws: WebSocket, private readonly defaultTimeoutMs: number) {
    ws.addEventListener('message', (ev) => this.onMessage(ev.data));
    ws.addEventListener('close', (ev) => this.onClosed(`socket closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ''})`));
    ws.addEventListener('error', () => this.onClosed('socket error'));
  }

  static connect(url: string, opts: { timeoutMs?: number; defaultTimeoutMs?: number } = {}): Promise<CdpClient> {
    const timeoutMs = opts.timeoutMs ?? CONNECT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        reject(new CdpTimeoutError('connect', timeoutMs));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new CdpClient(ws, opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS));
      });
      const fail = (why: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new CdpClosedError(`Could not connect to the browser (${why})`));
      };
      ws.addEventListener('error', () => fail('socket error'));
      ws.addEventListener('close', (ev) => fail(`closed with ${ev.code}`));
    });
  }

  get closed(): boolean {
    return this.isClosed;
  }

  send<T = any>(method: string, params: Params = {}, opts: CdpSendOptions = {}): Promise<T> {
    if (this.isClosed) return Promise.reject(new CdpClosedError());
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const message: Record<string, unknown> = { id, method, params };
    if (opts.sessionId) message.sessionId = opts.sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.ws.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpClosedError(`Could not send ${method}: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }

  /** Subscribe to an event from any session (browser-level events have no session). */
  on(method: string, handler: EventHandler): () => void {
    let set = this.eventHandlers.get(method);
    if (!set) { set = new Set(); this.eventHandlers.set(method, set); }
    set.add(handler);
    return () => { set!.delete(handler); };
  }

  /** Subscribe to every event of one flatten-mode session. */
  onSession(sessionId: string, handler: SessionHandler): () => void {
    let set = this.sessionHandlers.get(sessionId);
    if (!set) { set = new Set(); this.sessionHandlers.set(sessionId, set); }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.sessionHandlers.delete(sessionId);
    };
  }

  /** Resolve on the next `method` event (optionally from one session) that passes `predicate`. */
  waitForEvent<T = any>(method: string, opts: { sessionId?: string; timeoutMs?: number; predicate?: (params: T) => boolean } = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      let off: () => void = () => {};
      const offClose = this.onClose(() => { cleanup(); reject(new CdpClosedError()); });
      const timer = setTimeout(() => { cleanup(); reject(new CdpTimeoutError(method, timeoutMs)); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); off(); offClose(); };
      off = this.on(method, (params, sessionId) => {
        if (opts.sessionId !== undefined && sessionId !== opts.sessionId) return;
        if (opts.predicate && !opts.predicate(params)) return;
        cleanup();
        resolve(params);
      });
    });
  }

  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => { this.closeHandlers.delete(handler); };
  }

  close(): void {
    if (this.isClosed) return;
    try { this.ws.close(); } catch {}
    this.onClosed('closed by client');
  }

  // -------------------------------------------------------------------------
  // Target helpers
  // -------------------------------------------------------------------------

  async createTarget(opts: CreateTargetOptions = {}): Promise<string> {
    const params: Params = { url: opts.url ?? 'about:blank' };
    if (opts.browserContextId) params.browserContextId = opts.browserContextId;
    if (opts.newWindow) params.newWindow = true;
    const { targetId } = await this.send<{ targetId: string }>('Target.createTarget', params);
    return targetId;
  }

  async closeTarget(targetId: string): Promise<void> {
    await this.send('Target.closeTarget', { targetId });
  }

  /** Attach in flatten mode and return the session id commands for that target carry. */
  async attachToTarget(targetId: string): Promise<string> {
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }

  async detachFromTarget(sessionId: string): Promise<void> {
    await this.send('Target.detachFromTarget', { sessionId });
  }

  /** An isolated, in-memory cookie jar (incognito-like) inside the same browser. */
  async createBrowserContext(): Promise<string> {
    const { browserContextId } = await this.send<{ browserContextId: string }>('Target.createBrowserContext', { disposeOnDetach: false });
    return browserContextId;
  }

  async disposeBrowserContext(browserContextId: string): Promise<void> {
    await this.send('Target.disposeBrowserContext', { browserContextId });
  }

  // -------------------------------------------------------------------------
  // Wire handling
  // -------------------------------------------------------------------------

  private onMessage(data: unknown): void {
    const text = typeof data === 'string' ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : String(data);
    let msg: { id?: number; result?: unknown; error?: { code?: number; message?: string; data?: string }; method?: string; params?: unknown; sessionId?: string };
    try { msg = JSON.parse(text); } catch { return; }

    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const detail = msg.error.data ? `${msg.error.message} (${msg.error.data})` : msg.error.message || 'Unknown CDP error';
        p.reject(new CdpError(p.method, msg.error.code, detail));
      } else {
        p.resolve(msg.result ?? {});
      }
      return;
    }

    if (typeof msg.method !== 'string') return;
    const params = msg.params ?? {};
    // A handler that throws must not break delivery to the others (or the socket).
    for (const handler of [...(this.eventHandlers.get(msg.method) ?? [])]) {
      try { handler(params, msg.sessionId); } catch {}
    }
    if (msg.sessionId) {
      for (const handler of [...(this.sessionHandlers.get(msg.sessionId) ?? [])]) {
        try { handler(msg.method, params); } catch {}
      }
    }
    if (msg.method === 'Target.detachedFromTarget') {
      const gone = (params as { sessionId?: string }).sessionId;
      if (gone) this.sessionHandlers.delete(gone);
    }
  }

  private onClosed(reason: string): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CdpClosedError(`The browser connection closed during ${p.method}`));
      this.pending.delete(id);
    }
    for (const handler of [...this.closeHandlers]) {
      try { handler(reason); } catch {}
    }
    this.closeHandlers.clear();
    this.eventHandlers.clear();
    this.sessionHandlers.clear();
  }
}
