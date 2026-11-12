import { Platform } from 'react-native';
import notifee, { EventType } from 'react-native-notify-kit';

import {
  handleNotificationEvent,
  handleRemoteMessage,
} from '../src/push/handlers';
import { saveRegistration } from '../src/push/hosts';
import { _resetNotificationSetupForTest } from '../src/push/notifications';

jest.mock('../src/push/native', () => ({
  notifications: () => require('react-native-notify-kit'),
  firebaseMessaging: () => null,
}));

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
}));

const approvalData = {
  type: 'approval',
  requestId: 'req-1',
  title: 'Approval needed · api',
  body: 'Bash\nbun test',
  toolName: 'Bash',
  host: 'ryzen9',
  sessionId: 'coding-1',
  sessionName: 'api',
  expiresAt: String(Date.now() + 600_000),
};

const fetchMock = jest.fn();
const originalOS = Platform.OS;

function setOS(os: 'ios' | 'android') {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os });
}

async function pairWithRyzen() {
  mockStore.set(
    'codiby.servers',
    JSON.stringify([
      {
        id: 'srv_ryzen',
        name: 'ryzen9',
        localUrl: 'http://192.168.1.9:3111',
        remoteUrl: 'https://ryzen9.ts.net',
        token: 'secret-token',
        color: 'green',
        mode: 'auto',
      },
    ]),
  );
  await saveRegistration({
    serverId: 'srv_ryzen',
    host: 'ryzen9',
    deviceId: 'dev-1',
    token: 'fcm-1',
    configured: true,
    at: 1,
  });
}

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
  _resetNotificationSetupForTest();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  setOS('android');
});

afterAll(() => setOS(originalOS as 'ios' | 'android'));

test('Android draws approvals with Approve / Deny, keyed by request id', async () => {
  await handleRemoteMessage({ data: approvalData }, { foreground: false });
  expect(notifee.createChannels).toHaveBeenCalledTimes(1);
  const shown = (notifee.displayNotification as jest.Mock).mock.calls[0][0];
  expect(shown.id).toBe('req-1');
  expect(shown.android.channelId).toBe('approvals');
  expect(
    shown.android.actions.map(
      (a: { pressAction: { id: string } }) => a.pressAction.id,
    ),
  ).toEqual(['approve', 'deny']);
  // Hidden on a locked screen: the buttons approve things.
  expect(shown.android.visibility).toBe(0);
  expect(shown.android.timeoutAfter).toBeGreaterThan(0);
  expect(shown.data.requestId).toBe('req-1');
});

test('a question is shown without buttons', async () => {
  await handleRemoteMessage(
    { data: { ...approvalData, toolName: 'AskUserQuestion', question: 'true' } },
    { foreground: true },
  );
  const shown = (notifee.displayNotification as jest.Mock).mock.calls[0][0];
  expect(shown.android.actions).toBeUndefined();
  expect(shown.ios.categoryId).toBeUndefined();
});

test('a resolution removes the notification; iOS leaves background alerts to the system', async () => {
  await handleRemoteMessage(
    {
      data: {
        type: 'approval_resolved',
        requestId: 'req-1',
        allow: 'false',
        host: 'ryzen9',
      },
    },
    { foreground: false },
  );
  expect(notifee.cancelNotification).toHaveBeenCalledWith('req-1');

  setOS('ios');
  await handleRemoteMessage({ data: approvalData }, { foreground: false });
  expect(notifee.displayNotification).not.toHaveBeenCalled();
  await handleRemoteMessage({ data: approvalData }, { foreground: true });
  expect(notifee.setNotificationCategories).toHaveBeenCalledTimes(1);
  expect(
    (notifee.displayNotification as jest.Mock).mock.calls[0][0].ios.categoryId,
  ).toBe('APPROVAL');
});

test('quiet notifications go to the quiet channel', async () => {
  await handleRemoteMessage(
    {
      data: {
        type: 'notify',
        title: 'Reminder',
        body: 'Standup',
        host: 'ryzen9',
        quiet: 'true',
        channel: 'messages_quiet',
        priority: 'normal',
      },
    },
    { foreground: true },
  );
  expect(
    (notifee.displayNotification as jest.Mock).mock.calls[0][0].android
      .channelId,
  ).toBe('messages_quiet');
});

test('Approve answers the host that asked, with its token, then clears the notification', async () => {
  await pairWithRyzen();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
  });
  const target = await handleNotificationEvent({
    type: EventType.ACTION_PRESS,
    detail: {
      notification: { id: 'req-1', data: approvalData },
      pressAction: { id: 'approve' },
    },
  });
  expect(target).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('http://192.168.1.9:3111/agent/approvals/req-1');
  expect(init.method).toBe('POST');
  expect(init.headers.Authorization).toBe('Bearer secret-token');
  expect(JSON.parse(init.body)).toEqual({ allow: true, via: 'push' });
  expect(notifee.cancelNotification).toHaveBeenCalledWith('req-1');
});

test('an unreachable route falls back to the other; a refusal does not', async () => {
  await pairWithRyzen();
  fetchMock
    .mockRejectedValueOnce(new TypeError('Network request failed'))
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
  await handleNotificationEvent({
    type: EventType.ACTION_PRESS,
    detail: {
      notification: { data: approvalData },
      pressAction: { id: 'deny' },
    },
  });
  expect(fetchMock.mock.calls.map(c => c[0])).toEqual([
    'http://192.168.1.9:3111/agent/approvals/req-1',
    'https://ryzen9.ts.net/agent/approvals/req-1',
  ]);
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
    allow: false,
    via: 'push',
  });

  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: false,
    status: 404,
    json: async () => ({ error: 'Approval not found or already answered' }),
  });
  await handleNotificationEvent({
    type: EventType.ACTION_PRESS,
    detail: {
      notification: { data: approvalData },
      pressAction: { id: 'approve' },
    },
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const problem = (notifee.displayNotification as jest.Mock).mock.calls.at(
    -1,
  )[0];
  expect(problem.id).toBe('req-1');
  expect(problem.body).toContain('already answered');
  expect(problem.android.actions).toBeUndefined();
});

test('a plain tap opens the session that asked', async () => {
  const target = await handleNotificationEvent({
    type: EventType.PRESS,
    detail: { notification: { data: approvalData } },
  });
  expect(target).toEqual({ host: 'ryzen9', sessionId: 'coding-1' });
});
