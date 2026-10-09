import { stopPairingMaintenance } from '../network/pairings';
import { closeAllTunnels } from '../network/ssh-tunnel';
import { log } from './logger';
import { sessions } from '../session/sessions';
import { stopTelegramBot } from '../integrations/telegram';
import { stopAutomationScheduler } from '../automation/scheduler';
import { closeDatabase } from '../database';
import { freezeTurnTracking } from '../session/interrupted';

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
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    // Before closing providers: their onExit would mark every busy turn as finished.
    freezeTurnTracking();
    stopAutomationScheduler();
    closeAllProviderSessions();
    stopPairingMaintenance();
    closeAllTunnels();
    stopTelegramBot();
    closeDatabase();
  };
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('exit', () => { cleanup(); });
  process.on('SIGUSR2', () => { cleanup(); });
}
