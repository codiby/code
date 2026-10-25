import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { AppState } from 'react-native';
import { UsageIndicator } from '../src/components/UsageIndicator';
import { fetchUsage, type UsageSnapshot } from '../src/api/usage';

let mockUrl = 'http://studio:3111';
jest.mock('../src/config/ServerConfigContext', () => ({
  useServers: () => ({
    servers: [{ id: 'studio', name: 'Studio', token: 'token' }],
    routes: { studio: { baseUrl: mockUrl } },
  }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
jest.mock('../src/api/usage', () => ({
  ...jest.requireActual('../src/api/usage'),
  fetchUsage: jest.fn(),
}));
const mockFetch = jest.mocked(fetchUsage);
const snapshot: UsageSnapshot = {
  fetchedAt: '2026-10-23T20:00:00Z',
  providers: [
    {
      provider: 'codex',
      status: 'ok',
      account: { plan: 'Pro' },
      windows: [
        { id: 'weekly', kind: 'weekly', percent: 92, severity: 'critical' },
      ],
    },
  ],
};
let tree: ReactTestRenderer.ReactTestRenderer;
const button = (label: string) =>
  tree.root.findAll(
    node =>
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
    { deep: false },
  )[0]!;
const headline = () =>
  tree.root.findAll(
    node =>
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith('Uso del plan') &&
      typeof node.props.onPress === 'function',
    { deep: false },
  )[0]!;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockUrl = 'http://studio:3111';
  mockFetch.mockResolvedValue(snapshot);
});
afterEach(async () => {
  await act(async () => {
    tree?.unmount();
  });
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('abre el detalle, fuerza actualización y conserva datos con aviso si falla', async () => {
  await act(async () => {
    tree = ReactTestRenderer.create(<UsageIndicator />);
  });
  expect(headline().props.accessibilityLabel).toContain('92%');
  await act(async () => {
    headline().props.onPress();
  });
  expect(mockFetch).toHaveBeenLastCalledWith(mockUrl, 'token', true);
  expect(
    tree.root.findAllByProps({ accessibilityRole: 'progressbar' }).length,
  ).toBeGreaterThan(0);
  mockFetch.mockRejectedValueOnce(new Error('Sin respuesta'));
  await act(async () => {
    button('Actualizar uso').props.onPress();
  });
  expect(headline().props.accessibilityLabel).toContain('datos incompletos');
  expect(headline().props.accessibilityLabel).toContain('92%');
  expect(
    tree.root.findAllByProps({ accessibilityRole: 'alert' }).length,
  ).toBeGreaterThan(0);
});

test('descarta una respuesta tardía de la ruta anterior', async () => {
  let resolve!: (value: UsageSnapshot) => void;
  mockFetch.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  await act(async () => {
    tree = ReactTestRenderer.create(<UsageIndicator />);
  });
  mockUrl = 'http://other:3111';
  mockFetch.mockResolvedValue({ ...snapshot, providers: [] });
  await act(async () => {
    tree.update(<UsageIndicator />);
  });
  await act(async () => {
    resolve(snapshot);
  });
  expect(headline().props.accessibilityLabel).not.toContain('92%');
});

test('actualiza cada cinco minutos y al regresar al primer plano', async () => {
  const listener = jest.spyOn(AppState, 'addEventListener');
  await act(async () => {
    tree = ReactTestRenderer.create(<UsageIndicator />);
  });
  expect(mockFetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    jest.advanceTimersByTime(5 * 60_000);
  });
  expect(mockFetch).toHaveBeenCalledTimes(2);
  await act(async () => {
    listener.mock.calls[0]![1]('active');
  });
  expect(mockFetch).toHaveBeenCalledTimes(3);
});

test('un servidor caído no dispara peticiones', async () => {
  mockUrl = '';
  await act(async () => {
    tree = ReactTestRenderer.create(<UsageIndicator />);
  });
  expect(mockFetch).not.toHaveBeenCalled();
  expect(headline().props.accessibilityLabel).toContain('datos incompletos');
});
