import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';

import { SocketProvider } from '../src/api/SocketProvider';
import { isActiveState, useAppActive } from '../src/api/useAppActive';
import { RECHECK_MS, useServerRoutes } from '../src/api/useServerRoutes';
import type { ServerEntry } from '../src/config/servers';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
}));

const mockServer: ServerEntry = {
  id: 'mac',
  name: 'mac',
  localUrl: 'http://192.168.3.161:3111',
  remoteUrl: '',
  token: 't',
  color: 'green',
  mode: 'local',
};

jest.mock('../src/config/ServerConfigContext', () => ({
  useServers: () => ({
    routes: {
      mac: { server: mockServer, baseUrl: mockServer.localUrl, token: 't', path: 'local', latencyMs: 5, isProbing: false },
    },
  }),
}));

let mockActive = true;
jest.mock('../src/api/useAppActive', () => ({
  ...jest.requireActual('../src/api/useAppActive'),
  useAppActive: () => mockActive,
}));

class FakeSocket {
  static all: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send() {}
  close() {
    this.closed = true;
  }
}

const realWebSocket = globalThis.WebSocket;
beforeEach(() => {
  FakeSocket.all = [];
  mockActive = true;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
});
afterAll(() => {
  globalThis.WebSocket = realWebSocket;
});

describe('sockets de la interfaz', () => {
  test('se cierran al pasar a segundo plano y se reabren al volver', async () => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(<SocketProvider>{null}</SocketProvider>);
    });
    expect(FakeSocket.all).toHaveLength(1);
    const first = FakeSocket.all[0]!;

    mockActive = false;
    await act(async () => {
      tree.update(<SocketProvider>{null}</SocketProvider>);
    });
    expect(first.closed).toBe(true);
    // Cerrar en segundo plano no programa reconexión.
    expect(first.onclose).toBeNull();
    expect(FakeSocket.all).toHaveLength(1);

    mockActive = true;
    await act(async () => {
      tree.update(<SocketProvider>{null}</SocketProvider>);
    });
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[1]!.closed).toBe(false);
    await act(async () => tree.unmount());
  });

  test('si la app arranca en segundo plano no abre nada', async () => {
    mockActive = false;
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(<SocketProvider>{null}</SocketProvider>);
    });
    expect(FakeSocket.all).toHaveLength(0);
    await act(async () => tree.unmount());
  });
});

describe('sonda de rutas', () => {
  function Probe({ servers }: { servers: ServerEntry[] }) {
    useServerRoutes(servers, true);
    return null;
  }

  test('solo se repite con la app al frente y vuelve a sondear al regresar', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn(async () => ({ ok: true }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
    const servers = [mockServer];
    let tree!: ReactTestRenderer.ReactTestRenderer;
    try {
      await act(async () => {
        tree = ReactTestRenderer.create(<Probe servers={servers} />);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(RECHECK_MS);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      mockActive = false;
      await act(async () => {
        tree.update(<Probe servers={servers} />);
      });
      await act(async () => {
        jest.advanceTimersByTime(RECHECK_MS * 4);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      mockActive = true;
      await act(async () => {
        tree.update(<Probe servers={servers} />);
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await act(async () => tree.unmount());
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('useAppActive', () => {
  test('solo «background» cuenta como fuera de pantalla', () => {
    expect(isActiveState('active')).toBe(true);
    expect(isActiveState('inactive')).toBe(true);
    expect(isActiveState(null)).toBe(true);
    expect(isActiveState('background')).toBe(false);
  });

  test('sigue los cambios de AppState', async () => {
    const actual = jest.requireActual('../src/api/useAppActive') as { useAppActive: typeof useAppActive };
    let listener: ((state: AppStateStatus) => void) | null = null;
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      listener = handler as (state: AppStateStatus) => void;
      return { remove: jest.fn() } as never;
    });
    const seen: boolean[] = [];
    function Watch() {
      seen.push(actual.useAppActive());
      return null;
    }
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(<Watch />);
    });
    await act(async () => listener?.('background'));
    await act(async () => listener?.('active'));
    expect(seen.slice(-2)).toEqual([false, true]);
    await act(async () => tree.unmount());
    spy.mockRestore();
  });
});
