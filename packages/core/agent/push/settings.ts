/**
 * Push settings — `~/.codiby/agent/push.json`.
 *
 * What gets pushed and the sender's last outcome. The Firebase credential
 * lives in the vault, never here, and device tokens live in `agent_devices`.
 * The last error is persisted so the Devices view still explains a broken
 * setup after a restart, when no push has been attempted yet.
 */

import { agentDataDir, createJsonStore } from '../store';

export interface PushSettings {
  /**
   * Push permission requests from every session on this host. Off = only the
   * agent's own requests reach the phone; coding sessions still ask in the UI.
   */
  approvalsForAllSessions: boolean;
  /** Push `notify_user` / reminders. Approvals are governed separately. */
  notifications: boolean;
  /** Last failure that was not one device's dead token (bad key, API off…). */
  lastError: { message: string; at: number } | null;
  lastSuccessAt: number | null;
}

export const DEFAULT_PUSH_SETTINGS: PushSettings = {
  approvalsForAllSessions: true,
  notifications: true,
  lastError: null,
  lastSuccessAt: null,
};

const MAX_ERROR_LENGTH = 500;

export function normalizePushSettings(raw: unknown): PushSettings {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const err = r.lastError as Record<string, unknown> | null | undefined;
  const lastError = err && typeof err === 'object' && typeof err.message === 'string' && typeof err.at === 'number'
    ? { message: err.message.slice(0, MAX_ERROR_LENGTH), at: err.at }
    : null;
  return {
    approvalsForAllSessions: typeof r.approvalsForAllSessions === 'boolean' ? r.approvalsForAllSessions : DEFAULT_PUSH_SETTINGS.approvalsForAllSessions,
    notifications: typeof r.notifications === 'boolean' ? r.notifications : DEFAULT_PUSH_SETTINGS.notifications,
    lastError,
    lastSuccessAt: typeof r.lastSuccessAt === 'number' ? r.lastSuccessAt : null,
  };
}

const store = createJsonStore<PushSettings>({ file: agentDataDir('push.json'), normalize: normalizePushSettings });

export function loadPushSettings(): PushSettings {
  return store.get();
}

export function patchPushSettings(patch: Partial<PushSettings>): PushSettings {
  return store.update(current => ({ ...current, ...patch }));
}

export function recordPushError(message: string, at = Date.now()): void {
  patchPushSettings({ lastError: { message: message.slice(0, MAX_ERROR_LENGTH), at } });
}

/** A delivered push proves the setup works, so any old setup error is stale. */
export function recordPushSuccess(at = Date.now()): void {
  const current = store.get();
  // Avoid rewriting the file on every push of a burst.
  if (current.lastError === null && current.lastSuccessAt !== null && at - current.lastSuccessAt < 60_000) return;
  patchPushSettings({ lastError: null, lastSuccessAt: at });
}

/** Tests only. */
export function _reloadPushSettings(): PushSettings {
  return store.reload();
}
