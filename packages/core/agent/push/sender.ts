/**
 * Fan a push out to registered phones and act on what FCM says back: a dead
 * token switches its device off, a setup problem is recorded once for the
 * Devices view (every phone would fail the same way, so none is blamed), and
 * a success clears both.
 */

import { log, logError } from '../../lib/logger';
import { agentHostLabel } from '../config';
import type { AgentDeviceRecord } from '../../database/schema';
import { clearDeviceError, disableDeviceForToken, getDevice, listEnabledDevices, recordDeviceError } from './devices';
import { createFcmClient, type FcmClient } from './fcm';
import { buildFcmMessage, type PushPayload } from './messages';
import { loadServiceAccount } from './serviceAccount';
import { recordPushError, recordPushSuccess } from './settings';

export interface DeliveryResult {
  deviceId: string;
  name: string | null;
  ok: boolean;
  error?: string;
  /** The device was switched off because FCM rejected its token. */
  disabled?: boolean;
}

export type PushOutcome =
  | { configured: false; results: [] }
  | { configured: true; results: DeliveryResult[] };

let fcm: FcmClient = createFcmClient();
let now: () => number = Date.now;

/** Tests only: inject a client with a fake fetch, and a clock. */
export function _setPushClientForTest(client: FcmClient | null, clock?: () => number): void {
  fcm = client ?? createFcmClient();
  now = clock ?? Date.now;
}

/** The credential changed or went away: never reuse its access token. */
export function resetPushClient(): void {
  fcm.reset();
}

/** True when a push could go out right now (credential + at least one enabled phone). */
export function canPush(): boolean {
  return loadServiceAccount() !== null && listEnabledDevices().length > 0;
}

async function deliver(device: AgentDeviceRecord, payload: PushPayload): Promise<DeliveryResult> {
  const sa = loadServiceAccount();
  if (!sa) return { deviceId: device.id, name: device.name, ok: false, error: 'Firebase is not configured' };
  const message = buildFcmMessage(device.token, payload, { host: agentHostLabel(), now: now() });
  const outcome = await fcm.send(sa, message);
  const base = { deviceId: device.id, name: device.name };

  if (outcome.ok) {
    if (device.lastError) clearDeviceError(device.id);
    recordPushSuccess(now());
    return { ...base, ok: true };
  }

  const reason = outcome.errorCode ? `${outcome.errorCode}: ${outcome.message}` : outcome.message;
  switch (outcome.kind) {
    case 'token':
      disableDeviceForToken(device.id, reason, now());
      log(`[push] Disabled ${device.name || device.id}: FCM rejected its token (${outcome.errorCode ?? outcome.status})`);
      return { ...base, ok: false, error: reason, disabled: true };
    case 'config':
      recordPushError(reason, now());
      return { ...base, ok: false, error: reason };
    case 'payload':
      // Our bug, not the phone's: keep the device and make it loud.
      logError(`[push] FCM rejected a ${payload.type} message: ${reason}`);
      recordPushError(`FCM rejected the message: ${reason}`, now());
      return { ...base, ok: false, error: reason };
    case 'transient':
      recordDeviceError(device.id, reason);
      return { ...base, ok: false, error: reason };
  }
}

/**
 * Send to every enabled device, or to `deviceIds` (a test push may target a
 * device the owner switched off). Never throws: failures come back per device.
 */
export async function pushToDevices(payload: PushPayload, opts: { deviceIds?: string[] } = {}): Promise<PushOutcome> {
  if (!loadServiceAccount()) return { configured: false, results: [] };
  const devices = opts.deviceIds
    ? opts.deviceIds.map(id => getDevice(id)).filter((d): d is AgentDeviceRecord => d !== null)
    : listEnabledDevices();
  const results = await Promise.all(devices.map(async device => {
    try {
      return await deliver(device, payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`[push] Delivery to ${device.id} threw: ${message}`);
      return { deviceId: device.id, name: device.name, ok: false, error: message };
    }
  }));
  return { configured: true, results };
}
