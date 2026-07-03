/**
 * Main-process diagnostics for the host renderer.
 *
 * The renderer occasionally goes black. There are three distinct causes and
 * the in-page console is unreachable for all of them, so we capture what we
 * can from the *main* process — which keeps running — into a persistent log
 * file:
 *
 *   - render-process-gone : the renderer process crashed / was OOM-killed.
 *                           The page is dead; DevTools can't attach. The log
 *                           line (reason + exitCode) is the only evidence.
 *   - unresponsive        : the renderer is alive but wedged on a long
 *                           synchronous task. The window freezes and often
 *                           paints black. DevTools CAN still attach and pause
 *                           on the blocked stack — see the shortcut below.
 *   - did-fail-load       : the host URL (the bun bridge) never loaded.
 *
 * We also intercept the DevTools shortcut in the main process via
 * `before-input-event`, so it opens even while the page is wedged — the normal
 * in-renderer path can't run when JS is blocked. DevTools opens detached so it
 * stays visible even if the main window itself is painting black.
 */
import { app, powerMonitor, type BrowserWindow } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

let logFilePath: string | null = null;

function ensureLogFile(): string {
  if (logFilePath) return logFilePath;
  // ~/Library/Logs/<app> on macOS, %APPDATA%\<app>\logs on Windows. Writable
  // and discoverable, unlike the packaged app directory.
  const dir = app.getPath('logs');
  try { mkdirSync(dir, { recursive: true }); } catch {}
  logFilePath = join(dir, 'main.log');
  return logFilePath;
}

/** Absolute path of the main-process log file (for surfacing to the user). */
export function diagnosticsLogPath(): string {
  return ensureLogFile();
}

// --- renderer memory sampling --------------------------------------------
//
// The black-screen crash is an EXC_BREAKPOINT / SIGTRAP on CrRendererMain,
// which is V8 aborting — most often a heap OOM. To confirm OOM (vs an
// internal V8 CHECK) we track the host renderer's working set: warn as it
// climbs, and on crash dump the last sample + peak. A renderer sitting at
// multiple GB right before the trap is the OOM signature.
const THRESHOLDS_MB = [1536, 2048, 3072, 4096];
let metricsTimer: ReturnType<typeof setInterval> | null = null;
let lastHostSample = '(no sample yet)';
let peakHostMB = 0;
const warnedThresholds = new Set<number>();

function sampleOnce(win: BrowserWindow): void {
  let hostPid = -1;
  try { if (!win.isDestroyed()) hostPid = win.webContents.getOSProcessId(); } catch {}
  let metrics: Electron.ProcessMetric[] = [];
  try { metrics = app.getAppMetrics(); } catch { return; }
  // Renderer processes report as type 'Tab'. The host window is one of them;
  // the embedded browser-preview BrowserViews are the others.
  const renderers = metrics.filter((m) => m.type === 'Tab');
  const host = renderers.find((m) => m.pid === hostPid);
  if (!host) return;
  const mb = Math.round(host.memory.workingSetSize / 1024);
  const others = renderers.filter((m) => m.pid !== hostPid);
  const othersMB = Math.round(others.reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024);
  lastHostSample = `host renderer pid=${hostPid} ws=${mb}MB; ${others.length} other renderer(s) ws=${othersMB}MB`;
  if (mb > peakHostMB) peakHostMB = mb;
  for (const t of THRESHOLDS_MB) {
    if (mb >= t && !warnedThresholds.has(t)) {
      warnedThresholds.add(t);
      logMain(`[renderer] memory HIGH — host working set crossed ${t}MB (now ${mb}MB). A V8 heap OOM traps (SIGTRAP) as the heap nears its limit.`);
    }
  }
}

/** Begin periodic renderer-memory sampling. Idempotent; timer is unref'd so
 *  it never keeps the process alive on its own. */
export function startRendererMetricsSampling(win: BrowserWindow, intervalMs = 20000): void {
  if (metricsTimer) return;
  sampleOnce(win);
  metricsTimer = setInterval(() => sampleOnce(win), intervalMs);
  if (typeof metricsTimer.unref === 'function') metricsTimer.unref();
}

export function logMain(...args: unknown[]): void {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : JSON.stringify(a)))
    .join(' ')}`;
  console.log(msg);
  try { appendFileSync(ensureLogFile(), msg + '\n'); } catch {}
}

function openDevToolsSafely(win: BrowserWindow): void {
  try {
    const wc = win.webContents;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: 'detach' });
  } catch (e) {
    logMain('[diagnostics] failed to toggle DevTools:', e);
  }
}

/** True for the standard DevTools chords: F12, Cmd/Ctrl+Alt+I, Cmd/Ctrl+Shift+I. */
function isDevToolsChord(input: Electron.Input): boolean {
  if (input.type !== 'keyDown') return false;
  if (input.key === 'F12') return true;
  const i = input.key.toLowerCase();
  const mod = input.meta || input.control;
  return i === 'i' && mod && (input.alt || input.shift);
}

// Recovery throttle shared by the render-process-gone and power-resume paths
// below, so a renderer that's crash-looping (e.g. still pointed at whatever
// killed it) can't spin the main process reloading it forever.
const RELOAD_COOLDOWN_MS = 30_000;
let lastReloadAt = 0;

function reloadAfterCrash(win: BrowserWindow, reason: string): void {
  if (win.isDestroyed()) return;
  const now = Date.now();
  if (now - lastReloadAt < RELOAD_COOLDOWN_MS) {
    logMain(`[renderer] skipping auto-reload (${reason}) — within ${RELOAD_COOLDOWN_MS / 1000}s cooldown of last reload`);
    return;
  }
  lastReloadAt = now;
  logMain(`[renderer] auto-reloading window (${reason})`);
  win.reload();
}

export function wireRendererDiagnostics(win: BrowserWindow): void {
  const wc = win.webContents;

  // The classic black screen: the renderer process died. `details.reason` is
  // one of 'crashed' | 'oom' | 'killed' | 'launch-failed' | ... and exitCode
  // narrows it further. Nothing in the page survives, so this log line is the
  // primary evidence after the fact. We also auto-reload so a crash doesn't
  // leave the user staring at a permanently black window.
  wc.on('render-process-gone', (_e, details) => {
    logMain(
      '[renderer] render-process-gone:', JSON.stringify(details),
      `| last mem: ${lastHostSample} | peak host ws=${peakHostMB}MB | crash dump: ${app.getPath('crashDumps')}`,
    );
    if (details.reason === 'crashed' || details.reason === 'oom') {
      reloadAfterCrash(win, `render-process-gone: ${details.reason}`);
    }
  });

  // macOS can leave the renderer painting black after a system sleep/wake
  // cycle (the GPU process loses its context) even when the process itself
  // survives. `invalidate()` forces a fresh paint over the woken-up GPU
  // context; if the renderer didn't survive at all, reload it instead.
  powerMonitor.on('resume', () => {
    if (win.isDestroyed()) return;
    if (wc.isCrashed()) {
      reloadAfterCrash(win, 'power resume: renderer crashed while asleep');
    } else {
      logMain('[renderer] power resume — invalidating to force a repaint');
      wc.invalidate();
    }
  });

  // Renderer alive but hung on a long synchronous task — frozen, often black.
  // DevTools (opened from the main process below) can still pause on it.
  win.on('unresponsive', () => {
    logMain('[renderer] window UNRESPONSIVE — renderer hung. Press Cmd+Alt+I to open DevTools and inspect.');
  });
  win.on('responsive', () => {
    logMain('[renderer] window responsive again');
  });

  // The host document failed to load (e.g. the bridge URL wasn't up yet).
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    logMain(`[renderer] did-fail-load: code=${errorCode} "${errorDescription}" url=${validatedURL}`);
  });

  // A throw in the preload bridge, before the page even runs.
  wc.on('preload-error', (_e, preloadPath, error) => {
    logMain(`[renderer] preload-error in ${preloadPath}:`, error);
  });

  // Mirror renderer-side warnings/errors into the file, so a React error that
  // blanks the UI leaves a trail even when DevTools never got opened. Skip
  // info/debug to keep the log focused.
  wc.on('console-message', (details) => {
    if (details.level !== 'error' && details.level !== 'warning') return;
    logMain(`[renderer:console.${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
  });

  // Intercept the DevTools chord in the main process so it works even while
  // the renderer is wedged (the in-page menu accelerator can't run then).
  wc.on('before-input-event', (event, input) => {
    if (isDevToolsChord(input)) {
      event.preventDefault();
      openDevToolsSafely(win);
    }
  });

  startRendererMetricsSampling(win);
}
