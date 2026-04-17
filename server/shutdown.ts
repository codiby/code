import { log } from './logger';
import { sessions } from './sessions';
import { stopTelegramBot } from './telegram';

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
  const cleanup = () => { killAllClaudeProcesses(); stopTelegramBot(); };
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('exit', () => { cleanup(); });
  process.on('SIGUSR2', () => { cleanup(); });
}
