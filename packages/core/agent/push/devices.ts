/**
 * Registered phones (`agent_devices`). One row per FCM registration token —
 * a reinstall or a token refresh produces a new token, and the app passes
 * the old one as `replacesToken` so the stale row goes away instead of
 * failing once and lingering as "disabled".
 *
 * Tokens are bearer-like (anyone holding the Firebase key can push to them),
 * so they never leave this module except to the FCM sender; the API shows a
 * short suffix only.
 */

import { randomUUID } from 'crypto';
import { asc, eq, isNull } from 'drizzle-orm';
import { database } from '../../database';
import { agentDevices, type AgentDeviceRecord } from '../../database/schema';

export type DevicePlatform = 'android' | 'ios';

/** Device as the API and UI see it — no token. */
export interface DeviceView {
  id: string;
  platform: DevicePlatform;
  name: string | null;
  appVersion: string | null;
  createdAt: number;
  lastSeenAt: number;
  disabledAt: number | null;
  lastError: string | null;
  /** Last characters of the token, to tell two installs of one phone apart. */
  tokenHint: string;
}

/**
 * Prefix of `lastError` when FCM itself declared the token dead. Lets a
 * re-registration of the same token re-enable the row, while a device the
 * owner switched off stays off.
 */
export const TOKEN_REJECTED_PREFIX = 'Token rejected by FCM';

const MAX_ERROR_LENGTH = 500;

export function toDeviceView(row: AgentDeviceRecord): DeviceView {
  return {
    id: row.id,
    platform: row.platform === 'ios' ? 'ios' : 'android',
    name: row.name,
    appVersion: row.appVersion,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    disabledAt: row.disabledAt,
    lastError: row.lastError,
    tokenHint: `…${row.token.slice(-6)}`,
  };
}

export function listDevices(): AgentDeviceRecord[] {
  return database.select().from(agentDevices).orderBy(asc(agentDevices.createdAt)).all();
}

export function listEnabledDevices(): AgentDeviceRecord[] {
  return database.select().from(agentDevices).where(isNull(agentDevices.disabledAt)).orderBy(asc(agentDevices.createdAt)).all();
}

export function getDevice(id: string): AgentDeviceRecord | null {
  return database.select().from(agentDevices).where(eq(agentDevices.id, id)).get() ?? null;
}

function getDeviceByToken(token: string): AgentDeviceRecord | null {
  return database.select().from(agentDevices).where(eq(agentDevices.token, token)).get() ?? null;
}

export interface DeviceRegistration {
  platform: DevicePlatform;
  token: string;
  name?: string | null;
  appVersion?: string | null;
  /** The token this install used before a refresh. */
  replacesToken?: string | null;
}

/** Upsert by token. Returns the row and whether it was new. */
export function registerDevice(reg: DeviceRegistration, now = Date.now()): { device: AgentDeviceRecord; created: boolean } {
  return database.transaction(tx => {
    let inherited: Pick<AgentDeviceRecord, 'name' | 'disabledAt'> | null = null;
    if (reg.replacesToken && reg.replacesToken !== reg.token) {
      const old = tx.select().from(agentDevices).where(eq(agentDevices.token, reg.replacesToken)).get();
      if (old) {
        // Keep what the owner chose for this phone (its name, switched off)
        // across the token change.
        inherited = { name: old.name, disabledAt: old.lastError?.startsWith(TOKEN_REJECTED_PREFIX) ? null : old.disabledAt };
        tx.delete(agentDevices).where(eq(agentDevices.id, old.id)).run();
      }
    }

    const existing = tx.select().from(agentDevices).where(eq(agentDevices.token, reg.token)).get();
    if (existing) {
      const revived = existing.disabledAt !== null && !!existing.lastError?.startsWith(TOKEN_REJECTED_PREFIX);
      tx.update(agentDevices).set({
        platform: reg.platform,
        // The app sends its default name on every launch; a rename from the
        // Devices view must survive that.
        name: existing.name ?? reg.name ?? null,
        appVersion: reg.appVersion ?? existing.appVersion,
        lastSeenAt: now,
        ...(revived ? { disabledAt: null, lastError: null } : {}),
      }).where(eq(agentDevices.id, existing.id)).run();
      return { device: tx.select().from(agentDevices).where(eq(agentDevices.id, existing.id)).get()!, created: false };
    }

    const row: AgentDeviceRecord = {
      id: randomUUID(),
      platform: reg.platform,
      token: reg.token,
      name: inherited?.name ?? reg.name ?? null,
      appVersion: reg.appVersion ?? null,
      createdAt: now,
      lastSeenAt: now,
      disabledAt: inherited?.disabledAt ?? null,
      lastError: null,
    };
    tx.insert(agentDevices).values(row).run();
    return { device: row, created: true };
  });
}

export function updateDevice(id: string, patch: { name?: string | null; disabled?: boolean }, now = Date.now()): AgentDeviceRecord | null {
  const current = getDevice(id);
  if (!current) return null;
  const set: Partial<AgentDeviceRecord> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.disabled === true && current.disabledAt === null) set.disabledAt = now;
  // Switching a device back on is the owner saying "try again": forget why it failed.
  if (patch.disabled === false && current.disabledAt !== null) {
    set.disabledAt = null;
    set.lastError = null;
  }
  if (Object.keys(set).length) database.update(agentDevices).set(set).where(eq(agentDevices.id, id)).run();
  return getDevice(id);
}

export function deleteDevice(id: string): boolean {
  if (!getDevice(id)) return false;
  database.delete(agentDevices).where(eq(agentDevices.id, id)).run();
  return true;
}

/** FCM says the token is gone (app uninstalled, data cleared, token rotated). */
export function disableDeviceForToken(id: string, reason: string, now = Date.now()): void {
  database.update(agentDevices).set({
    disabledAt: now,
    lastError: `${TOKEN_REJECTED_PREFIX}: ${reason}`.slice(0, MAX_ERROR_LENGTH),
  }).where(eq(agentDevices.id, id)).run();
}

/** A failure worth showing on the device row without switching it off. */
export function recordDeviceError(id: string, message: string): void {
  database.update(agentDevices).set({ lastError: message.slice(0, MAX_ERROR_LENGTH) }).where(eq(agentDevices.id, id)).run();
}

export function clearDeviceError(id: string): void {
  database.update(agentDevices).set({ lastError: null }).where(eq(agentDevices.id, id)).run();
}

/** Tests only. */
export function _deviceByToken(token: string): AgentDeviceRecord | null {
  return getDeviceByToken(token);
}

/** Tests only. */
export function _deleteAllDevices(): void {
  database.delete(agentDevices).run();
}
