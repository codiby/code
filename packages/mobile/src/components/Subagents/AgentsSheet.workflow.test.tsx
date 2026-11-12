import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

import { requestJson } from '../../api/client';
import type { SubagentTask } from '../../lib/subagents';
import { MessageBubble } from '../Chat';
import { WorkflowAgentChat } from './AgentChat';
import { AgentsSheet } from './AgentsSheet';

jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: require('react-native').View,
  ScrollView: require('react-native').ScrollView,
}));
jest.mock('@react-native-clipboard/clipboard', () => ({
  setString: jest.fn(),
}));
jest.mock('../Gallery', () => ({ ImageLightbox: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
jest.mock('../../api/SocketProvider', () => ({
  RECONNECTED: '__reconnected',
  useSockets: () => ({
    send: jest.fn(() => true),
    addListener: () => () => {},
  }),
}));
// The wire is faked one level down, so the real fetchers parse the bodies.
jest.mock('../../api/client', () => ({
  ...jest.requireActual('../../api/client'),
  requestJson: jest.fn(),
}));

const mockRequest = jest.mocked(requestJson);

const workflow: SubagentTask = {
  taskId: 'wf1',
  toolUseId: 'toolu_wf',
  taskType: 'local_workflow',
  description: 'Fix things',
  subagentType: null,
  workflowName: 'phase3',
  prompt: null,
  status: 'running',
  backgrounded: true,
  spawnDepth: 1,
  startedAt: 0,
  endedAt: null,
  totalTokens: 0,
  toolUses: 0,
  durationMs: 0,
  lastToolName: 'fix:ui',
  progress: null,
  summary: null,
  error: null,
};

const agents = [
  {
    agentId: 'a1',
    label: 'fix:ui',
    phase: 'Fix',
    status: 'running',
    startedAt: 10,
    endedAt: null,
    toolUses: 5,
    outputTokens: 1500,
    lastToolName: 'Bash',
    lastText: 'Running the tests',
    summary: null,
  },
  {
    agentId: 'a2',
    label: 'fix:core',
    phase: 'Fix',
    status: 'completed',
    startedAt: 10,
    endedAt: 900,
    toolUses: 9,
    outputTokens: 4000,
    lastToolName: 'StructuredOutput',
    lastText: 'Done',
    summary: 'Core fixed',
  },
];

const said = (id: string, content: string, seq: number) => ({
  id,
  role: 'assistant',
  content,
  timestamp: seq,
  seq,
});

let pages: Record<string, unknown>[] = [];
const calls: string[] = [];

function serve(path: string): unknown {
  calls.push(path);
  if (path.endsWith('/agents')) {
    return { found: true, agents };
  }
  return (
    pages.shift() ?? {
      agent: agents[0],
      prompt: 'Fix the UI',
      messages: [],
      total: 2,
      truncated: false,
      gap: false,
    }
  );
}

let tree: ReactTestRenderer.ReactTestRenderer;
const flatten = (children: unknown): string =>
  Array.isArray(children)
    ? children.map(flatten).join('')
    : typeof children === 'string' || typeof children === 'number'
    ? String(children)
    : '';
const shownText = () =>
  tree.root
    .findAllByType(Text)
    .map(node => flatten(node.props.children))
    .join('\n');
const rows = () =>
  tree.root.findAll(
    node =>
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityHint === "Opens the agent's full chat",
    { deep: false },
  );

beforeEach(() => {
  jest.useFakeTimers();
  calls.length = 0;
  pages = [];
  mockRequest.mockImplementation(async (_base, path, parse) =>
    parse(serve(path)),
  );
});
afterEach(async () => {
  await act(async () => {
    tree?.unmount();
  });
  jest.useRealTimers();
});

test("a running workflow shows its agents under a done/total meter and opens one's chat", async () => {
  pages = [
    {
      agent: agents[0],
      prompt: 'Fix the UI',
      messages: [
        said('m1', 'Reading the panel', 1),
        said('m2', 'Now the tests', 2),
      ],
      total: 2,
      truncated: false,
      gap: false,
    },
    {
      agent: agents[0],
      prompt: 'Fix the UI',
      messages: [said('m3', 'Tests pass', 3)],
      total: 3,
      truncated: false,
      gap: false,
    },
  ];
  await act(async () => {
    tree = ReactTestRenderer.create(
      <AgentsSheet
        visible
        onClose={() => {}}
        tasks={{ wf1: workflow }}
        serverId="studio"
        sessionId="s1"
        baseUrl="http://studio"
        token="tok"
      />,
    );
  });
  expect(calls).toEqual(['/sessions/s1/tasks/wf1/agents']);
  expect(shownText()).toContain('1/2');
  expect(rows().map(row => row.props.accessibilityLabel)).toEqual([
    'fix:ui, running',
    'fix:core, completed',
  ]);
  const meter = tree.root.find(
    node => node.props.accessibilityRole === 'progressbar',
  );
  expect(meter.props.accessibilityValue).toEqual({ min: 0, max: 2, now: 1 });

  // Polled while the workflow runs.
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(calls.filter(path => path.endsWith('/agents'))).toHaveLength(2);

  await act(async () => rows()[0]!.props.onPress());
  expect(tree.root.findAllByType(WorkflowAgentChat)).toHaveLength(1);
  expect(calls.at(-1)).toBe('/sessions/s1/tasks/wf1/agents/a1/messages');
  expect(shownText()).toContain('Prompt from the workflow');
  expect(shownText()).toContain('Fix the UI');
  const contents = () =>
    tree.root
      .findAllByType(MessageBubble)
      .map(bubble => bubble.props.message.content);
  expect(contents()).toEqual(['Now the tests', 'Reading the panel']);
  // A workflow's agent can't be stopped on its own.
  expect(
    tree.root.findAll(
      node => node.props.accessibilityLabel === 'Stop this agent',
    ),
  ).toHaveLength(0);

  // The chat polls for what came after its newest message, and appends it.
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(calls).toContain(
    '/sessions/s1/tasks/wf1/agents/a1/messages?after_seq=2',
  );
  expect(contents()).toEqual([
    'Tests pass',
    'Now the tests',
    'Reading the panel',
  ]);
});

test('nothing is fetched while the sheet is hidden', async () => {
  await act(async () => {
    tree = ReactTestRenderer.create(
      <AgentsSheet
        visible={false}
        onClose={() => {}}
        tasks={{ wf1: workflow }}
        serverId="studio"
        sessionId="s1"
        baseUrl="http://studio"
        token="tok"
      />,
    );
  });
  await act(async () => {
    jest.advanceTimersByTime(9000);
  });
  expect(calls).toEqual([]);
});
