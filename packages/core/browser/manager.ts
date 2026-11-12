/**
 * The bridge's own browser: one Chromium per bridge, started on first use.
 *
 * Tabs are keyed by (session, preview name) — the same pair the `browser_*`
 * tools address — and each is a page target driven over one flatten-mode CDP
 * session. The agent session browses in the browser's default context, which
 * is the persistent profile, so its logins survive restarts. Every other
 * session gets an isolated in-memory context per cookie jar: a coding session
 * must never ride on the agent's (that is, the owner's) signed-in accounts.
 *
 * A tab record outlives its Chromium target. When the browser idles out,
 * crashes or is stopped, records go dormant and the next request reopens them
 * at the last URL they showed — callers never see the restart.
 */

import { dirname, join } from 'path';
import { log, logError } from '../lib/logger';
import { CdpClient } from './cdp-client';
import { PageSession, dispatchAction, enablePageDomains, goto, screenshotJpeg, type BrowserAction } from './actions';
import { discoverChromium, type ChromiumExecutable, type ChromiumKind, type DiscoveryResult } from './discovery';
import { WINDOW_SIZE, launchWithSandboxFallback, type LaunchError, type LaunchedChromium } from './launcher';
import { reapStaleChromium, removePidFile, writePidFile } from './pidfile';

export const DEFAULT_COOKIE_JAR = 'default';

const IDLE_MS = 15 * 60_000;
const SHOT_CACHE_MS = 1_000;
const CRASH_WINDOW_MS = 2 * 60_000;
const MAX_CRASHES = 3;
const STOP_GRACE_MS = 5_000;

/** Internal opens may also show inline pages (tests, blank tabs); tools only ever pass http(s). */
const OPEN_SCHEMES = ['http:', 'https:', 'data:'] as const;

export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserUnavailableError';
  }
}

export class NoHeadlessTabError extends Error {
  constructor(readonly tabName: string) {
    super(`No browser preview named "${tabName}" is open in this session. Call browser_open with name="${tabName}" first.`);
    this.name = 'NoHeadlessTabError';
  }
}

export interface HeadlessTabInfo {
  sessionId: string;
  name: string;
  url: string;
  title: string;
  cookieJar: string;
  /** False while dormant (browser stopped); the next request reopens it. */
  live: boolean;
  agent: boolean;
  lastUsedAt: number;
}

export interface HeadlessStatus {
  running: boolean;
  starting: boolean;
  /** Chromium binary in use, or the one the next launch would use. */
  executable: string | null;
  executableKind: ChromiumKind | null;
  /** False when no Chromium was found on this host. */
  available: boolean;
  error: string | null;
  pid: number | null;
  sandbox: boolean | null;
  startedAt: number | null;
  lastUsedAt: number | null;
  idleShutdownAt: number | null;
  tabs: HeadlessTabInfo[];
}

export interface TabFallback {
  url: string;
  cookieJar?: string;
}

type LaunchFn = (opts: {
  executable: ChromiumExecutable;
  userDataDir: string;
  preferNoSandbox?: boolean;
  onSandboxFallback?: (err: LaunchError) => void;
}) => Promise<LaunchedChromium>;

export interface HeadlessBrowserOptions {
  profileDir: string;
  isAgentSession(sessionId: string): boolean;
  discover?: () => DiscoveryResult;
  launch?: LaunchFn;
  connect?: (wsEndpoint: string) => Promise<CdpClient>;
  idleMs?: number;
  /** How often idleness is checked; defaults to a quarter of `idleMs`, capped at a minute. */
  idleCheckMs?: number;
}

interface Running {
  launched: LaunchedChromium;
  client: CdpClient;
  executable: ChromiumExecutable;
  startedAt: number;
  contexts: Map<string, Promise<string>>;
  idleTimer: ReturnType<typeof setInterval>;
}

interface LiveTab {
  run: Running;
  targetId: string;
  cdpSessionId: string;
  page: PageSession;
  off(): void;
}

interface TabRecord {
  key: string;
  sessionId: string;
  name: string;
  cookieJar: string;
  url: string;
  title: string;
  lastUsedAt: number;
  live: LiveTab | null;
  opening: Promise<LiveTab> | null;
}

function tabKey(sessionId: string, name: string): string {
  return `${sessionId}\u0000${name}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function checkOpenUrl(url: string): void {
  if (url === 'about:blank') return;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`Invalid URL "${url}"`); }
  if (!(OPEN_SCHEMES as readonly string[]).includes(parsed.protocol)) throw new Error('Only http/https URLs are supported');
}

export class HeadlessBrowser {
  readonly profileDir: string;
  private readonly pidFile: string;
  private readonly isAgent: (sessionId: string) => boolean;
  private readonly discover: () => DiscoveryResult;
  private readonly launchFn: LaunchFn;
  private readonly connectFn: (wsEndpoint: string) => Promise<CdpClient>;
  private readonly idleMs: number;
  private readonly idleCheckMs: number;
  private previewExists: ((sessionId: string, name: string) => boolean) | null = null;

  private running: Running | null = null;
  private starting: Promise<Running> | null = null;
  private readonly tabs = new Map<string, TabRecord>();
  private readonly shots = new Map<string, { at: number; data: Buffer }>();
  private readonly shotsInflight = new Map<string, Promise<Buffer>>();
  private inflight = 0;
  private lastUsedAt = 0;
  private lastError: string | null = null;
  private crashes: number[] = [];
  /** Once a host has shown it needs --no-sandbox, later launches skip the doomed attempt. */
  private needsNoSandbox = false;
  private exitHookInstalled = false;
  private discovery: { at: number; result: DiscoveryResult } | null = null;

  constructor(opts: HeadlessBrowserOptions) {
    this.profileDir = opts.profileDir;
    this.pidFile = join(dirname(opts.profileDir), 'chromium.pid');
    this.isAgent = opts.isAgentSession;
    this.discover = opts.discover ?? (() => discoverChromium());
    this.launchFn = opts.launch ?? ((o) => launchWithSandboxFallback(o));
    this.connectFn = opts.connect ?? ((ws) => CdpClient.connect(ws));
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.idleCheckMs = opts.idleCheckMs ?? Math.max(1_000, Math.min(60_000, Math.floor(this.idleMs / 4)));
  }

  /**
   * Lets the manager drop tabs whose preview was closed by a path that never
   * talks to it (the HTTP `ui_browser_close` tool).
   */
  setPreviewLookup(fn: ((sessionId: string, name: string) => boolean) | null): void {
    this.previewExists = fn;
  }

  get isRunning(): boolean {
    return !!this.running && !this.running.client.closed;
  }

  hasTab(sessionId: string, name: string): boolean {
    return this.tabs.has(tabKey(sessionId, name));
  }

  listTabs(sessionId?: string): HeadlessTabInfo[] {
    return [...this.tabs.values()]
      .filter(rec => sessionId === undefined || rec.sessionId === sessionId)
      .map(rec => this.describe(rec));
  }

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------

  /**
   * Open (or re-point) the tab for `(sessionId, name)`. A page that fails to
   * load still leaves a usable tab — like a browser showing its error page —
   * and the failure comes back as `navigationError`.
   */
  async openTab(sessionId: string, name: string, opts: { url: string; cookieJar?: string }): Promise<{ tab: HeadlessTabInfo; navigationError?: string }> {
    checkOpenUrl(opts.url);
    const jar = opts.cookieJar || DEFAULT_COOKIE_JAR;
    return this.busy(async () => {
      let rec = this.tabs.get(tabKey(sessionId, name));
      // A context is fixed when its target is created; a new jar means a new tab.
      if (rec && rec.cookieJar !== jar) {
        await this.closeTab(sessionId, name);
        rec = undefined;
      }
      const created = !rec;
      if (!rec) rec = this.addRecord(sessionId, name, jar, opts.url);
      rec.url = opts.url;
      rec.lastUsedAt = Date.now();

      let live: LiveTab;
      try {
        live = await this.ensureLive(rec);
      } catch (err) {
        if (created) this.tabs.delete(rec.key);
        throw err;
      }
      try {
        if (opts.url !== 'about:blank') await goto(live.page, opts.url, { allowedSchemes: OPEN_SCHEMES });
      } catch (err) {
        return { tab: this.describe(rec), navigationError: errorText(err) };
      }
      return { tab: this.describe(rec) };
    });
  }

  async closeTab(sessionId: string, name: string): Promise<boolean> {
    const key = tabKey(sessionId, name);
    const rec = this.tabs.get(key);
    if (!rec) return false;
    this.tabs.delete(key);
    this.shots.delete(key);
    // Let an in-flight open land first, or its target would leak.
    if (rec.opening) await rec.opening.catch(() => {});
    const live = rec.live;
    rec.live = null;
    if (live) {
      live.off();
      if (!live.run.client.closed) await live.run.client.closeTarget(live.targetId).catch(() => {});
    }
    return true;
  }

  async closeSessionTabs(sessionId: string): Promise<number> {
    const names = [...this.tabs.values()].filter(r => r.sessionId === sessionId).map(r => r.name);
    for (const name of names) await this.closeTab(sessionId, name);
    return names.length;
  }

  /**
   * The live page behind a tab, starting the browser or reviving a dormant
   * tab as needed. `fallback` creates the tab when a preview was opened by a
   * path that never reached the headless browser (e.g. `ui_browser_open`).
   */
  async page(sessionId: string, name: string, fallback?: TabFallback): Promise<PageSession> {
    let rec = this.tabs.get(tabKey(sessionId, name));
    if (rec && this.previewExists && !this.previewExists(sessionId, name)) {
      await this.closeTab(sessionId, name);
      rec = undefined;
    }
    let created = false;
    if (!rec) {
      if (!fallback) throw new NoHeadlessTabError(name);
      checkOpenUrl(fallback.url);
      rec = this.addRecord(sessionId, name, fallback.cookieJar || DEFAULT_COOKIE_JAR, fallback.url);
      created = true;
    }
    rec.lastUsedAt = Date.now();
    try {
      const live = await this.ensureLive(rec, { revive: true });
      return live.page;
    } catch (err) {
      // A tab that never opened (no Chromium, launch failure) is not worth listing as dormant.
      if (created && !rec.live && this.tabs.get(rec.key) === rec) this.tabs.delete(rec.key);
      throw err;
    }
  }

  /** Run one `browser_*` action. Starting Chromium does not count against `timeoutMs`. */
  async run(sessionId: string, name: string, action: BrowserAction, args: Record<string, unknown>, opts: { timeoutMs: number; fallback?: TabFallback }): Promise<unknown> {
    return this.busy(async () => {
      const page = await this.page(sessionId, name, opts.fallback);
      return withTimeout(dispatchAction(page, action, args), opts.timeoutMs, `browser_${action}(${name}) timed out after ${opts.timeoutMs}ms`);
    });
  }

  /**
   * A JPEG of a live tab for the owner's live view, at most one capture per
   * second per tab however many viewers poll. Watching never starts the
   * browser or revives a dormant tab — and does not keep it from idling out.
   */
  async liveScreenshot(sessionId: string, name: string): Promise<Buffer | null> {
    const key = tabKey(sessionId, name);
    const rec = this.tabs.get(key);
    const live = rec?.live;
    if (!rec || !live || live.run !== this.running || live.run.client.closed) return null;
    const cached = this.shots.get(key);
    if (cached && Date.now() - cached.at < SHOT_CACHE_MS) return cached.data;
    const pending = this.shotsInflight.get(key);
    if (pending) return pending;
    const p = screenshotJpeg(live.page, 60)
      .then((data) => {
        if (this.tabs.get(key) === rec) this.shots.set(key, { at: Date.now(), data });
        return data;
      })
      .finally(() => this.shotsInflight.delete(key));
    this.shotsInflight.set(key, p);
    return p;
  }

  // -------------------------------------------------------------------------
  // Status and lifecycle
  // -------------------------------------------------------------------------

  async status(): Promise<HeadlessStatus> {
    await this.pruneClosedPreviews();
    const run = this.running && !this.running.client.closed ? this.running : null;
    await Promise.all([...this.tabs.values()].map(async (rec) => {
      if (!rec.live || rec.live.run !== run) return;
      try {
        const info = await withTimeout(rec.live.page.info(), 2_000, 'info timed out');
        if (info.url) rec.url = info.url;
        rec.title = info.title || rec.title;
      } catch {}
    }));

    let executable: ChromiumExecutable | null = run?.executable ?? null;
    let discoveryError: string | null = null;
    if (!executable) {
      const found = this.cachedDiscovery();
      if (found.ok) executable = found.executable;
      else discoveryError = found.error;
    }
    const tabs = [...this.tabs.values()]
      .map(rec => this.describe(rec))
      .sort((a, b) => Number(b.agent) - Number(a.agent) || b.lastUsedAt - a.lastUsedAt);
    return {
      running: !!run,
      starting: !!this.starting,
      executable: executable?.path ?? null,
      executableKind: executable?.kind ?? null,
      available: !!executable,
      error: discoveryError ?? this.lastError,
      pid: run?.launched.pid ?? null,
      sandbox: run ? run.launched.sandbox : null,
      startedAt: run?.startedAt ?? null,
      lastUsedAt: this.lastUsedAt || null,
      idleShutdownAt: run ? Math.max(this.lastUsedAt, run.startedAt) + this.idleMs : null,
      tabs,
    };
  }

  /**
   * Close Chromium gracefully (so cookies reach the profile on disk). Tabs go
   * dormant rather than away: the next request reopens them.
   */
  async stop(reason: string): Promise<boolean> {
    if (this.starting) await this.starting.catch(() => {});
    const run = this.running;
    if (!run) return false;
    this.detachRun(run);
    try { await run.client.send('Browser.close', {}, { timeoutMs: 3_000 }); } catch {}
    run.client.close();
    const exited = await Promise.race([run.launched.exited.then(() => true), Bun.sleep(STOP_GRACE_MS).then(() => false)]);
    if (!exited) {
      try { run.launched.proc.kill('SIGKILL'); } catch {}
      await Promise.race([run.launched.exited, Bun.sleep(2_000)]);
    }
    removePidFile(this.pidFile);
    log(`[browser] Stopped Chromium (${reason})`);
    return true;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async busy<T>(fn: () => Promise<T>): Promise<T> {
    this.inflight++;
    this.lastUsedAt = Date.now();
    try {
      return await fn();
    } finally {
      this.inflight--;
      this.lastUsedAt = Date.now();
    }
  }

  private addRecord(sessionId: string, name: string, cookieJar: string, url: string): TabRecord {
    const rec: TabRecord = {
      key: tabKey(sessionId, name),
      sessionId,
      name,
      cookieJar,
      url,
      title: name,
      lastUsedAt: Date.now(),
      live: null,
      opening: null,
    };
    this.tabs.set(rec.key, rec);
    return rec;
  }

  private describe(rec: TabRecord): HeadlessTabInfo {
    const live = !!rec.live && rec.live.run === this.running && !rec.live.run.client.closed;
    return {
      sessionId: rec.sessionId,
      name: rec.name,
      url: rec.url,
      title: rec.title,
      cookieJar: rec.cookieJar,
      live,
      agent: this.isAgent(rec.sessionId),
      lastUsedAt: rec.lastUsedAt,
    };
  }

  private async pruneClosedPreviews(): Promise<void> {
    const exists = this.previewExists;
    if (!exists) return;
    for (const rec of [...this.tabs.values()]) {
      // A tab still opening may not have its preview registered yet.
      if (rec.opening) continue;
      if (!exists(rec.sessionId, rec.name)) await this.closeTab(rec.sessionId, rec.name);
    }
  }

  private cachedDiscovery(): DiscoveryResult {
    if (this.discovery && Date.now() - this.discovery.at < 30_000) return this.discovery.result;
    const result = this.discover();
    this.discovery = { at: Date.now(), result };
    return result;
  }

  private ensureLive(rec: TabRecord, opts: { revive?: boolean } = {}): Promise<LiveTab> {
    const current = rec.live;
    if (current && current.run === this.running && !current.run.client.closed) return Promise.resolve(current);
    if (rec.opening) return rec.opening;
    rec.opening = (async () => {
      const run = await this.ensureRunning();
      const live = await this.createLive(run, rec);
      if (this.running !== run || this.tabs.get(rec.key) !== rec) {
        live.off();
        await run.client.closeTarget(live.targetId).catch(() => {});
        throw new BrowserUnavailableError('The browser stopped while the tab was opening');
      }
      rec.live = live;
      if (opts.revive && rec.url && rec.url !== 'about:blank') {
        // A tab coming back after an idle stop or a crash shows what it showed
        // before; a dead site must not fail the action that revived it.
        await goto(live.page, rec.url, { allowedSchemes: OPEN_SCHEMES }).catch((err) => {
          log(`[browser] Reopened "${rec.name}" but ${rec.url} did not load: ${errorText(err)}`);
        });
      }
      return live;
    })().finally(() => { rec.opening = null; });
    return rec.opening;
  }

  private contextFor(run: Running, sessionId: string, jar: string): Promise<string> | undefined {
    const agent = this.isAgent(sessionId);
    if (agent && jar === DEFAULT_COOKIE_JAR) return undefined;
    // Agent jars and session jars never share a context, even with equal names.
    const key = `${agent ? 'agent' : 'session'}:${jar}`;
    let ctx = run.contexts.get(key);
    if (!ctx) {
      ctx = run.client.createBrowserContext();
      run.contexts.set(key, ctx);
      ctx.catch(() => { if (run.contexts.get(key) === ctx) run.contexts.delete(key); });
    }
    return ctx;
  }

  private async createLive(run: Running, rec: TabRecord): Promise<LiveTab> {
    const browserContextId = await this.contextFor(run, rec.sessionId, rec.cookieJar);
    const params: Record<string, unknown> = {
      url: 'about:blank',
      // Its own window keeps the tab "visible", so Chromium never throttles
      // its timers or skips the frames screenshots wait for.
      newWindow: true,
      width: WINDOW_SIZE.width,
      height: WINDOW_SIZE.height,
    };
    if (browserContextId) params.browserContextId = browserContextId;
    const { targetId } = await run.client.send<{ targetId: string }>('Target.createTarget', params);

    let cdpSessionId: string;
    try {
      cdpSessionId = await run.client.attachToTarget(targetId);
    } catch (err) {
      await run.client.closeTarget(targetId).catch(() => {});
      throw err;
    }

    const page = new PageSession({
      send: (method, p, o) => run.client.send(method, p ?? {}, { sessionId: cdpSessionId, timeoutMs: o?.timeoutMs }),
      info: async () => {
        const { targetInfo } = await run.client.send<{ targetInfo?: { url?: string; title?: string } }>('Target.getTargetInfo', { targetId }, { timeoutMs: 5_000 });
        return { url: targetInfo?.url ?? rec.url, title: targetInfo?.title ?? '' };
      },
    });

    let live: LiveTab;
    const off = run.client.onSession(cdpSessionId, (method, p) => {
      page.handleEvent(method, p);
      if (method === 'Page.frameNavigated' && p?.frame && !p.frame.parentId && typeof p.frame.url === 'string') {
        rec.url = p.frame.url;
      } else if (method === 'Page.navigatedWithinDocument' && p?.frameId === targetId && typeof p.url === 'string') {
        // A page target's main frame shares the target's id.
        rec.url = p.url;
      } else if (method === 'Inspector.targetCrashed' && rec.live === live) {
        logError(`[browser] The renderer of "${rec.name}" crashed; it reopens on next use`);
        rec.live = null;
        off();
        void run.client.closeTarget(targetId).catch(() => {});
      }
    });
    live = { run, targetId, cdpSessionId, page, off };
    await enablePageDomains(page);
    return live;
  }

  private ensureRunning(): Promise<Running> {
    if (this.running && !this.running.client.closed) return Promise.resolve(this.running);
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(): Promise<Running> {
    const now = Date.now();
    this.crashes = this.crashes.filter(t => now - t < CRASH_WINDOW_MS);
    if (this.crashes.length >= MAX_CRASHES) {
      const retryAt = new Date(this.crashes[0]! + CRASH_WINDOW_MS);
      throw new BrowserUnavailableError(`Chromium crashed ${this.crashes.length} times in the last ${CRASH_WINDOW_MS / 60_000} minutes; it will not be restarted before ${retryAt.toLocaleTimeString()}.`);
    }

    const found = this.discover();
    this.discovery = { at: now, result: found };
    if (!found.ok) {
      this.lastError = found.error;
      throw new BrowserUnavailableError(found.error);
    }
    const executable = found.executable;

    const reaped = await reapStaleChromium(this.pidFile, this.profileDir).catch(() => null);
    if (reaped) log(`[browser] Stopped a leftover Chromium (pid ${reaped}) that still held the profile`);

    let launched: LaunchedChromium;
    try {
      launched = await this.launchFn({
        executable,
        userDataDir: this.profileDir,
        preferNoSandbox: this.needsNoSandbox,
        onSandboxFallback: (err) => log(`[browser] Chromium cannot use its sandbox on this host (${err.message.slice(0, 200)}); retrying with --no-sandbox`),
      });
    } catch (err) {
      this.lastError = `Could not start Chromium: ${errorText(err)}`;
      throw new BrowserUnavailableError(this.lastError);
    }
    this.needsNoSandbox = !launched.sandbox;
    writePidFile(this.pidFile, { pid: launched.pid, userDataDir: this.profileDir, startedAt: Date.now() });

    let client: CdpClient;
    try {
      client = await this.connectFn(launched.wsEndpoint);
    } catch (err) {
      try { launched.proc.kill('SIGKILL'); } catch {}
      removePidFile(this.pidFile);
      this.lastError = `Could not connect to Chromium: ${errorText(err)}`;
      throw new BrowserUnavailableError(this.lastError);
    }

    const run: Running = {
      launched,
      client,
      executable,
      startedAt: Date.now(),
      contexts: new Map(),
      idleTimer: setInterval(() => this.checkIdle(), this.idleCheckMs),
    };
    // A timer must not keep a bridge (or a test run) alive on its own.
    (run.idleTimer as { unref?: () => void }).unref?.();

    client.on('Target.detachedFromTarget', (p: { sessionId?: string }) => {
      for (const rec of this.tabs.values()) {
        if (rec.live && rec.live.run === run && rec.live.cdpSessionId === p.sessionId) {
          rec.live.off();
          rec.live = null;
        }
      }
    });
    client.onClose((why) => { if (this.running === run) this.onCrash(run, `lost its DevTools connection (${why})`); });
    void launched.exited.then((code) => { if (this.running === run) this.onCrash(run, `exited with code ${code}`); });

    this.installExitHook();
    this.running = run;
    this.lastError = null;
    this.lastUsedAt = Date.now();
    log(`[browser] Started ${executable.kind} ${executable.path} (pid ${launched.pid}${launched.sandbox ? '' : ', --no-sandbox'})`);
    return run;
  }

  private checkIdle(): void {
    const run = this.running;
    if (!run || this.inflight > 0) return;
    if (Date.now() - Math.max(this.lastUsedAt, run.startedAt) < this.idleMs) return;
    const idle = this.idleMs >= 60_000 ? `${Math.round(this.idleMs / 60_000)} min` : `${Math.round(this.idleMs / 1000)} s`;
    void this.stop(`idle for ${idle}`);
  }

  private onCrash(run: Running, why: string): void {
    this.detachRun(run);
    this.crashes.push(Date.now());
    this.lastError = `Chromium ${why}`;
    logError(`[browser] Chromium ${why}; it restarts on next use`);
    try { run.launched.proc.kill('SIGKILL'); } catch {}
    run.client.close();
    removePidFile(this.pidFile);
  }

  /** Forget a run: its tabs go dormant and its timers stop. */
  private detachRun(run: Running): void {
    if (this.running === run) this.running = null;
    clearInterval(run.idleTimer);
    for (const rec of this.tabs.values()) {
      if (rec.live?.run === run) {
        rec.live.off();
        rec.live = null;
      }
    }
    this.shots.clear();
  }

  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    // `exit` handlers must be synchronous: a signal is all there is time for.
    // The pid file stays so the next bridge can reap a Chromium slow to die.
    process.once('exit', () => {
      const run = this.running;
      if (!run) return;
      try { run.launched.proc.kill('SIGTERM'); } catch {}
    });
  }
}
