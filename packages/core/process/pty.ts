// Bun-native PTY wrapper. Uses `new Bun.Terminal()` + `Bun.spawn({ terminal })`
// (Bun ≥ 1.3.5) to drive an interactive shell directly — no Node helper, no
// node-pty native binding.
//
// Usage:
//   const pty = spawnPty({ cwd: '/Users/me', cols: 120, rows: 30 });
//   pty.onData((bytes) => ws.send(bytes));
//   pty.onExit((code) => ...);
//   pty.write('ls\n');
//   pty.resize(140, 40);
//   pty.kill();

import { log } from '../lib/logger';

export interface PtyHandle {
  pid: number;
  cols: number;
  rows: number;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: NodeJS.Signals | number) => void;
  onData: (cb: (text: string) => void) => void;
  onExit: (cb: (code: number) => void) => void;
}

export interface SpawnPtyOptions {
  cwd: string;
  cols: number;
  rows: number;
  shell?: string;
  env?: Record<string, string | undefined>;
  /** When set, the PTY inherits the user's global + per-project env
   *  overrides for this session (project API keys, NODE_ENV, etc). */
  sessionId?: string;
  /** Extra env layered ON TOP of session overrides — used for dynamic
   *  taskr-managed values like cross-action URL injection. Wins over both
   *  process.env and the session/project env overrides. */
  extraEnv?: Record<string, string>;
}

export function spawnPty(opts: SpawnPtyOptions): PtyHandle | null {
  const isWin = process.platform === 'win32';
  const defaultShell = isWin
    ? (process.env.ComSpec || 'powershell.exe')
    : (process.env.SHELL || '/bin/zsh');
  const shell = opts.shell || defaultShell;

  const dataListeners: ((text: string) => void)[] = [];
  const exitListeners: ((code: number) => void)[] = [];
  let exited = false;
  let exitCode = 0;

  const decoder = new TextDecoder();

  if (typeof Bun.Terminal !== 'function') {
    log('[pty] Bun.Terminal unavailable — Bun must be >= 1.3.5');
    return null;
  }

  const terminal = new Bun.Terminal({
    cols: opts.cols,
    rows: opts.rows,
    name: 'xterm-256color',
    data: (_t, bytes) => {
      const text = decoder.decode(bytes);
      for (const cb of dataListeners) cb(text);
    },
    exit: (_t, code) => {
      if (exited) return;
      exited = true;
      exitCode = code ?? 0;
      for (const cb of exitListeners) cb(exitCode);
    },
  });

  // We stack two PTYs on macOS/Linux — this outer one and the inner one
  // `script(1)` allocates for the shell. Both default to ECHO+canonical, so
  // every keystroke gets echoed twice. Make the outer a raw passthrough; the
  // inner pty's line discipline still handles real echo/cooking.
  if (!isWin) {
    try { terminal.setRawMode(true); } catch {}
  }

  // Lazy require avoids the import cost (and a small bun cycle risk) when
  // a PTY is spawned without a session — e.g. legacy callers.
  const sessionOverrides = opts.sessionId
    ? (require('../session/session-env') as typeof import('../session/session-env')).getSessionEnvOverrides(opts.sessionId)
    : {};

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    ...process.env,
    ...(opts.env || {}),
    ...sessionOverrides,
    ...(opts.extraEnv || {}),
  })) {
    if (typeof v === 'string') env[k] = v;
  }
  env.TERM = env.TERM || 'xterm-256color';
  env.COLORTERM = env.COLORTERM || 'truecolor';
  env.LANG = env.LANG || 'en_US.UTF-8';

  // Spawn as a login shell so the user's profile (`/etc/zprofile`,
  // `~/.zprofile`, `~/.profile`, etc.) runs and PATH gets populated with
  // `/usr/local/bin`, `/opt/homebrew/bin`, and entries from `/etc/paths.d/*`.
  // Without this, an app launched from Finder/Dock inherits launchd's minimal
  // PATH and common user tools (bun, node, git from Homebrew) are missing.
  const shellArgs: string[] = [shell];
  if (!isWin) {
    const base = shell.split('/').pop() || '';
    if (base === 'zsh' || base === 'bash' || base === 'sh' || base === 'fish' || base === 'dash') {
      shellArgs.push('-l');
    }
  }

  // Wrap the shell in `script(1)` on macOS/Linux so the spawned process gets
  // a real CONTROLLING TTY (not just a PTY wired to stdin/stdout). Without
  // this, `open("/dev/tty")` fails with ENXIO and `sudo`, `gpg`, ssh's
  // password prompt, etc. break with "a terminal is required". `Bun.Terminal`
  // currently uses `openpty()` but doesn't run `login_tty()` (setsid +
  // TIOCSCTTY) in the child, leaving the slave PTY un-promoted to ctty.
  // `script -q /dev/null …` re-allocates a pty, runs setsid + TIOCSCTTY
  // for us, and discards the typescript log. macOS BSD syntax differs from
  // util-linux — handle both.
  let cmd: string[];
  if (isWin) {
    cmd = shellArgs;
  } else if (process.platform === 'darwin') {
    cmd = ['/usr/bin/script', '-q', '/dev/null', ...shellArgs];
  } else {
    // Linux util-linux script
    cmd = ['/usr/bin/script', '-qfc', shellArgs.join(' '), '/dev/null'];
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd,
      cwd: opts.cwd,
      env,
      terminal,
    });
  } catch (err) {
    log(`[pty] spawn failed: ${(err as Error)?.message || err}`);
    try { terminal.close(); } catch {}
    return null;
  }

  // Subprocess exit (distinct from PTY EOF). Fire exit listeners with the real
  // child exit code; if PTY EOF arrived first, this is a no-op.
  proc.exited.then((code) => {
    if (exited) return;
    exited = true;
    exitCode = typeof code === 'number' ? code : 0;
    for (const cb of exitListeners) cb(exitCode);
    try { terminal.close(); } catch {}
  }).catch(() => {});

  return {
    pid: proc.pid,
    cols: opts.cols,
    rows: opts.rows,
    write(data) {
      if (terminal.closed) return;
      try { terminal.write(data); } catch {}
    },
    resize(cols, rows) {
      if (terminal.closed) return;
      try { terminal.resize(cols, rows); } catch {}
    },
    kill(signal) {
      try { proc.kill(signal as number | undefined); } catch {}
      try { terminal.close(); } catch {}
    },
    onData(cb) { dataListeners.push(cb); },
    onExit(cb) {
      if (exited) { try { cb(exitCode); } catch {} return; }
      exitListeners.push(cb);
    },
  };
}
