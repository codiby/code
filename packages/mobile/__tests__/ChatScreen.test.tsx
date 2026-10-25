import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { ChatScreen } from '../src/screens/ChatScreen';
import { Composer } from '../src/components/Chat';
import { SessionChatScreen } from '../src/screens/SessionChatScreen';
import { NewSessionSheet } from '../src/screens/NewSessionSheet';
import { createSession, setSessionStatus } from '../src/api/sessions';
import { sendMessage } from '../src/api/messages';
import { loadDirectContext } from '../src/api/directChat';
import type { ChatMessage, SessionSummary } from '../src/api/types';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: async () => 'claude',
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
jest.mock('../src/components/Chat', () => ({
  Composer: jest.fn(() => null),
  SparkIcon: () => null,
  BackIcon: () => null,
}));
jest.mock('../src/screens/SessionChatScreen', () => ({
  SessionChatScreen: jest.fn(() => null),
}));
jest.mock('../src/screens/NewSessionSheet', () => ({
  NewSessionSheet: jest.fn(() => null),
}));
jest.mock('../src/config/ServerConfigContext', () => ({
  useServers: () => ({
    isLoaded: true,
    servers: [
      { id: 'a', name: 'Studio' },
      { id: 'b', name: 'Laptop' },
    ],
    routes: {
      a: { baseUrl: 'http://a', token: 'a' },
      b: { baseUrl: 'http://b', token: 'b' },
    },
  }),
}));
jest.mock('../src/api/directChat', () => ({
  ...jest.requireActual('../src/api/directChat'),
  loadDirectContext: jest.fn(),
}));
jest.mock('../src/api/sessions', () => ({
  createSession: jest.fn(),
  setSessionStatus: jest.fn(),
}));
jest.mock('../src/api/messages', () => ({ sendMessage: jest.fn() }));
jest.mock('../src/api/home', () => ({ invalidateHome: jest.fn() }));

const temporary: SessionSummary = {
  id: 'temp',
  key: 'a:temp',
  serverId: 'a',
  name: 'Chat directo',
  cwd: '/a',
  folder: 'a',
  updatedAt: 0,
  isOpen: true,
  isRunning: false,
  provider: 'claude',
};
const destination = {
  ...temporary,
  id: 'project',
  key: 'b:project',
  serverId: 'b',
  name: 'Proyecto',
  cwd: '/b/project',
  folder: 'project',
  isOpen: false,
};
const user: ChatMessage = {
  id: 'user',
  role: 'user',
  content: 'Mi petición',
  seq: 1,
  timestamp: 1,
  images: [],
  toolName: null,
  toolInput: null,
  isThinking: false,
  thinkingRedacted: false,
};
const recommendation: ChatMessage = {
  ...user,
  id: 'assistant',
  role: 'assistant',
  content:
    'Conviene retomar.\n```codiby-route\n{"kind":"continue","serverId":"b","sessionId":"project","reason":"Tiene contexto"}\n```',
};

beforeEach(() => {
  jest.clearAllMocks();
  (loadDirectContext as jest.Mock).mockResolvedValue({
    sessions: [destination],
    hosts: [
      { id: 'a', name: 'Studio', home: '/a', baseUrl: 'http://a', token: 'a' },
      { id: 'b', name: 'Laptop', home: '/b' },
    ],
    failed: [],
    excerpts: [],
  });
  (createSession as jest.Mock).mockResolvedValue(temporary);
  (sendMessage as jest.Mock).mockResolvedValue(undefined);
  (setSessionStatus as jest.Mock).mockResolvedValue(undefined);
});

test('un fallo del primer envío reusa la sesión desechable en el reintento', async () => {
  (sendMessage as jest.Mock).mockRejectedValueOnce(new Error('offline'));
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <ChatScreen onOpenSession={jest.fn()} onBack={jest.fn()} />,
    );
  });
  await act(async () => {
    await expect(
      tree.root.findByType(Composer).props.onSend('Mi petición', []),
    ).rejects.toThrow('offline');
  });
  await act(async () => {
    await tree.root.findByType(Composer).props.onSend('Mi petición', []);
  });
  expect(createSession).toHaveBeenCalledTimes(1);
  expect(createSession).toHaveBeenCalledWith(
    'http://a',
    'a',
    'a',
    expect.objectContaining({ disposableTtlMs: 3600000 }),
  );
  expect(tree.root.findByType(SessionChatScreen).props.session.key).toBe(
    'a:temp',
  );
  await act(async () => {
    tree.unmount();
  });
});

test('continuar restaura una sesión archivada en el host correcto y transfiere la petición', async () => {
  const onOpen = jest.fn();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  let card!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <ChatScreen onOpenSession={onOpen} onBack={jest.fn()} />,
    );
  });
  await act(async () => {
    await tree.root.findByType(Composer).props.onSend('Mi petición', []);
  });
  const config = tree.root.findByType(SessionChatScreen).props.directChat;
  await act(async () => {
    card = ReactTestRenderer.create(
      config.renderDestination([user, recommendation]),
    );
  });
  const proposed = card.root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      n.props.children?.[1]?.props?.children === 'Continuar aquí →',
    { deep: false },
  );
  // La acción principal es la primera de la tarjeta de destino.
  const action =
    proposed[0] ??
    card.root.findAll(
      n =>
        n.props.accessibilityRole === 'button' &&
        typeof n.props.onPress === 'function',
      { deep: false },
    )[0]!;
  await act(async () => {
    await action.props.onPress();
  });
  expect(setSessionStatus).toHaveBeenCalledWith(
    'http://b',
    'b',
    'project',
    'open',
  );
  expect(sendMessage).toHaveBeenLastCalledWith(
    'http://b',
    'project',
    'b',
    'Mi petición',
    [],
  );
  expect(onOpen).toHaveBeenCalledWith(
    expect.objectContaining({ key: 'b:project', isOpen: true }),
  );
  expect(setSessionStatus).toHaveBeenCalledWith(
    'http://a',
    'a',
    'temp',
    'archived',
  );
  expect(tree.root.findByType(NewSessionSheet).props.visible).toBe(false);
  await act(async () => {
    tree.unmount();
    card.unmount();
  });
});
