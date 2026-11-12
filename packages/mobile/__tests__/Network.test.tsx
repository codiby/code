import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

import { SocketProvider } from '../src/api/SocketProvider';
import { useServerRoutes } from '../src/api/useServerRoutes';
import type { ServerEntry } from '../src/config/servers';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
}));

let mockTransport = 'wifi';
let mockNetworkListener: ((transport: string) => void) | null = null;
jest.mock('../src/api/network', () => ({
  ...jest.requireActual('../src/api/network'),
  currentTransport: jest.fn(async () => mockTransport),
  onNetworkChange: (listener: (transport: string) => void) => {
    mockNetworkListener = listener;
    return () => {
      mockNetworkListener = null;
    };
  },
}));

const mockServer: ServerEntry = {
  id: 'mac',
  name: 'mac',
  localUrl: 'http://192.168.3.161:3111',
  remoteUrl: 'https://mac.example.ts.net',
  token: 't',
  color: 'green',
  mode: 'auto',
};

jest.mock('../src/config/ServerConfigContext', () => ({
  useServers: () => ({
    routes: {
      mac: { server: mockServer, baseUrl: mockServer.localUrl, token: 't', path: 'local', latencyMs: 5, isProbing: false },
    },
  }),
}));

class FakeSocket {
  static all: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
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
const realFetch = globalThis.fetch;
beforeEach(() => {
  FakeSocket.all = [];
  mockTransport = 'wifi';
  mockNetworkListener = null;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
});
afterAll(() => {
  globalThis.WebSocket = realWebSocket;
  globalThis.fetch = realFetch;
});

describe('isPrivateUrl', () => {
  const { isPrivateUrl } = jest.requireActual('../src/api/network') as typeof import('../src/api/network');
  test('reconoce direcciones de la red local', () => {
    for (const url of ['http://192.168.3.161:3111', 'http://10.0.0.2', 'http://172.20.1.1:80', 'http://localhost:3111', 'http://mac.local']) {
      expect(isPrivateUrl(url)).toBe(true);
    }
  });
  test('una dirección de internet no lo es', () => {
    for (const url of ['https://mac.example.ts.net', 'http://172.32.0.1', 'https://8.8.8.8']) {
      expect(isPrivateUrl(url)).toBe(false);
    }
  });
});

describe('cambio de red', () => {
  function Probe() {
    useServerRoutes([mockServer], true);
    return null;
  }

  test('con datos móviles se prueba solo la ruta remota', async () => {
    mockTransport = 'cellular';
    const fetchMock = jest.fn(async () => ({ ok: true }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(<Probe />);
    });
    const urls = (fetchMock.mock.calls as unknown as [string][]).map(([url]) => url);
    expect(urls).toEqual(['https://mac.example.ts.net/health']);
    await act(async () => tree.unmount());
  });

  test('al cambiar de red se vuelve a sondear sin esperar los 30 s', async () => {
    const fetchMock = jest.fn(async () => ({ ok: true }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(<Probe />);
    });
    const before = fetchMock.mock.calls.length;
    mockTransport = 'cellular';
    await act(async () => {
      mockNetworkListener?.('cellular');
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    await act(async () => tree.unmount());
  });

  test('los sockets se cierran y se abren de nuevo al cambiar de red', async () => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(<SocketProvider>{null}</SocketProvider>);
    });
    expect(FakeSocket.all).toHaveLength(1);
    await act(async () => {
      mockNetworkListener?.('cellular');
    });
    expect(FakeSocket.all[0]!.closed).toBe(true);
    expect(FakeSocket.all).toHaveLength(2);
    // Sin red no se intenta nada hasta que vuelva.
    await act(async () => {
      mockNetworkListener?.('none');
    });
    expect(FakeSocket.all[1]!.closed).toBe(true);
    expect(FakeSocket.all).toHaveLength(2);
    await act(async () => tree.unmount());
  });
});
