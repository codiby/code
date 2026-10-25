import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { SessionChatScreen } from '../src/screens/SessionChatScreen';
import { Composer, MessageBubble } from '../src/components/Chat';
import { fetchNewerMessages, sendMessage } from '../src/api/messages';
import { readMessages } from '../src/api/messageStore';
import type { ChatMessage, SessionSummary } from '../src/api/types';
import { readReply, replyFromMessage } from '../src/lib/messageReply';

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  useAnimatedKeyboard: () => ({ height: { value: 0 } }),
  useAnimatedStyle: () => ({}),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
jest.mock('../src/config/ServerConfigContext', () => ({
  useRouteFor: () => ({ baseUrl: 'http://host', token: 'token' }),
}));
jest.mock('../src/api/useSessionSocket', () => ({
  useSessionSocket: () => ({ status: 'open', isLive: true }),
}));
jest.mock('../src/api/messages', () => ({
  fetchNewerMessages: jest.fn(),
  sendMessage: jest.fn(),
}));
jest.mock('../src/api/messageStore', () => ({
  readMessages: jest.fn(),
  whenHydrated: async () => {},
  subscribeMessages: () => () => {},
  lastSeqOf: () => 1,
  mergeNewer: (current: unknown) => current,
}));
jest.mock('../src/components/Chat', () => ({
  Composer: jest.fn(() => null),
  MessageBubble: jest.fn(() => null),
  BackIcon: () => null,
  SuggestionRow: () => null,
  StreamingPreview: () => null,
}));

const message: ChatMessage = {
  id: 'original',
  role: 'assistant',
  content: '¿Qué archivo quieres cambiar?',
  images: [],
  seq: 1,
  timestamp: 1,
  toolName: null,
  toolInput: null,
  isThinking: false,
  thinkingRedacted: false,
};
const session = {
  id: 's1',
  key: 'host:s1',
  serverId: 'host',
  name: 'Prueba',
  folder: 'app',
} as SessionSummary;

beforeEach(() => {
  jest.clearAllMocks();
  (readMessages as jest.Mock).mockReturnValue({
    messages: [message],
    hasMore: false,
  });
  (fetchNewerMessages as jest.Mock).mockResolvedValue({
    messages: [],
    gap: false,
  });
  (sendMessage as jest.Mock).mockResolvedValue(undefined);
});

test.each([false, true])(
  'responde con cita en chat normal/directo (%s) y reintenta sin duplicarla',
  async direct => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <SessionChatScreen
          session={session}
          onClose={() => {}}
          directChat={
            direct
              ? { header: null, context: null, renderDestination: () => null }
              : undefined
          }
        />,
      );
    });
    const composer = () => tree.root.findByType(Composer);
    const bubbles = () => tree.root.findAllByType(MessageBubble);
    await act(async () => bubbles()[0]!.props.onReply(message));
    expect(composer().props.replyTo).toEqual(replyFromMessage(message));
    (sendMessage as jest.Mock).mockRejectedValueOnce(new Error('Sin conexión'));
    await act(async () => composer().props.onSend('Este archivo', []));
    const sent = (sendMessage as jest.Mock).mock.calls[0]![3];
    expect(readReply(sent)).toEqual({
      text: 'Este archivo',
      reply: replyFromMessage(message),
    });
    expect(composer().props.replyTo).toBeNull();
    const failed = bubbles().find(b => b.props.message.sendState === 'failed')!;
    expect(failed).toBeDefined();
    // Retrying an earlier message must leave a newly selected response alone.
    await act(async () => bubbles()[0]!.props.onReply(message));
    await act(async () => failed.props.onRetry(failed.props.message));
    expect((sendMessage as jest.Mock).mock.calls[1]![3]).toBe(sent);
    expect(composer().props.replyTo).toEqual(replyFromMessage(message));
    await act(async () => composer().props.onCancelReply());
    expect(composer().props.replyTo).toBeNull();
    await act(async () => tree.unmount());
  },
);
