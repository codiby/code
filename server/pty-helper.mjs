// PTY helper — must be run under Node (not Bun). Bun can spawn this and
// communicate via stdio, but Bun can't load node-pty's native binding
// directly. This helper owns the PTY and proxies it via line-delimited JSON:
//
//   stdin  (Bun -> helper):   { type: 'write',  data: string }
//                             { type: 'resize', cols: number, rows: number }
//                             { type: 'kill',   signal?: string }
//
//   stdout (helper -> Bun):   { type: 'ready',  pid: number }
//                             { type: 'data',   data: string }
//                             { type: 'exit',   code: number }
//
// CLI:  node pty-helper.mjs --shell /bin/zsh --cwd /path --cols 120 --rows 30

import * as pty from 'node-pty';
import * as readline from 'readline';

const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.findIndex((a) => a === '--' + name);
  return i >= 0 ? argv[i + 1] : def;
};

const shell = getArg('shell', process.env.SHELL || '/bin/bash');
const cwd = getArg('cwd', process.env.HOME || '/');
const cols = parseInt(getArg('cols', '80'), 10) || 80;
const rows = parseInt(getArg('rows', '24'), 10) || 24;

let p;
try {
  p = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'en_US.UTF-8',
    },
  });
} catch (err) {
  process.stderr.write(`[pty-helper] spawn failed: ${err?.message || err}\n`);
  process.stdout.write(JSON.stringify({ type: 'exit', code: 127 }) + '\n');
  process.exit(1);
}

const send = (obj) => {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch {}
};

send({ type: 'ready', pid: p.pid });

p.onData((data) => send({ type: 'data', data }));
p.onExit(({ exitCode }) => {
  send({ type: 'exit', code: exitCode ?? 0 });
  setTimeout(() => process.exit(0), 30);
});

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'write' && typeof msg.data === 'string') {
    try { p.write(msg.data); } catch {}
  } else if (msg.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
    try { p.resize(msg.cols, msg.rows); } catch {}
  } else if (msg.type === 'kill') {
    try { p.kill(msg.signal || 'SIGHUP'); } catch {}
  }
});
rl.on('close', () => { try { p.kill('SIGHUP'); } catch {} });

process.on('SIGTERM', () => { try { p.kill('SIGTERM'); } catch {}; process.exit(0); });
process.on('SIGINT',  () => { try { p.kill('SIGINT'); } catch {}; process.exit(0); });
