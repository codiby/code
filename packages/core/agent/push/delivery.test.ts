import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'crypto';
import { readFileSync } from 'fs';
import { loadAgentConfig, saveAgentConfig } from '../config';
import { handleAgentRoute } from '../routes';
import { emitApprovalRequested, emitApprovalResolved, emitOwnerNotification } from '../registry';
import { AGENT_SESSION_ID } from '../session';
import { agentDataDir } from '../store';
import { _deleteAllDevices, _deviceByToken, registerDevice, TOKEN_REJECTED_PREFIX } from './devices';
import { createFcmClient } from './fcm';
import { _pendingPushes, _setApprovalLookupForTest } from './hooks';
import { TOKEN_URL, type FetchFn } from './oauth';
import { _resetServiceAccountCache, deleteServiceAccount } from './serviceAccount';
import { _setPushClientForTest, pushToDevices } from './sender';
import { _reloadPushSettings, loadPushSettings, patchPushSettings } from './settings';
import './index';

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const KEY_FILE = {
  type: 'service_account',
  project_id: 'codiby-push-test',
  private_key_id: 'kid-1',
  private_key: PEM,
  client_email: 'sender@codiby-push-test.iam.gserviceaccount.com',
};

const TOKEN_A = 'fcm-token-android-0000000000000000:APA91b';
const TOKEN_B = 'fcm-token-ios-11111111111111111111:APA91b';

/** Fake Google: token endpoint + FCM, answering per registration token. */
const sent: { token: string; message: any }[] = [];
let answerFor: (token: string) => Response | null = () => null;
const fakeFetch: FetchFn = async (url, init) => {
  if (url === TOKEN_URL) return Response.json({ access_token: 'ya29.fake', expires_in: 3600 });
  if (!url.startsWith('https://fcm.googleapis.com/')) throw new Error(`unexpected fetch ${url}`);
  const { message } = JSON.parse(String(init?.body));
  sent.push({ token: message.token, message });
  return answerFor(message.token) ?? Response.json({ name: `projects/codiby-push-test/messages/${sent.length}` });
};

const unregistered = () => Response.json({
  error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] },
}, { status: 404 });

async function call(method: string, path: string, body?: unknown, authenticated = true) {
  const url = new URL(`http://127.0.0.1${path}`);
  const req = new Request(url, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const res = await handleAgentRoute(req, url, authenticated);
  if (!res) throw new Error(`no route for ${path}`);
  const text = await res.text();
  return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}

async function configure() {
  const res = await call('PUT', '/agent/push/firebase', { serviceAccount: JSON.stringify(KEY_FILE) });
  expect(res.status).toBe(200);
}

const originalConfig = loadAgentConfig();

beforeEach(() => {
  sent.length = 0;
  answerFor = () => null;
  _deleteAllDevices();
  deleteServiceAccount();
  _resetServiceAccountCache();
  patchPushSettings({ approvalsForAllSessions: true, notifications: true, lastError: null, lastSuccessAt: null });
  _setPushClientForTest(createFcmClient({ fetch: fakeFetch, sleep: async () => {} }));
  saveAgentConfig({ ...loadAgentConfig(), enabled: true });
});

afterAll(() => {
  _deleteAllDevices();
  deleteServiceAccount();
  _setPushClientForTest(null);
  _setApprovalLookupForTest(null);
  saveAgentConfig(originalConfig);
});

describe('firebase credential routes', () => {
  test('stores the key in the vault and never echoes it', async () => {
    const res = await call('PUT', '/agent/push/firebase', { serviceAccount: KEY_FILE });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, projectId: 'codiby-push-test', clientEmail: KEY_FILE.client_email, privateKeyId: 'kid-1' });
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE KEY');
    expect(readFileSync(agentDataDir('vault.json'), 'utf-8')).not.toContain('PRIVATE KEY');

    const status = await call('GET', '/agent/push/status');
    expect(status.body).toMatchObject({ configured: true, projectId: 'codiby-push-test', devices: 0, lastError: null });
    expect(JSON.stringify(status.body)).not.toContain('PRIVATE KEY');

    expect((await call('DELETE', '/agent/push/firebase')).body).toEqual({ ok: true, removed: true });
    expect((await call('GET', '/agent/push/status')).body.configured).toBe(false);
  });

  test('rejects bad keys with a readable 400', async () => {
    expect((await call('PUT', '/agent/push/firebase', {})).status).toBe(400);
    const wrongType = await call('PUT', '/agent/push/firebase', { serviceAccount: { ...KEY_FILE, type: 'authorized_user' } });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error).toContain('service_account');
    expect((await call('PUT', '/agent/push/firebase', { serviceAccount: '{nope' })).status).toBe(400);
    expect((await call('PUT', '/agent/push/firebase', 'not json')).status).toBe(400);
  });

  test('requires the bridge token', async () => {
    expect((await call('GET', '/agent/push/status', undefined, false)).status).toBe(401);
    expect((await call('POST', '/agent/push/devices', { platform: 'android', token: TOKEN_A }, false)).status).toBe(401);
  });
});

describe('device routes', () => {
  test('register is an upsert by token and never returns the token', async () => {
    const first = await call('POST', '/agent/push/devices', { platform: 'android', token: TOKEN_A, name: 'Pixel', appVersion: '1.0.3' });
    expect(first.status).toBe(201);
    expect(first.body.device).toMatchObject({ platform: 'android', name: 'Pixel', appVersion: '1.0.3', disabledAt: null, tokenHint: '…APA91b' });
    expect(JSON.stringify(first.body)).not.toContain(TOKEN_A);

    // Renamed in the Devices view, then the app re-registers with its default name.
    await call('PATCH', `/agent/push/devices/${first.body.device.id}`, { name: 'Work phone' });
    const again = await call('POST', '/agent/push/devices', { platform: 'android', token: TOKEN_A, name: 'Pixel', appVersion: '1.0.4' });
    expect(again.status).toBe(200);
    expect(again.body.device).toMatchObject({ id: first.body.device.id, name: 'Work phone', appVersion: '1.0.4' });

    const list = await call('GET', '/agent/push/devices');
    expect(list.body.devices).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(TOKEN_A);
  });

  test('a refreshed token replaces the old row and keeps the owner’s choices', async () => {
    const first = await call('POST', '/agent/push/devices', { platform: 'ios', token: TOKEN_A, name: 'iPhone' });
    await call('PATCH', `/agent/push/devices/${first.body.device.id}`, { name: 'My iPhone', disabled: true });
    const next = await call('POST', '/agent/push/devices', { platform: 'ios', token: TOKEN_B, name: 'iPhone', replacesToken: TOKEN_A });
    expect(next.status).toBe(201);
    expect(next.body.device.name).toBe('My iPhone');
    expect(next.body.device.disabledAt).not.toBeNull();
    expect(_deviceByToken(TOKEN_A)).toBeNull();
  });

  test('validates input', async () => {
    const bad = [
      { token: TOKEN_A },
      { platform: 'web', token: TOKEN_A },
      { platform: 'android' },
      { platform: 'android', token: 'short' },
      { platform: 'android', token: `${TOKEN_A} with spaces` },
      { platform: 'android', token: TOKEN_A, name: 42 },
      { platform: 'android', token: TOKEN_A, name: 'x'.repeat(81) },
      { platform: 'android', token: TOKEN_A, replacesToken: 'bad token' },
    ];
    for (const body of bad) expect((await call('POST', '/agent/push/devices', body)).status).toBe(400);
    expect((await call('PATCH', '/agent/push/devices/nope', { name: 'x' })).status).toBe(404);
    const { body } = await call('POST', '/agent/push/devices', { platform: 'android', token: TOKEN_A });
    expect((await call('PATCH', `/agent/push/devices/${body.device.id}`, {})).status).toBe(400);
    expect((await call('PATCH', `/agent/push/devices/${body.device.id}`, { disabled: 'yes' })).status).toBe(400);
    expect((await call('DELETE', `/agent/push/devices/${body.device.id}`)).status).toBe(200);
    expect((await call('DELETE', `/agent/push/devices/${body.device.id}`)).status).toBe(404);
  });

  test('settings route validates and persists', async () => {
    expect((await call('PUT', '/agent/push/settings', { approvalsForAllSessions: 'no' })).status).toBe(400);
    const res = await call('PUT', '/agent/push/settings', { approvalsForAllSessions: false });
    expect(res.body.settings).toEqual({ approvalsForAllSessions: false, notifications: true });
    expect(_reloadPushSettings().approvalsForAllSessions).toBe(false);
  });
});

describe('test push', () => {
  test('needs Firebase and a device', async () => {
    expect((await call('POST', '/agent/push/test')).status).toBe(409);
    await configure();
    expect((await call('POST', '/agent/push/test')).status).toBe(409);
    expect((await call('POST', '/agent/push/test', { deviceId: 'missing' })).status).toBe(404);
  });

  test('UNREGISTERED disables only that device', async () => {
    await configure();
    const a = registerDevice({ platform: 'android', token: TOKEN_A, name: 'Pixel' }).device;
    const b = registerDevice({ platform: 'ios', token: TOKEN_B, name: 'iPhone' }).device;
    answerFor = token => (token === TOKEN_A ? unregistered() : null);

    const res = await call('POST', '/agent/push/test');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    const byId = Object.fromEntries(res.body.results.map((r: any) => [r.deviceId, r]));
    expect(byId[a.id]).toMatchObject({ ok: false, disabled: true });
    expect(byId[b.id]).toMatchObject({ ok: true });

    const devices = (await call('GET', '/agent/push/devices')).body.devices;
    const pixel = devices.find((d: any) => d.id === a.id);
    expect(pixel.disabledAt).not.toBeNull();
    expect(pixel.lastError.startsWith(TOKEN_REJECTED_PREFIX)).toBe(true);
    expect(devices.find((d: any) => d.id === b.id).disabledAt).toBeNull();
    // A dead token is not a setup problem.
    expect(loadPushSettings().lastError).toBeNull();
    expect((await call('GET', '/agent/push/status')).body.devices).toBe(1);

    // The same install registering again (token valid after all) is re-enabled.
    answerFor = () => null;
    const back = await call('POST', '/agent/push/devices', { platform: 'android', token: TOKEN_A });
    expect(back.body.device).toMatchObject({ id: a.id, disabledAt: null, lastError: null });
  });

  test('a setup error is recorded once for the host, not blamed on devices', async () => {
    await configure();
    const a = registerDevice({ platform: 'ios', token: TOKEN_A }).device;
    answerFor = () => Response.json({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'Auth error from APNS or Web Push Service', details: [{ errorCode: 'THIRD_PARTY_AUTH_ERROR' }] } }, { status: 401 });
    const outcome = await pushToDevices({ type: 'notify', text: 'hi', priority: 'normal', sessionId: 's', sessionName: 'S', quiet: false });
    expect(outcome.configured && outcome.results[0]!.ok).toBe(false);
    expect(loadPushSettings().lastError?.message).toContain('THIRD_PARTY_AUTH_ERROR');
    expect((await call('GET', '/agent/push/devices')).body.devices.find((d: any) => d.id === a.id).disabledAt).toBeNull();

    answerFor = () => null;
    await pushToDevices({ type: 'notify', text: 'hi', priority: 'normal', sessionId: 's', sessionName: 'S', quiet: false });
    expect(loadPushSettings().lastError).toBeNull();
  });
});

describe('hooks', () => {
  async function settle(requestId: string) {
    await _pendingPushes().get(requestId)?.sending;
  }

  test('an approval is pushed with the policy code, and its resolution follows', async () => {
    await configure();
    registerDevice({ platform: 'android', token: TOKEN_A });
    // Stand-in for the policy area's GET /agent/approvals.
    _setApprovalLookupForTest(async id => (id === 'req-42' ? { requestId: id, code: '4821', expiresAt: Date.now() + 120_000 } : null));

    // Slow FCM: the owner answers on the desktop while the request push is in flight.
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    answerFor = () => null;
    const slow = fakeFetch;
    _setPushClientForTest(createFcmClient({
      fetch: async (url, init) => { if (url !== TOKEN_URL) await gate; return slow(url, init); },
      sleep: async () => {},
    }));

    emitApprovalRequested({ requestId: 'req-42', sessionId: 'coding-1', sessionName: 'api', toolName: 'Bash', title: 'Bash', summary: 'bun test', input: {} });
    const pending = _pendingPushes().get('req-42')!;
    await new Promise(r => setTimeout(r, 10));
    emitApprovalResolved({ requestId: 'req-42', allow: true, via: 'desktop' });
    release();
    await pending.sending;
    // The resolution waits for the request push, so it can never arrive first.
    await new Promise(r => setTimeout(r, 20));

    expect(sent.map(s => s.message.data.type)).toEqual(['approval', 'approval_resolved']);
    expect(sent[0]!.message.data).toMatchObject({ requestId: 'req-42', code: '4821', sessionId: 'coding-1', channel: 'approvals' });
    expect(sent[1]!.message.data).toMatchObject({ requestId: 'req-42', allow: 'true', via: 'desktop', sessionId: 'coding-1' });
  });

  test('a request answered before its push went out is never pushed', async () => {
    await configure();
    registerDevice({ platform: 'android', token: TOKEN_A });
    emitApprovalRequested({ requestId: 'req-fast', sessionId: 'coding-1', sessionName: 'api', toolName: 'Read', title: 'Read', summary: 'a.ts', input: {} });
    const pending = _pendingPushes().get('req-fast')!;
    emitApprovalResolved({ requestId: 'req-fast', allow: true, via: 'desktop' });
    expect(await pending.sending).toBe(false);
    await new Promise(r => setTimeout(r, 20));
    expect(sent).toHaveLength(0);
  });

  test('approvalsForAllSessions=false keeps coding sessions off the phone', async () => {
    await configure();
    registerDevice({ platform: 'android', token: TOKEN_A });
    patchPushSettings({ approvalsForAllSessions: false });
    emitApprovalRequested({ requestId: 'req-coding', sessionId: 'coding-1', sessionName: 'api', toolName: 'Bash', title: 'Bash', summary: 'ls', input: {} });
    emitApprovalRequested({ requestId: 'req-agent', sessionId: AGENT_SESSION_ID, sessionName: 'Codiby', toolName: 'Bash', title: 'Bash', summary: 'ls', input: {} });
    await settle('req-agent');
    expect(sent.map(s => s.message.data.requestId)).toEqual(['req-agent']);
    // Resolving a request that was never pushed sends nothing.
    emitApprovalResolved({ requestId: 'req-coding', allow: false, via: 'desktop' });
    await new Promise(r => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
    _pendingPushes().clear();
  });

  test('nothing is pushed while the agent is disabled', async () => {
    await configure();
    registerDevice({ platform: 'android', token: TOKEN_A });
    saveAgentConfig({ ...loadAgentConfig(), enabled: false });
    emitApprovalRequested({ requestId: 'req-off', sessionId: AGENT_SESSION_ID, sessionName: 'Codiby', toolName: 'Bash', title: 'Bash', summary: 'ls', input: {} });
    emitOwnerNotification({ text: 'hi', priority: 'normal', sessionId: AGENT_SESSION_ID, sessionName: 'Codiby', quiet: false });
    await new Promise(r => setTimeout(r, 20));
    expect(sent).toHaveLength(0);
    expect(_pendingPushes().has('req-off')).toBe(false);
  });

  test('owner notifications become notify pushes, quiet ones silent', async () => {
    await configure();
    registerDevice({ platform: 'android', token: TOKEN_A });
    emitOwnerNotification({ text: 'Standup in 10 min', title: 'Reminder', priority: 'normal', sessionId: AGENT_SESSION_ID, sessionName: 'Codiby', quiet: true });
    await new Promise(r => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message.data).toMatchObject({ type: 'notify', title: 'Reminder', body: 'Standup in 10 min', quiet: 'true', channel: 'messages_quiet' });

    // A message reminder at priority low, outside quiet hours: no title of its own, and silent.
    emitOwnerNotification({ text: '⏰ Water the plants', priority: 'low', sessionId: AGENT_SESSION_ID, sessionName: '🤖 Codiby', quiet: false });
    await new Promise(r => setTimeout(r, 20));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.message.data).toMatchObject({ type: 'notify', title: '🤖 Codiby', body: '⏰ Water the plants', priority: 'low', quiet: 'true', channel: 'messages_quiet' });

    patchPushSettings({ notifications: false });
    emitOwnerNotification({ text: 'again', priority: 'urgent', sessionId: AGENT_SESSION_ID, sessionName: 'Codiby', quiet: false });
    await new Promise(r => setTimeout(r, 20));
    expect(sent).toHaveLength(2);
  });
});
