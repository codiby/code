import type { ChildProcess } from 'child_process';
import type { ProviderSession } from './provider/types';
import type { PtyHandle } from './process/pty';

/** A configured remote — points at an entry in the user's ~/.ssh/config. */
export type Remote = {
  id: string;          // rmt_<uuid>
  name: string;        // unique display label
  alias: string;       // Host alias as it appears in ~/.ssh/config
  bunPort: number;     // port where the bun server listens on the remote (default 3111)
  color: string;       // one of GROUP_COLORS; drives tab tint
  createdAt: number;
};

/** Per-session port forward declaration. localPort=null → pick a free one at open time. */
export type PortForward = {
  localPort: number | null;
  remotePort: number;
  label?: string;
};

/** Lifecycle / visibility state of a session, persisted on disk.
 *   - `open`     — visible in the UI as a tab.
 *   - `archived` — hidden from the tab bar; reachable via the archived list. */
export type SessionStatus = 'open' | 'archived';

/** Runtime state of the underlying Claude/provider process. Lives in memory
 *  only — never persisted (a session's process state is meaningless across
 *  server restarts). Renamed from `status` to disambiguate from the persisted
 *  UI lifecycle status above. */
export type RuntimeStatus = 'starting' | 'running' | 'stopped';

export type Session = {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  /** Wall-clock of the last meaningful activity (message added, archive
   *  toggled, rename, etc). Drives the "most recent first" ordering in
   *  the restore-archived dropdown so a session you just closed jumps
   *  to the top. Persisted. */
  updatedAt: number;
  claudeSessionId: string | null;
  browserWs: Set<any>;
  providerSession: ProviderSession | null;
  /** Bumped every time `startProviderSession` is called. The bridge
   *  captures the current value when it subscribes; on `onExit` it
   *  no-ops if the session's gen has moved on, which prevents a
   *  late-firing exit for a previous provider (e.g. during a restart)
   *  from clobbering the freshly-spawned one. In-memory only — like
   *  `providerSession`, meaningless across server restarts. */
  providerSessionGen: number;
  ready: boolean;
  /** UI lifecycle / visibility — persisted. */
  status: SessionStatus;
  /** Live process state — in-memory only. */
  runtimeStatus: RuntimeStatus;
  replayDone: boolean;
  savedCommands: string[];
  model: string | null;
  permissionMode: string;
  provider: string;
  /** Null for local sessions; otherwise the Remote.id this session lives on. */
  remoteId: string | null;
  /** Port forwards opened while this session has at least one pane visible. */
  portForwards: PortForward[];
};

export type PersistedSession = {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  /** Last-touched timestamp. Defaults to createdAt when missing. */
  updatedAt?: number;
  claudeSessionId: string | null;
  /** Persisted UI status; defaults to 'open' when missing (legacy files). */
  status?: SessionStatus;
  savedCommands?: string[];
  model?: string | null;
  permissionMode?: string;
  provider?: string;
  remoteId?: string | null;
  portForwards?: PortForward[];
};

export interface TrackedProcess {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  sessionId: string;
  startedAt: number;
  // For oneshot processes spawned with child_process.spawn this is the
  // ChildProcess; for re-adopted entries (after server restart) it's null.
  // PTY entries leave this null and use `pty` instead.
  proc: ChildProcess | null;
  viewers: Set<any>;
  outputBuffer: string[];
  exitCode: number | null;
  // Interactive PTY sessions (spawned via exec_shell):
  //   kind === 'pty' — long-lived shell driven by Bun.Terminal.
  //   kind === undefined/'oneshot' — `>` one-shot command via child_process.spawn.
  kind?: 'oneshot' | 'pty';
  cols?: number;
  rows?: number;
  // Bun-native PTY handle. Only set when kind === 'pty' and the entry was
  // spawned in *this* server lifetime (re-adopted PTY entries are killed
  // rather than restored — see restoreProcessRegistry).
  pty?: PtyHandle;
  // Optional human-readable label for processes spawned via the
  // `spawn_terminal` SDK tool ("API Server", "Vite Dev", etc). Lets the
  // model look the process up by name in `read_terminal_output`.
  label?: string;
  // Display name surfaced in the terminals dock tab + status strip. Set by
  // named spawners (actions_run → the action name). Distinct from `label`,
  // which is the MCP lookup key; `terminalName` is purely cosmetic.
  terminalName?: string;
  // Best-effort URL the terminal serves at (e.g. a portless hostname).
  // Rendered as a clickable link in the terminals dock status strip.
  terminalUrl?: string;
  // Command the terminal auto-runs on its first byte. Kept so a re-attach /
  // list can show what's running; the raw `command` may be "(interactive
  // shell)" for a bare shell.
  autoRunCommand?: string;
  // Env vars taskr injected into this child at spawn time — purely for
  // UI display in the terminals panel ("env · N" badge). The actual env
  // was already merged into the OS-level process; this is just a snapshot
  // so the user can see what was bound without diffing manually.
  injectedEnv?: Record<string, string>;
}

/**
 * Wire shape for a terminal as a first-class resource. Served by the
 * `/session/:id/terminals` CRUD endpoints and broadcast to subscribed
 * frontend clients on `terminal_created` / `terminal_removed`. The frontend
 * terminals dock renders straight from a list of these — terminals are no
 * longer inferred from chat messages.
 *
 * `id === procId` so it can double as a stable React key.
 */
export interface TerminalInfo {
  id: string;
  procId: string;
  sessionId: string;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  startedAt: number;
  exitCode: number | null;
  kind: 'oneshot' | 'pty';
  label?: string;
  terminalName?: string;
  terminalUrl?: string;
  injectedEnv?: Record<string, string>;
}
