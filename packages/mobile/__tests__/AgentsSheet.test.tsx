import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Alert, Modal, Text } from 'react-native';

import { createTaskFeed, fetchTaskMessages } from '../src/api/subagents';
import { useSessionSocket } from '../src/api/useSessionSocket';
import { MessageBubble } from '../src/components/Chat';
import { AgentsButton } from '../src/components/Subagents';
import { AgentChat } from '../src/components/Subagents/AgentChat';
import { AgentsSheet } from '../src/components/Subagents/AgentsSheet';
import type { SubagentMessage, SubagentTask } from '../src/lib/subagents';

jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: require('react-native').View,
  ScrollView: require('react-native').ScrollView,
}));
jest.mock('@react-native-clipboard/clipboard', () => ({
  setString: jest.fn(),
}));
jest.mock('../src/components/Gallery', () => ({ ImageLightbox: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
jest.mock('../src/api/subagents', () => ({
  ...jest.requireActual('../src/api/subagents'),
  fetchTaskMessages: jest.fn(),
}));

type Listener = (serverId: string, frame: Record<string, unknown>) => void;
const mockListeners = new Set<Listener>();
const mockSockets = {
  send: jest.fn(() => true),
  subscribe: jest.fn(),
  statusOf: () => 'open',
  isLive: () => true,
  addListener: (listener: Listener) => {
    mockListeners.add(listener);
    return () => {
      mockListeners.delete(listener);
    };
  },
};
jest.mock('../src/api/SocketProvider', () => ({
  RECONNECTED: '__reconnected',
  useSockets: () => mockSockets,
}));

const mockFetch = jest.mocked(fetchTaskMessages);

const base: SubagentTask = {
  taskId: 't',
  toolUseId: null,
  taskType: 'local_agent',
  description: '',
  subagentType: 'Explore',
  workflowName: null,
  prompt: null,
  status: 'running',
  backgrounded: false,
  spawnDepth: 1,
  startedAt: 0,
  endedAt: null,
  totalTokens: 0,
  toolUses: 0,
  durationMs: 0,
  lastToolName: null,
  progress: null,
  summary: null,
  error: null,
};
const task = (patch: Partial<SubagentTask>): SubagentTask => ({
  ...base,
  ...patch,
});
const said = (id: string, content: string, seq: number): SubagentMessage => ({
  id,
  role: 'assistant',
  content,
  timestamp: seq,
  seq,
  toolName: null,
  toolInput: null,
  images: [],
  isThinking: false,
  thinkingRedacted: false,
  agentId: 'live',
  parentToolUseId: 'toolu_1',
});

const live = task({
  taskId: 'live',
  toolUseId: 'toolu_1',
  description: 'Map the auth flow',
  startedAt: 1000,
  lastToolName: 'Grep',
  progress: 'Looking at middleware',
  prompt: 'Find every place the session cookie is read.',
});
const finished = task({
  taskId: 'old',
  description: 'Read the docs',
  status: 'completed',
  startedAt: 10,
  endedAt: 2000,
  totalTokens: 1200,
  summary: 'The docs cover it.',
});
const shell = task({
  taskId: 'sh',
  taskType: 'local_bash',
  subagentType: null,
});
const tasks = { live, old: finished, sh: shell };

let tree: ReactTestRenderer.ReactTestRenderer;
const pressables = () =>
  tree.root.findAll(node => typeof node.props.onPress === 'function', {
    deep: false,
  });
const button = (label: string) =>
  pressables().find(node => node.props.accessibilityLabel === label)!;
const rows = () =>
  pressables().filter(
    node => node.props.accessibilityHint === "Opens the agent's full chat",
  );
const flatten = (children: unknown): string =>
  Array.isArray(children)
    ? children.map(flatten).join('')
    : typeof children === 'string' || typeof children === 'number'
    ? String(children)
    : typeof children === 'object' && children !== null && 'props' in children
    ? flatten((children as { props: { children?: unknown } }).props.children)
    : '';
const shownText = () =>
  tree.root
    .findAllByType(Text)
    .map(node => flatten(node.props.children))
    .join('\n');
// `Markdown` is memoised, so it can't be found by type: its `text` prop is unique enough.
const markdownWith = (text: string) =>
  tree.root.findAll(node => node.props.text === text, { deep: false });
const emit = (frame: Record<string, unknown>) => {
  for (const listener of mockListeners) {
    listener('studio', frame);
  }
};

function renderSheet(current: Record<string, SubagentTask> = tasks) {
  return (
    <AgentsSheet
      visible
      onClose={() => {}}
      tasks={current}
      serverId="studio"
      sessionId="s1"
      baseUrl="http://studio"
      token="tok"
    />
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockListeners.clear();
  mockFetch.mockResolvedValue([said('m1', 'Found it in middleware.ts', 5)]);
});
afterEach(async () => {
  await act(async () => {
    tree?.unmount();
  });
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('lists running agents first, opens one and follows it live', async () => {
  await act(async () => {
    tree = ReactTestRenderer.create(renderSheet());
  });
  // Shells are tasks too, but not agents.
  expect(rows().map(row => row.props.accessibilityLabel)).toEqual([
    'Map the auth flow, running',
    'Read the docs, completed',
  ]);
  expect(shownText()).toContain('1 running · 1 done');
  expect(shownText()).toContain('Looking at middleware');

  await act(async () => rows()[0]!.props.onPress());
  expect(tree.root.findAllByType(AgentChat)).toHaveLength(1);
  expect(mockFetch).toHaveBeenCalledWith(
    'http://studio',
    'tok',
    's1',
    'live',
    'toolu_1',
  );
  expect(shownText()).toContain('Prompt from the main agent');
  const contents = () =>
    tree.root
      .findAllByType(MessageBubble)
      .map(bubble => bubble.props.message.content);
  expect(contents()).toEqual(['Found it in middleware.ts']);

  // Its own text streams in; another agent's or another session's does not.
  await act(async () => {
    emit({
      type: 'subagent_message',
      sessionId: 's1',
      message: { ...said('m2', 'Now the routes', 9) },
    });
    emit({
      type: 'subagent_message',
      sessionId: 's1',
      message: { ...said('m3', 'Not mine', 10), agentId: 'other' },
    });
    emit({
      type: 'subagent_message',
      sessionId: 's2',
      message: { ...said('m4', 'Other session', 11) },
    });
  });
  // Inverted list: newest first.
  expect(contents()).toEqual(['Now the routes', 'Found it in middleware.ts']);

  await act(async () => button('Move to the background').props.onPress());
  expect(mockSockets.send).toHaveBeenLastCalledWith('studio', {
    type: 'task_background',
    sessionId: 's1',
    toolUseId: 'toolu_1',
  });
  // One action in flight at a time, until the bridge reports back.
  expect(button('Move to the background').props.disabled).toBe(true);
  expect(shownText()).toContain('Moving…');

  jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    buttons?.find(option => option.style === 'destructive')?.onPress?.();
  });
  await act(async () => button('Stop this agent').props.onPress());
  expect(mockSockets.send).toHaveBeenLastCalledWith('studio', {
    type: 'task_stop',
    sessionId: 's1',
    taskId: 'live',
  });
  expect(shownText()).toContain('Stopping…');

  // A bridge that never answers must not leave the buttons stuck.
  await act(async () => {
    jest.advanceTimersByTime(8000);
  });
  expect(button('Stop this agent').props.disabled).toBe(false);

  // Android back steps from the chat to the list before closing anything.
  await act(async () => tree.root.findByType(Modal).props.onRequestClose());
  expect(tree.root.findAllByType(AgentChat)).toHaveLength(0);
  expect(rows()).toHaveLength(2);
});

test('a finished agent shows what it returned, once', async () => {
  mockFetch.mockResolvedValue([
    { ...said('m1', 'Checked three guides.', 1), agentId: 'old' },
  ]);
  await act(async () => {
    tree = ReactTestRenderer.create(renderSheet());
  });
  await act(async () => rows()[1]!.props.onPress());
  expect(shownText()).toContain('Returned to the main agent');
  expect(markdownWith('Checked three guides.')).toHaveLength(1);
  expect(markdownWith('The docs cover it.')).toHaveLength(1);
  // Nothing to stop once it is done.
  expect(
    pressables().some(
      node => node.props.accessibilityLabel === 'Stop this agent',
    ),
  ).toBe(false);

  // When the last answer *is* the summary, only the label is added.
  mockFetch.mockResolvedValue([
    { ...said('m1', 'The docs cover it.', 1), agentId: 'old' },
  ]);
  await act(async () => tree.root.findByType(Modal).props.onRequestClose());
  await act(async () => rows()[1]!.props.onPress());
  expect(markdownWith('The docs cover it.')).toHaveLength(1);
  expect(shownText()).toContain('Returned to the main agent');
});

test('the header chip appears with the first agent and opens the sheet', async () => {
  const feed = createTaskFeed();
  await act(async () => {
    tree = ReactTestRenderer.create(
      <AgentsButton
        feed={feed}
        serverId="studio"
        sessionId="s1"
        baseUrl="http://studio"
        token="tok"
      />,
    );
  });
  expect(tree.toJSON()).toBeNull();

  // A shell alone is not worth a chip.
  await act(async () => feed.replace({ sh: shell }));
  expect(tree.toJSON()).toBeNull();

  await act(async () => feed.upsert(live));
  expect(button('Agents, 1 running, 0 done')).toBeDefined();
  expect(tree.root.findAllByType(AgentsSheet)).toHaveLength(0);

  await act(async () => button('Agents, 1 running, 0 done').props.onPress());
  const sheet = tree.root.findByType(AgentsSheet);
  expect(sheet.props.visible).toBe(true);
  expect(Object.keys(sheet.props.tasks)).toEqual(['sh', 'live']);

  await act(async () => feed.upsert({ ...live, status: 'completed' }));
  expect(button('Agents, 0 running, 1 done')).toBeDefined();
});

test('the chat socket feeds the session tasks: snapshot, then updates', async () => {
  const onTasks = jest.fn();
  const onTaskUpdate = jest.fn();
  function Probe() {
    useSessionSocket({
      serverId: 'studio',
      sessionId: 's1',
      onMessage: () => {},
      onStatus: () => {},
      onPartialText: () => {},
      onPartialThinking: () => {},
      onTasks,
      onTaskUpdate,
    });
    return null;
  }
  await act(async () => {
    tree = ReactTestRenderer.create(<Probe />);
  });
  await act(async () => {
    emit({
      type: 'session_state',
      sessionId: 's1',
      state: { tasks: { live } },
    });
    // A bridge from before sub-agents: its snapshot must not wipe the list.
    emit({
      type: 'session_state',
      sessionId: 's1',
      state: { totalMessages: 3 },
    });
    emit({ type: 'task_update', sessionId: 's1', task: finished });
    emit({ type: 'task_update', sessionId: 's2', task: finished });
    emit({ type: 'task_update', sessionId: 's1', task: { nope: true } });
  });
  expect(onTasks.mock.calls).toEqual([[{ live }]]);
  expect(onTaskUpdate.mock.calls).toEqual([[finished]]);
});
