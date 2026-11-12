import {
  AGENT_SESSION_ID,
  openTargetOf,
  parsePushData,
  toNotificationData,
} from '../src/push/payload';

// The exact `data` the bridge sends (packages/core/agent/push/messages.ts).
const approvalData = {
  host: 'ryzen9',
  sessionId: 'coding-1',
  sessionName: 'api',
  sentAt: '1700000000000',
  type: 'approval',
  requestId: 'toolu_01ABC',
  code: '4821',
  toolName: 'Bash',
  title: 'Approval needed · api',
  body: 'Bash\nbun test\nCode 4821',
  priority: 'urgent',
  channel: 'approvals',
  expiresAt: '1700000600000',
};

test('reads an approval push', () => {
  expect(parsePushData(approvalData)).toEqual({
    type: 'approval',
    requestId: 'toolu_01ABC',
    code: '4821',
    title: 'Approval needed · api',
    body: 'Bash\nbun test\nCode 4821',
    toolName: 'Bash',
    question: false,
    host: 'ryzen9',
    sessionId: 'coding-1',
    sessionName: 'api',
    expiresAt: 1700000600000,
  });
});

test('reads resolutions and notifications', () => {
  expect(
    parsePushData({
      type: 'approval_resolved',
      requestId: 'r1',
      allow: 'true',
      via: 'telegram',
      host: 'ryzen9',
    }),
  ).toEqual({
    type: 'approval_resolved',
    requestId: 'r1',
    allow: true,
    via: 'telegram',
    host: 'ryzen9',
  });

  const notify = parsePushData({
    type: 'notify',
    title: 'Reminder',
    body: 'Call Ana',
    host: 'ryzen9',
    sessionId: '',
    sessionName: '',
    priority: 'normal',
    quiet: 'true',
    channel: 'messages_quiet',
  });
  expect(notify).toMatchObject({
    type: 'notify',
    quiet: true,
    channel: 'messages_quiet',
    sessionId: '',
  });
  // A test push has no session: tapping it opens the agent's chat.
  expect(openTargetOf(notify!)).toEqual({
    host: 'ryzen9',
    sessionId: AGENT_SESSION_ID,
  });
});

test('drops what does not fit the contract', () => {
  expect(parsePushData(null)).toBeNull();
  expect(parsePushData({ type: 'something-else' })).toBeNull();
  expect(parsePushData({ ...approvalData, requestId: '' })).toBeNull();
  expect(
    parsePushData({ ...approvalData, requestId: '../../agent/config' }),
  ).toBeNull();
  // An unknown channel falls back to the regular one instead of a missing channel.
  expect(
    parsePushData({ type: 'notify', body: 'x', channel: 'nope' }),
  ).toMatchObject({ channel: 'messages' });
});

test('survives the round trip through notification data', () => {
  const push = parsePushData(approvalData)!;
  expect(parsePushData(toNotificationData(push))).toEqual(push);
  expect(openTargetOf(push)).toEqual({ host: 'ryzen9', sessionId: 'coding-1' });
});
