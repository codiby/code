import { log } from './logger';
import { sessions } from '../session/sessions';
import { stopTelegramBot } from '../integrations/telegram';
import { stopAll as stopAllPortless } from '../integrations/portless';

export function closeAllProviderSessions() {
  let closed = 0;
  for (const s of sessions.values()) {
    if (s.providerSession) {
      try { void s.providerSession.close(); } catch {}
      s.providerSession = null;
      closed++;
    }
  }
  if (closed > 0) log(`[shutdown] Closed ${closed} provider sessions`);
}

export function registerShutdownHandlers() {
  const cleanup = () => { closeAllProviderSessions(); stopTelegramBot(); stopAllPortless(); };
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('exit', () => { cleanup(); });
  process.on('SIGUSR2', () => { cleanup(); });
}
