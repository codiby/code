/**
 * Terminals as a first-class resource.
 *
 * This is the SINGLE spawn/list/attach/kill path shared by:
 *   - the REST CRUD endpoints (`/sessions/:id/terminals`) the UI drives, and
 *   - the in-process MCP tools (`spawn_terminal`, `actions_run`).
 *
 * Both used to build PTYs by hand in three different places; now everything
 * funnels through `createTerminal`, so a terminal spawned by the model and one
 * spawned by the user are indistinguishable and both broadcast the same
 * `terminal_created` lifecycle event.
 *
 * Transport split: lifecycle (create/list/read/kill) is REST; live I/O
 * (keystrokes in, bytes out) stays on the frontend `/ws` multiplexer via the
 * `terminal_input` / `terminal_resize` messages and the `terminal_data` /
 * `terminal_exit` / `terminal_reset` broadcasts.
 */

import { randomUUID } from 'crypto';
import { log } from '../lib/logger';
import { spawnPty } from '../process/pty';
import type { TerminalInfo, TrackedProcess } from '../types';
import {
  trackedProcesses,
  saveProcessRegistry,
  appendProcessOutput,
  addToGraveyard,
  killTrackedProcess,
} from './processes';
import { pokeProcessMonitor } from '../process/process-monitor';

// ---------------------------------------------------------------------------
// Broadcast wiring. Set once at startup from index.ts so this module can push
// lifecycle events to subscribed frontend clients without importing the WS
// server (which would create a circular dependency).
// ---------------------------------------------------------------------------

type Broadcaster = (sessionId: string, msg: object) => void;
let _broadcast: Broadcaster = () => {};

export function setTerminalBroadcaster(fn: Broadcaster): void {
  _broadcast = fn;
}

const MAX_COLS = 500;
const MAX_ROWS = 200;
const clampCols = (n: unknown) => Math.max(1, Math.min(MAX_COLS, Number(n) || 120));
const clampRows = (n: unknown) => Math.max(1, Math.min(MAX_ROWS, Number(n) || 30));

/** Project a tracked process onto the public terminal wire shape. */
export function toTerminalInfo(tp: TrackedProcess): TerminalInfo {
  return {
    id: tp.id,
    procId: tp.id,
    sessionId: tp.sessionId,
    command: tp.autoRunCommand ?? tp.command,
    cwd: tp.cwd,
    cols: tp.cols ?? 120,
    rows: tp.rows ?? 30,
    startedAt: tp.startedAt,
    exitCode: tp.exitCode,
    kind: tp.kind || 'pty',
    label: tp.label,
    terminalName: tp.terminalName,
    terminalUrl: tp.terminalUrl,
    injectedEnv: tp.injectedEnv,
  };
}

export interface CreateTerminalOptions {
  sessionId: string;
  cwd: string;
  cols?: number;
  rows?: number;
  /** Command auto-typed on the PTY's first byte. Omit for a bare interactive
   *  shell. `read_terminal_output` / the dock display this as the command. */
  command?: string;
  /** MCP lookup key (`read_terminal_output` name-match). */
  label?: string;
  /** Cosmetic display name for the dock tab. */
  terminalName?: string;
  /** URL the terminal serves at (portless hostname). */
  terminalUrl?: string;
  /** Env snapshot already merged into the OS-level process — for the "env · N"
   *  badge. Callers compute this (they own preferences/action config). */
  injectedEnv?: Record<string, string>;
  /** Extra per-chunk hook (e.g. actions_run scraping the portless URL). Runs
   *  after buffering + broadcast. */
  onData?: (text: string) => void;
}

export type CreateTerminalResult =
  | { ok: true; info: TerminalInfo; tp: TrackedProcess }
  | { ok: false; error: string };

/**
 * Spawn a PTY-backed terminal, register it, wire its I/O to the session
 * broadcast, and announce it with `terminal_created`. The auto-run command
 * (if any) is typed on the first byte — once the shell has sourced its rc
 * files and is ready to read input.
 */
export function createTerminal(opts: CreateTerminalOptions): CreateTerminalResult {
  const { sessionId } = opts;
  const cwd = opts.cwd || process.env.HOME || '/';
  const cols = clampCols(opts.cols);
  const rows = clampRows(opts.rows);
  const extraEnv = opts.injectedEnv || {};

  const pty = spawnPty({ cwd, cols, rows, sessionId, extraEnv });
  if (!pty) {
    return { ok: false, error: 'Failed to spawn PTY (Bun.Terminal requires Bun >= 1.3.5).' };
  }

  const procId = randomUUID();
  const autoRun = opts.command && opts.command.trim() ? opts.command : undefined;

  const tp: TrackedProcess = {
    id: procId,
    pid: pty.pid,
    command: autoRun || '(interactive shell)',
    cwd,
    sessionId,
    startedAt: Date.now(),
    proc: null,
    viewers: new Set(),
    outputBuffer: [],
    exitCode: null,
    kind: 'pty',
    cols,
    rows,
    pty,
    label: opts.label,
    terminalName: opts.terminalName,
    terminalUrl: opts.terminalUrl,
    autoRunCommand: autoRun,
    injectedEnv: Object.keys(extraEnv).length > 0 ? extraEnv : undefined,
  };
  trackedProcesses.set(procId, tp);
  saveProcessRegistry();
  pokeProcessMonitor();

  let didType = false;
  pty.onData((text: string) => {
    tp.outputBuffer.push(text);
    if (tp.outputBuffer.length > 1000) tp.outputBuffer.splice(0, tp.outputBuffer.length - 500);
    appendProcessOutput(procId, text);
    _broadcast(sessionId, { type: 'terminal_data', sessionId, procId, text });
    try { opts.onData?.(text); } catch {}
    if (autoRun && !didType) {
      didType = true;
      try { pty.write(autoRun + '\r'); } catch {}
    }
  });
  pty.onExit((code: number) => {
    if (tp.exitCode !== null) return;
    tp.exitCode = code;
    log(`[terminals] pty exited procId=${procId.slice(0, 8)} code=${code}`);
    _broadcast(sessionId, { type: 'terminal_exit', sessionId, procId, code });
    addToGraveyard(procId);
    pokeProcessMonitor();
    // Keep the exited terminal around briefly so the user can read the exit
    // code, then GC it and tell the UI to drop it from the list.
    setTimeout(() => {
      if (trackedProcesses.delete(procId)) {
        saveProcessRegistry();
        _broadcast(sessionId, { type: 'terminal_removed', sessionId, procId });
      }
    }, 30_000);
  });

  const info = toTerminalInfo(tp);
  _broadcast(sessionId, { type: 'terminal_created', sessionId, terminal: info });
  log(`[terminals] created procId=${procId.slice(0, 8)} session=${sessionId.slice(0, 8)} pid=${pty.pid} cwd=${cwd}${opts.terminalName ? ` name="${opts.terminalName}"` : ''}`);

  return { ok: true, info, tp };
}

/** List every live terminal for a session (drops entries whose pid died). */
export function listTerminals(sessionId: string): TerminalInfo[] {
  const out: TerminalInfo[] = [];
  for (const tp of trackedProcesses.values()) {
    if (tp.sessionId !== sessionId) continue;
    out.push(toTerminalInfo(tp));
  }
  out.sort((a, b) => a.startedAt - b.startedAt);
  return out;
}

export function getTerminal(sessionId: string, procId: string): TerminalInfo | null {
  const tp = trackedProcesses.get(procId);
  if (!tp || tp.sessionId !== sessionId) return null;
  return toTerminalInfo(tp);
}

/** Current buffered output for a terminal, or null when unknown. */
export function getTerminalOutput(sessionId: string, procId: string): string | null {
  const tp = trackedProcesses.get(procId);
  if (!tp || tp.sessionId !== sessionId) return null;
  return tp.outputBuffer.join('');
}

/**
 * Re-attach a viewer to a live PTY: wipe the client's xterm (so a stale local
 * replay doesn't double up), replay the authoritative buffer, and push the
 * viewer's current cols/rows through. Returns false when there's nothing live
 * to attach to.
 */
export function attachTerminal(sessionId: string, procId: string, cols: number, rows: number): boolean {
  const tp = trackedProcesses.get(procId);
  if (!tp || tp.sessionId !== sessionId || tp.kind !== 'pty' || tp.exitCode !== null) return false;
  const replay = tp.outputBuffer.join('');
  _broadcast(sessionId, { type: 'terminal_reset', sessionId, procId });
  if (replay) _broadcast(sessionId, { type: 'terminal_data', sessionId, procId, text: replay });
  const c = clampCols(cols);
  const r = clampRows(rows);
  try { tp.pty?.resize(c, r); tp.cols = c; tp.rows = r; } catch {}
  log(`[terminals] re-attached procId=${procId.slice(0, 8)} (replayed ${replay.length} bytes)`);
  return true;
}

/**
 * Kill a terminal and remove it from the list. Close === kill: the dock's
 * close button and the `kill_terminal` MCP tool both land here. Broadcasts
 * `terminal_removed` so subscribed clients drop the tab immediately.
 */
export function removeTerminal(sessionId: string, procId: string): boolean {
  const tp = trackedProcesses.get(procId);
  if (!tp || tp.sessionId !== sessionId) return false;
  killTrackedProcess(procId);
  _broadcast(sessionId, { type: 'terminal_removed', sessionId, procId });
  pokeProcessMonitor();
  log(`[terminals] removed procId=${procId.slice(0, 8)} session=${sessionId.slice(0, 8)}`);
  return true;
}
