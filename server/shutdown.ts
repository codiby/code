import { log } from './logger';
import { sessions } from './sessions';

export function killAllClaudeProcesses() {
  let killed = 0;
  for (const s of sessions.values()) {
    if (s.process && !s.process.killed) {
      try { s.process.kill('SIGTERM'); } catch {}
      killed++;
    }
  }
  if (killed > 0) log(`[shutdown] Killed ${killed} Claude processes`);
}

export function registerShutdownHandlers() {
  process.on('SIGINT', () => { killAllClaudeProcesses(); process.exit(0); });
  process.on('SIGTERM', () => { killAllClaudeProcesses(); process.exit(0); });
  process.on('exit', () => { killAllClaudeProcesses(); });
  process.on('SIGUSR2', () => { killAllClaudeProcesses(); });
}
