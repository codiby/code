/**
 * `/agent/push/*` — all authenticated with the bridge's bearer token (the
 * phone already holds it for the host). Approving from a notification goes
 * through the policy area's `POST /agent/approvals/:requestId`, not here.
 */

import { HttpError, errorJson, json, readBody } from '../http';
import { registerRoutes } from '../registry';
import { deleteDevice, getDevice, listDevices, listEnabledDevices, registerDevice, toDeviceView, updateDevice, type DevicePlatform } from './devices';
import { deleteServiceAccount, loadServiceAccount, parseServiceAccount, saveServiceAccount, serviceAccountInfo, ServiceAccountError } from './serviceAccount';
import { pushToDevices, resetPushClient } from './sender';
import { loadPushSettings, patchPushSettings } from './settings';

const MAX_TOKEN_LENGTH = 4096;
const MAX_NAME_LENGTH = 80;
const MAX_VERSION_LENGTH = 40;

type Body = Record<string, unknown>;

function optionalText(body: Body, key: string, max: number): string | null | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw new HttpError(400, `"${key}" must be a string`);
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (t.length > max) throw new HttpError(400, `"${key}" is longer than ${max} characters`);
  return t || null;
}

/** FCM registration tokens are opaque, but never contain whitespace or control characters. */
function parseToken(v: unknown, key: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `"${key}" is required`);
  const token = v.trim();
  if (token.length < 20 || token.length > MAX_TOKEN_LENGTH || !/^[\x21-\x7e]+$/.test(token)) {
    throw new HttpError(400, `"${key}" is not an FCM registration token`);
  }
  return token;
}

function parsePlatform(v: unknown): DevicePlatform {
  if (v !== 'android' && v !== 'ios') throw new HttpError(400, '"platform" must be "android" or "ios"');
  return v;
}

function statusBody() {
  const sa = loadServiceAccount();
  const settings = loadPushSettings();
  const all = listDevices();
  return {
    configured: sa !== null,
    projectId: sa?.projectId ?? null,
    clientEmail: sa?.clientEmail ?? null,
    /** Enabled phones — the ones a push would reach. */
    devices: all.filter(d => d.disabledAt === null).length,
    totalDevices: all.length,
    lastError: settings.lastError?.message ?? null,
    lastErrorAt: settings.lastError?.at ?? null,
    lastSuccessAt: settings.lastSuccessAt,
    settings: {
      approvalsForAllSessions: settings.approvalsForAllSessions,
      notifications: settings.notifications,
    },
  };
}

registerRoutes([
  {
    method: 'GET',
    path: '/agent/push/status',
    handler: () => json(statusBody()),
  },
  {
    method: 'PUT',
    path: '/agent/push/settings',
    handler: async (req) => {
      const body = await readBody<Body>(req);
      const patch: { approvalsForAllSessions?: boolean; notifications?: boolean } = {};
      for (const key of ['approvalsForAllSessions', 'notifications'] as const) {
        if (body[key] === undefined) continue;
        if (typeof body[key] !== 'boolean') throw new HttpError(400, `"${key}" must be true or false`);
        patch[key] = body[key] as boolean;
      }
      patchPushSettings(patch);
      return json(statusBody());
    },
  },
  {
    method: 'PUT',
    path: '/agent/push/firebase',
    handler: async (req) => {
      const body = await readBody<Body>(req);
      if (body.serviceAccount === undefined || body.serviceAccount === null) {
        throw new HttpError(400, '"serviceAccount" is required (the JSON key file, as an object or as text)');
      }
      let sa;
      try {
        sa = parseServiceAccount(body.serviceAccount);
      } catch (err) {
        if (err instanceof ServiceAccountError) throw new HttpError(400, err.message);
        throw err;
      }
      saveServiceAccount(sa);
      resetPushClient();
      // A new key deserves a fresh verdict; the old error was about the old key.
      patchPushSettings({ lastError: null });
      return json({ ok: true, ...serviceAccountInfo(sa) });
    },
  },
  {
    method: 'DELETE',
    path: '/agent/push/firebase',
    handler: () => {
      const removed = deleteServiceAccount();
      resetPushClient();
      patchPushSettings({ lastError: null, lastSuccessAt: null });
      return json({ ok: true, removed });
    },
  },
  {
    method: 'GET',
    path: '/agent/push/devices',
    handler: () => json({ devices: listDevices().map(toDeviceView) }),
  },
  {
    method: 'POST',
    path: '/agent/push/devices',
    handler: async (req) => {
      const body = await readBody<Body>(req);
      const platform = parsePlatform(body.platform);
      const token = parseToken(body.token, 'token');
      const replacesToken = body.replacesToken === undefined || body.replacesToken === null || body.replacesToken === ''
        ? null
        : parseToken(body.replacesToken, 'replacesToken');
      const { device, created } = registerDevice({
        platform,
        token,
        name: optionalText(body, 'name', MAX_NAME_LENGTH),
        appVersion: optionalText(body, 'appVersion', MAX_VERSION_LENGTH),
        replacesToken,
      });
      return json({ ok: true, created, device: toDeviceView(device), configured: loadServiceAccount() !== null }, created ? 201 : 200);
    },
  },
  {
    method: 'PATCH',
    path: '/agent/push/devices/:id',
    handler: async (req, params) => {
      const body = await readBody<Body>(req);
      const patch: { name?: string | null; disabled?: boolean } = {};
      const name = optionalText(body, 'name', MAX_NAME_LENGTH);
      if (name !== undefined) patch.name = name;
      if (body.disabled !== undefined) {
        if (typeof body.disabled !== 'boolean') throw new HttpError(400, '"disabled" must be true or false');
        patch.disabled = body.disabled;
      }
      if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to update (send "name" and/or "disabled")');
      const device = updateDevice(params.id!, patch);
      if (!device) return errorJson('Device not found', 404);
      return json({ ok: true, device: toDeviceView(device) });
    },
  },
  {
    method: 'DELETE',
    path: '/agent/push/devices/:id',
    handler: (_req, params) => {
      if (!deleteDevice(params.id!)) return errorJson('Device not found', 404);
      return json({ ok: true });
    },
  },
  {
    method: 'POST',
    path: '/agent/push/test',
    handler: async (req) => {
      const body = await readBody<Body>(req);
      if (!loadServiceAccount()) return errorJson('Firebase is not configured — upload the service account key first', 409);
      let deviceIds: string[] | undefined;
      if (body.deviceId !== undefined && body.deviceId !== null) {
        if (typeof body.deviceId !== 'string' || !getDevice(body.deviceId)) return errorJson('Device not found', 404);
        deviceIds = [body.deviceId];
      } else if (!listEnabledDevices().length) {
        return errorJson('No enabled devices — open the Codiby app on your phone to register it', 409);
      }
      const outcome = await pushToDevices({
        type: 'notify',
        title: 'Codiby test',
        text: 'Push notifications are working.',
        priority: 'normal',
        sessionId: '',
        sessionName: '',
        quiet: false,
      }, { deviceIds });
      const results = outcome.configured ? outcome.results : [];
      return json({ ok: results.length > 0 && results.every(r => r.ok), results });
    },
  },
]);
