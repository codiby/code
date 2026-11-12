import type { ServerEntry } from '../src/config/servers';
import { loadRegistrations, serverIdForHost } from '../src/push/hosts';
import { registerWithHost } from '../src/push/registration';
import { _resetPushStateForTest, getPushState } from '../src/push/state';

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
}));

const server: ServerEntry = {
  id: 'srv_ryzen',
  name: 'ryzen9',
  localUrl: 'http://192.168.1.9:3111',
  remoteUrl: '',
  token: 'secret-token',
  color: 'green',
  mode: 'auto',
};
const route = {
  server,
  baseUrl: 'http://192.168.1.9:3111',
  token: 'secret-token',
};

const fetchMock = jest.fn();

function respond(routes: Record<string, unknown>) {
  fetchMock.mockImplementation(async (url: string) => {
    const path = url.replace(route.baseUrl, '');
    const body = routes[path];
    return body === undefined
      ? { ok: false, status: 404, json: async () => ({ error: 'Not found' }) }
      : { ok: true, status: 200, json: async () => body };
  });
}

beforeEach(() => {
  mockStore.clear();
  fetchMock.mockReset();
  _resetPushStateForTest();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

test('a host whose agent is off is not given the token', async () => {
  respond({ '/agent/status': { enabled: false, host: 'mac' } });
  const result = await registerWithHost(route, 'fcm-token-1', 100);
  expect(result).toEqual({ state: 'agent-off', at: 100 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(getPushState().hosts.srv_ryzen).toEqual(result);
});

test('registers with the agent host and replaces the old token after a refresh', async () => {
  respond({
    '/agent/status': { enabled: true, host: 'ryzen9' },
    '/agent/push/devices': {
      ok: true,
      device: { id: 'dev-1' },
      configured: true,
    },
  });
  expect(await registerWithHost(route, 'fcm-token-1', 100)).toMatchObject({
    state: 'registered',
    deviceId: 'dev-1',
    configured: true,
  });
  const first = JSON.parse(fetchMock.mock.calls[1][1].body);
  expect(first).toMatchObject({ token: 'fcm-token-1', replacesToken: null });
  expect(['ios', 'android']).toContain(first.platform);
  expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(
    'Bearer secret-token',
  );

  await registerWithHost(route, 'fcm-token-2', 200);
  expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toMatchObject({
    token: 'fcm-token-2',
    replacesToken: 'fcm-token-1',
  });

  const saved = await loadRegistrations();
  expect(saved.srv_ryzen).toMatchObject({
    host: 'ryzen9',
    deviceId: 'dev-1',
    token: 'fcm-token-2',
    configured: true,
  });
});

test('a failure is reported, not thrown', async () => {
  fetchMock.mockRejectedValue(new TypeError('Network request failed'));
  const result = await registerWithHost(route, 'fcm-token-1', 100);
  expect(result).toEqual({
    state: 'error',
    message: 'Could not reach the server',
    at: 100,
  });
});

test('pushes are matched to servers by host label', () => {
  const regs = {
    a: {
      serverId: 'a',
      host: 'ryzen9',
      deviceId: 'd1',
      token: 't',
      configured: true,
      at: 0,
    },
    b: {
      serverId: 'b',
      host: 'mac',
      deviceId: 'd2',
      token: 't',
      configured: true,
      at: 0,
    },
  };
  expect(serverIdForHost('mac', regs)).toBe('b');
  expect(serverIdForHost('unknown', regs)).toBeNull();
  // With a single agent host, a push from it can't belong anywhere else.
  expect(serverIdForHost('renamed-host', { a: regs.a })).toBe('a');
});
