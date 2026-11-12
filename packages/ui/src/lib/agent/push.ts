/**
 * Typed client for `/agent/push/*` (packages/core/agent/push/routes.ts):
 * the Firebase credential, registered phones and the test push.
 */

import type { AgentApi } from './api';

export interface PushSettings {
  /** Push permission requests from every session, not only the agent's. */
  approvalsForAllSessions: boolean;
  /** Push notify_user / reminders. */
  notifications: boolean;
}

export interface PushStatus {
  configured: boolean;
  projectId: string | null;
  clientEmail: string | null;
  /** Enabled phones. */
  devices: number;
  totalDevices: number;
  lastError: string | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  settings: PushSettings;
}

export interface PushDevice {
  id: string;
  platform: 'android' | 'ios';
  name: string | null;
  appVersion: string | null;
  createdAt: number;
  lastSeenAt: number;
  disabledAt: number | null;
  lastError: string | null;
  /** Last characters of the FCM token. */
  tokenHint: string;
}

export interface PushDeliveryResult {
  deviceId: string;
  name: string | null;
  ok: boolean;
  error?: string;
  disabled?: boolean;
}

export const agentPush = {
  status: (api: AgentApi) => api.get<PushStatus>('/agent/push/status'),
  saveSettings: (api: AgentApi, patch: Partial<PushSettings>) => api.send<PushStatus>('PUT', '/agent/push/settings', patch),
  /** `serviceAccount` is the JSON key file as text or parsed; the server never sends it back. */
  uploadServiceAccount: (api: AgentApi, serviceAccount: string | object) =>
    api.send<{ ok: true; projectId: string; clientEmail: string; privateKeyId: string | null }>('PUT', '/agent/push/firebase', { serviceAccount }),
  removeServiceAccount: (api: AgentApi) => api.send<{ ok: true; removed: boolean }>('DELETE', '/agent/push/firebase'),
  devices: (api: AgentApi) => api.get<{ devices: PushDevice[] }>('/agent/push/devices'),
  updateDevice: (api: AgentApi, id: string, patch: { name?: string | null; disabled?: boolean }) =>
    api.send<{ ok: true; device: PushDevice }>('PATCH', `/agent/push/devices/${encodeURIComponent(id)}`, patch),
  deleteDevice: (api: AgentApi, id: string) => api.send<{ ok: true }>('DELETE', `/agent/push/devices/${encodeURIComponent(id)}`),
  test: (api: AgentApi, deviceId?: string) =>
    api.send<{ ok: boolean; results: PushDeliveryResult[] }>('POST', '/agent/push/test', deviceId ? { deviceId } : {}),
};
