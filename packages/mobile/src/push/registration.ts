/**
 * Tell each agent host this phone's FCM token. Only hosts whose agent is on
 * get it — the agent host is the one that pushes; the others would just
 * collect devices they never use.
 */

import { Platform } from 'react-native';

import { fetchAgentStatus, registerPushDevice } from '../api/agent';
import type { ServerEntry } from '../config/servers';
import {
  loadRegistrations,
  removeRegistration,
  saveRegistration,
} from './hosts';
import { setHostPushState, type HostPushState } from './state';

export interface LiveRoute {
  readonly server: ServerEntry;
  readonly baseUrl: string;
  readonly token: string;
}

/** What the Devices list on the desktop shows until the owner renames it. */
export function deviceName(): string {
  if (Platform.OS === 'ios') {
    return Platform.isPad ? 'iPad' : 'iPhone';
  }
  const constants = Platform.constants as { Brand?: string; Model?: string };
  const model = constants.Model?.trim() ?? '';
  const brand = constants.Brand?.trim() ?? '';
  if (model.length === 0) {
    return 'Android phone';
  }
  // "Pixel 9" already says it all; "SM-S921B" reads better as "samsung SM-S921B".
  return brand.length > 0 &&
    !model.toLowerCase().startsWith(brand.toLowerCase())
    ? `${brand} ${model}`
    : model;
}

export async function registerWithHost(
  route: LiveRoute,
  fcmToken: string,
  now = Date.now(),
): Promise<HostPushState> {
  const { server, baseUrl, token } = route;
  setHostPushState(server.id, { state: 'registering', at: now });
  let result: HostPushState;
  try {
    const status = await fetchAgentStatus(baseUrl, token);
    if (!status.enabled) {
      await removeRegistration(server.id);
      result = { state: 'agent-off', at: now };
    } else {
      const previous = (await loadRegistrations())[server.id];
      const registration = await registerPushDevice(baseUrl, token, {
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        token: fcmToken,
        name: deviceName(),
        replacesToken:
          previous !== undefined && previous.token !== fcmToken
            ? previous.token
            : null,
      });
      await saveRegistration({
        serverId: server.id,
        host: status.host,
        deviceId: registration.deviceId,
        token: fcmToken,
        configured: registration.configured,
        at: now,
      });
      result = {
        state: 'registered',
        deviceId: registration.deviceId,
        configured: registration.configured,
        at: now,
      };
    }
  } catch (error) {
    result = {
      state: 'error',
      message: error instanceof Error ? error.message : String(error),
      at: now,
    };
  }
  setHostPushState(server.id, result);
  return result;
}
