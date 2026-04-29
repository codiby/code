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

import { log } from './logger';

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

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...(opts.env || {}) })) {
    if (typeof v === 'string') env[k] = v;
  }
  env.TERM = env.TERM || 'xterm-256color';
  env.COLORTERM = env.COLORTERM || 'truecolor';
  env.LANG = env.LANG || 'en_US.UTF-8';

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd: [shell],
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
