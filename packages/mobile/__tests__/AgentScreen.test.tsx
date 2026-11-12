import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';

import { AgentScreen } from '../src/screens/AgentScreen';
import { requestPermission } from '../src/push/notifications';
import {
  _resetPushStateForTest,
  setHostPushState,
  updatePushState,
} from '../src/push/state';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
}));
jest.mock('../src/api/useAppActive', () => ({ useAppActive: () => true }));
jest.mock('../src/push/notifications', () => ({
  permissionState: jest.fn(async () => 'undetermined'),
  requestPermission: jest.fn(async () => 'granted'),
  openNotificationSettings: jest.fn(async () => undefined),
}));
jest.mock('../src/push/registration', () => ({
  registerWithHost: jest.fn(async () => undefined),
}));
// Stable references, like the real provider's state.
const mockServers = {
  servers: [
    {
      id: 'srv_ryzen',
      name: 'ryzen9',
      localUrl: 'http://ryzen9:3111',
      remoteUrl: '',
      token: 'tok',
      color: 'green',
      mode: 'auto',
    },
  ],
  routes: { srv_ryzen: { baseUrl: 'http://ryzen9:3111', token: 'tok' } },
};
jest.mock('../src/config/ServerConfigContext', () => ({
  useServers: () => mockServers,
}));

const fetchMock = jest.fn();
let approvals: unknown[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  _resetPushStateForTest();
  approvals = [
    {
      requestId: 'req-1',
      code: '4821',
      toolName: 'Bash',
      title: 'Bash',
      summary: 'rm -rf build',
      category: 'shell',
      sessionId: 'coding-1',
      sessionName: 'api',
      createdAt: 0,
      expiresAt: Date.now() + 300_000,
    },
  ];
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async (url: string, init?: { method?: string }) => {
      const path = url.replace('http://ryzen9:3111', '');
      if (path === '/agent/status') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            enabled: true,
            host: 'ryzen9',
            persona: { name: 'Codiby', emoji: '🤖' },
            session: {
              id: 'main-session',
              name: 'Codiby',
              runtimeStatus: 'running',
              isStreaming: false,
              pendingApproval: null,
            },
          }),
        };
      }
      if (path === '/agent/approvals') {
        return { ok: true, status: 200, json: async () => ({ approvals }) };
      }
      if (path === '/agent/approvals/req-1' && init?.method === 'POST') {
        approvals = [];
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (path === '/agent/push/test') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            results: [{ deviceId: 'dev-1', ok: true }],
          }),
        };
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: 'Not found' }),
      };
    },
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => jest.useRealTimers());

const texts = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(Text).map(t => [t.props.children].flat().join(''));

async function render(onOpenChat = jest.fn()) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<AgentScreen onOpenChat={onOpenChat} />);
  });
  await act(async () => undefined);
  return tree;
}

test('shows the agent and answers an approval from the app', async () => {
  const onOpenChat = jest.fn();
  const tree = await render(onOpenChat);
  expect(texts(tree)).toEqual(
    expect.arrayContaining([
      'Codiby',
      'Idle · ryzen9',
      'rm -rf build',
      'api · code 4821 · expires in 5 min',
    ]),
  );
  // First visit asks for notification permission.
  expect(requestPermission).toHaveBeenCalledTimes(1);

  await act(async () => {
    tree.root
      .findByProps({ accessibilityLabel: 'Approve Bash' })
      .props.onPress();
  });
  const post = fetchMock.mock.calls.find(
    ([url, init]) =>
      url.endsWith('/agent/approvals/req-1') && init?.method === 'POST',
  );
  expect(JSON.parse(post![1].body)).toEqual({ allow: true, via: 'app' });
  expect(post![1].headers.Authorization).toBe('Bearer tok');
  expect(texts(tree)).toContain('Nothing is waiting for your approval.');

  await act(async () => {
    tree.root
      .findByProps({ accessibilityLabel: "Open Codiby's chat" })
      .props.onPress();
  });
  expect(onOpenChat).toHaveBeenCalledWith({
    serverId: 'srv_ryzen',
    sessionId: 'main-session',
    baseUrl: 'http://ryzen9:3111',
    token: 'tok',
  });
  await act(async () => tree.unmount());
});

test('says when push is missing from the build, and sends a test push when registered', async () => {
  let tree = await render();
  expect(texts(tree)).toContain('Not set up in this build');
  await act(async () => tree.unmount());

  updatePushState({ available: true, token: 'fcm-1' });
  setHostPushState('srv_ryzen', {
    state: 'registered',
    deviceId: 'dev-1',
    configured: true,
    at: 0,
  });
  tree = await render();
  expect(texts(tree)).toContain('This phone gets approvals and messages');
  await act(async () => {
    tree.root
      .findByProps({ accessibilityLabel: 'Send a test push from ryzen9' })
      .props.onPress();
  });
  const test = fetchMock.mock.calls.find(([url]) =>
    url.endsWith('/agent/push/test'),
  );
  expect(JSON.parse(test![1].body)).toEqual({ deviceId: 'dev-1' });
  expect(texts(tree)).toContain('Sent — it should arrive in a few seconds.');
  await act(async () => tree.unmount());
});
