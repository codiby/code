import { spawn } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { log, logError } from './logger';
import { CLAUDE_BIN } from './config';
import { sessions, broadcast } from './sessions';
import type { Session } from './types';

export function spawnClaude(session: Session, port: number, resumeSessionId?: string) {
  const sdkUrl = `ws://localhost:${port}/v2/session_ingress/ws/${session.id}`;
  const args = [
    '-p', '--sdk-url', sdkUrl,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
  ];

  if (resumeSessionId) {
    args.push('--resume', resumeSessionId, '--replay-user-messages');
  }

  if (session.model) {
    args.push('--model', session.model);
  }

  // Write per-session MCP config file with session ID in header
  const mcpDir = join(homedir(), '.claude', 'ui-mcp-configs');
  mkdirSync(mcpDir, { recursive: true });
  const mcpConfigPath = join(mcpDir, `${session.id}.json`);
  writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: {
      'claude-code-ui': {
        type: 'sse',
        url: `http://localhost:${port}/mcp`,
        headers: { 'x-session-id': session.id },
      },
    },
  }, null, 2));
  args.push('--mcp-config', mcpConfigPath);

  const sid = session.id.slice(0, 8);
  const spawnStart = Date.now();
  log(`[${sid}] Spawning: ${CLAUDE_BIN} ${args.join(' ')}`);
  log(`[${sid}] CWD: ${session.cwd}`);

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: session.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'dumb' },
  });

  session.process = proc;
  session.status = 'starting';
  session.ready = false;

  log(`[${sid}] Process spawned, PID=${proc.pid}, waiting for Claude CLI to connect via WS...`);

  proc.stdout?.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    if (text) log(`[${sid}] stdout (${Date.now() - spawnStart}ms): ${text.slice(0, 200)}`);
  });

  proc.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) log(`[${sid}] stderr (${Date.now() - spawnStart}ms): ${msg.slice(0, 200)}`);
  });

  proc.on('exit', (code) => {
    log(`[${sid}] Claude exited with code ${code} after ${Date.now() - spawnStart}ms`);
    const s = sessions.get(session.id);
    if (s) {
      s.status = 'stopped';
      s.ready = false;
      s.process = null;
      broadcast(s, JSON.stringify({ type: 'bridge', status: 'claude_exited', code }) + '\n');
    }
  });

  proc.on('error', (err) => {
    logError(`[${sid}] Failed to spawn Claude: ${err.message}`);
  });
}
