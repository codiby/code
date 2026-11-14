import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { ChatScreen } from '../src/screens/ChatScreen';
import { Composer } from '../src/components/Chat';
import { SessionChatScreen } from '../src/screens/SessionChatScreen';
import { NewSessionSheet } from '../src/screens/NewSessionSheet';
import {
  deleteSession,
  createSession,
  fetchSessions,
  keepSession,
  setSessionStatus,
} from '../src/api/sessions';
import { fetchMessages, sendMessage } from '../src/api/messages';
import { writeMessages } from '../src/api/messageStore';
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
  keepSession: jest.fn(),
  fetchSessions: jest.fn(),
  deleteSession: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/api/messages', () => ({
  LATEST_SEQ: Number.MAX_SAFE_INTEGER,
  sendMessage: jest.fn(),
  fetchMessages: jest.fn(() =>
    Promise.resolve({ messages: [], hasMore: false }),
  ),
}));
jest.mock('../src/api/messageStore', () => ({
  readMessages: jest.fn(() => null),
  writeMessages: jest.fn(),
}));
jest.mock('../src/api/home', () => ({ invalidateHome: jest.fn() }));

const temporary: SessionSummary = {
  id: 'temp',
  key: 'a:temp',
  serverId: 'a',
  name: 'Direct chat',
  cwd: '/a',
  folder: 'a',
  updatedAt: 0,
  lastSentAt: 0,
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
  (keepSession as jest.Mock).mockResolvedValue(undefined);
  (fetchSessions as jest.Mock).mockResolvedValue([]);
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

async function startDirectChat(onOpen: jest.Mock) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <ChatScreen onOpenSession={onOpen} onBack={jest.fn()} />,
    );
  });
  await act(async () => {
    await tree.root.findByType(Composer).props.onSend('Mi petición', []);
  });
  return tree;
}

test('la ruta del agente se aplica sola: restaura la sesión archivada y le pasa la petición', async () => {
  const onOpen = jest.fn();
  const tree = await startDirectChat(onOpen);
  const config = tree.root.findByType(SessionChatScreen).props.directChat;
  let card!: ReactTestRenderer.ReactTestRenderer;
  // Nadie toca la tarjeta: basta con que llegue la respuesta del agente.
  await act(async () => {
    card = ReactTestRenderer.create(
      config.renderDestination([user, recommendation]),
    );
  });
  expect(setSessionStatus).toHaveBeenCalledWith(
    'http://b',
    'b',
    'project',
    'open',
  );
  // El encabezado y la tarjeta se transforman antes del relevo.
  await act(() => new Promise<void>(resolve => setTimeout(resolve, 400)));
  // El historial del destino queda en caché antes de animar.
  expect(fetchMessages).toHaveBeenCalledWith(
    'http://b',
    'project',
    'b',
    Number.MAX_SAFE_INTEGER,
  );
  expect(writeMessages).toHaveBeenCalledWith('b:project', [], false);
  // La petición no la manda el chat directo: viaja al destino, que la envía
  // como mensaje propio al aparecer en sitio.
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith(
    expect.objectContaining({ key: 'b:project', isOpen: true }),
    {
      inPlace: true,
      handoff: {
        text: 'Mi petición',
        images: [],
        note: 'Moved here from Direct chat',
      },
    },
  );
  // El chat temporal se elimina, no se archiva.
  expect(deleteSession).toHaveBeenCalledWith('http://a', 'a', 'temp');
  expect(setSessionStatus).not.toHaveBeenCalledWith(
    'http://a',
    'a',
    'temp',
    'archived',
  );
  expect(tree.root.findByType(NewSessionSheet).props.visible).toBe(false);
  // Repintar la misma respuesta no vuelve a moverla.
  await act(async () => {
    card.update(config.renderDestination([user, recommendation]));
  });
  expect(onOpen).toHaveBeenCalledTimes(1);
  await act(async () => {
    tree.unmount();
    card.unmount();
  });
});

test('una ruta «new» crea la conversación en el host elegido sin abrir la hoja', async () => {
  const created = { ...destination, id: 'fresh', key: 'b:fresh', isOpen: true };
  (createSession as jest.Mock)
    .mockResolvedValueOnce(temporary)
    .mockResolvedValueOnce(created);
  const onOpen = jest.fn();
  const tree = await startDirectChat(onOpen);
  const config = tree.root.findByType(SessionChatScreen).props.directChat;
  const proposal: ChatMessage = {
    ...recommendation,
    id: 'assistant-new',
    content:
      'Mejor una nueva.\n```codiby-route\n{"kind":"new","serverId":"b","cwd":"/b/project","title":"Rediseño","reason":"Es otro tema"}\n```',
  };
  let card!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    card = ReactTestRenderer.create(
      config.renderDestination([user, proposal]),
    );
  });
  expect(createSession).toHaveBeenLastCalledWith(
    'http://b',
    'b',
    'b',
    expect.objectContaining({ cwd: '/b/project', name: 'Rediseño' }),
  );
  await act(() => new Promise<void>(resolve => setTimeout(resolve, 400)));
  expect(onOpen).toHaveBeenCalledWith(
    expect.objectContaining({ key: 'b:fresh' }),
    expect.objectContaining({
      inPlace: true,
      handoff: expect.objectContaining({ text: 'Mi petición' }),
    }),
  );
  expect(deleteSession).toHaveBeenCalledWith('http://a', 'a', 'temp');
  expect(tree.root.findByType(NewSessionSheet).props.visible).toBe(false);
  await act(async () => {
    tree.unmount();
    card.unmount();
  });
});

test('sin bloque de ruta el agente solo conversa: no se mueve nada', async () => {
  const onOpen = jest.fn();
  const tree = await startDirectChat(onOpen);
  const config = tree.root.findByType(SessionChatScreen).props.directChat;
  const question: ChatMessage = {
    ...recommendation,
    id: 'assistant-question',
    content: '¿En qué proyecto?',
  };
  let card!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    card = ReactTestRenderer.create(
      config.renderDestination([user, question]),
    );
  });
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(onOpen).not.toHaveBeenCalled();
  await act(async () => {
    tree.unmount();
    card.unmount();
  });
});

test('una ruta «here» conserva el chat temporal como sesión normal, sin crear otra ni archivarlo', async () => {
  (fetchSessions as jest.Mock).mockResolvedValue([
    { ...temporary, name: 'Rediseño', cwd: '/a/app', folder: 'app' },
  ]);
  const onOpen = jest.fn();
  const tree = await startDirectChat(onOpen);
  const config = tree.root.findByType(SessionChatScreen).props.directChat;
  const done: ChatMessage = {
    ...recommendation,
    id: 'assistant-here',
    content:
      'Listo, ya cambié la navegación.\n```codiby-route\n{"kind":"here","title":"Rediseño","reason":"Trabajo nuevo"}\n```',
  };
  let card!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    card = ReactTestRenderer.create(config.renderDestination([user, done]));
  });
  expect(keepSession).toHaveBeenCalledWith('http://a', 'a', 'temp', 'Rediseño');
  // Solo existe la sesión temporal: nada nuevo, nada reenviado, nada archivado.
  expect(createSession).toHaveBeenCalledTimes(1);
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(setSessionStatus).not.toHaveBeenCalled();
  expect(onOpen).toHaveBeenCalledWith(
    expect.objectContaining({ key: 'a:temp', name: 'Rediseño', cwd: '/a/app' }),
  );
  await act(async () => {
    tree.unmount();
    card.unmount();
  });
});
