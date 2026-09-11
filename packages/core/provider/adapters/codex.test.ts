import { expect, test } from 'bun:test';
import { CodexAdapter, buildCodexConfig, codexPermissions } from './codex';
import { listCodexModels, type CodexHandlers } from '../codex-app-server';
import type { ProviderEvents, SpawnOptions } from '../types';
const opts: SpawnOptions = { sessionId: 'test', cwd: '/tmp', model: null, permissionMode: 'default', effort: 'high' };
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
function harness(options = opts, startup = Promise.resolve()) {
  const calls: any[] = [], output: any[] = [];
  let handlers!: CodexHandlers;
  let turn = 0;
  const approval = Promise.withResolvers<any>();
  const connection = {
    ready: startup,
    async request(method: string, params: any): Promise<any> {
      calls.push({ method, params });
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread' }, model: 'model-default' };
      if (method === 'model/list') return { data: [{ id: 'model-default', model: 'model-default', displayName: 'Default model', isDefault: true }], nextCursor: null };
      if (method === 'turn/start') return { turn: { id: String(++turn) } };
      return {};
    },
    async close() {},
  };
  const events = new Proxy({}, { get: (_, key) => (...args: any[]) => {
    output.push({ event: key, args });
    if (key === 'onPermissionRequest') return approval.promise;
  } }) as ProviderEvents;
  const session = new CodexAdapter(h => { handlers = h; return connection; }).spawn(options, events);
  const notify = (method: string, params: any) => handlers.notification(method, { threadId: 'thread', turnId: String(turn), ...params });
  const complete = (status = 'completed') => notify('turn/completed', { turn: { id: String(turn), status } });
  return { session, calls, output, notify, complete, approval, get handlers() { return handlers; } };
}
test('normal mode supports interactive approvals and bypass remains explicit', () => {
  expect(codexPermissions('default', '/tmp').approvalPolicy).toBe('on-request');
  expect(codexPermissions('plan', '/tmp').sandboxPolicy.type).toBe('readOnly');
  expect(codexPermissions('bypassPermissions', '/tmp').approvalPolicy).toBe('never');
});
test('streams and finishes once; applies model and permissions on the same thread', async () => {
  const h = harness();
  await h.session.sendUserMessage({ text: 'first' }); await settle();
  h.notify('item/agentMessage/delta', { itemId: 'a', delta: 'Hello' });
  h.notify('item/completed', { item: { id: 'a', type: 'agentMessage', text: 'Hello' } });
  h.complete(); await settle();
  expect(h.output.filter(x => x.event === 'onAssistantText')[0].args[0]).toBe('Hello');
  expect(h.output.filter(x => x.event === 'onTurnComplete')).toHaveLength(1);
  await h.session.setModel('chosen'); await h.session.setPermissionMode('plan');
  await h.session.sendUserMessage({ text: 'second' }); await settle();
  const turns = h.calls.filter(x => x.method === 'turn/start');
  expect(turns[0].params.effort).toBe('high');
  expect(turns[1].params).toMatchObject({ threadId: 'thread', model: 'chosen', approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } });
  h.complete(); await settle(); await h.session.close();
});
test('MCP approval waits for the user and supports acceptance and denial', async () => {
  for (const allow of [true, false]) {
    const h = harness(); await h.session.sendUserMessage({ text: 'ping' }); await settle();
    let resolved = false;
    const answer = h.handlers.request('mcpServer/elicitation/request', { threadId: 'thread', turnId: '1', mode: 'form', message: 'Allow ping?', requestedSchema: { type: 'object', properties: {} } }).then(value => { resolved = true; return value; });
    await settle(); expect(resolved).toBe(false);
    expect(h.output.find(x => x.event === 'onPermissionRequest').args[0].description).toBe('Allow ping?');
    h.approval.resolve({ allow });
    expect(await answer).toEqual({ action: allow ? 'accept' : 'decline', content: null, _meta: null });
    h.complete(); await settle(); await h.session.close();
  }
});
test('command approvals return a one-time decision; stale approvals are denied', async () => {
  const h = harness(); await h.session.sendUserMessage({ text: 'command' }); await settle();
  const answer = h.handlers.request('item/commandExecution/requestApproval', { threadId: 'thread', turnId: '1', command: 'pwd' });
  await settle(); await h.session.interrupt(); h.approval.resolve({ allow: true });
  expect(await answer).toEqual({ decision: 'decline' });
  h.complete('interrupted'); await settle(); await h.session.close();
});
test('serializes interrupted turns and ignores their late text', async () => {
  const h = harness(); await h.session.sendUserMessage({ text: 'old' }); await settle();
  await h.session.sendUserMessage({ text: 'new' }); await settle();
  expect(h.calls.filter(x => x.method === 'turn/start')).toHaveLength(1);
  h.notify('item/completed', { item: { id: 'old', type: 'agentMessage', text: 'stale' } });
  h.complete('interrupted'); await settle();
  expect(h.calls.filter(x => x.method === 'turn/start')).toHaveLength(2);
  h.notify('item/completed', { item: { id: 'new', type: 'agentMessage', text: 'fresh' } }); h.complete(); await settle();
  expect(h.output.filter(x => x.event === 'onAssistantText').map(x => x.args[0])).toEqual(['fresh']);
  expect(h.output.filter(x => x.event === 'onTurnComplete')).toHaveLength(1);
  await h.session.close();
});
test('startup failure is reported once and does not leave a waiting turn', async () => {
  const startup = Promise.withResolvers<void>(); const h = harness(opts, startup.promise);
  await h.session.sendUserMessage({ text: 'hello' }); startup.reject(new Error('Cannot initialize')); await settle();
  expect(h.output.filter(x => x.event === 'onError')).toHaveLength(1);
  expect(h.output.filter(x => x.event === 'onExit')).toHaveLength(1);
  await h.session.close();
});
test('connection death reports a visible error and releases the turn', async () => {
  const h = harness(); await h.session.sendUserMessage({ text: 'hello' }); await settle();
  h.handlers.exit(new Error('Runtime exited')); await settle();
  expect(h.output.filter(x => x.event === 'onError')).toHaveLength(1);
  expect(h.output.filter(x => x.event === 'onTurnComplete')).toHaveLength(0);
  await h.session.close();
});
test('resume uses saved thread and model/list handles pagination and hidden models', async () => {
  const h = harness({ ...opts, resumeSessionId: 'saved' }); await settle();
  expect(h.calls[0]).toMatchObject({ method: 'thread/resume', params: { threadId: 'saved', excludeTurns: true } });
  await h.session.close();
  const cursors: any[] = [];
  const models = await listCodexModels({ ready: Promise.resolve(), async close() {}, async request(_method: string, params: any): Promise<any> {
    cursors.push(params.cursor);
    return params.cursor ? { data: [{ model: 'second' }], nextCursor: null } : { data: [{ model: 'first' }, { model: 'hidden', hidden: true }], nextCursor: 'page2' };
  } });
  expect(cursors).toEqual([null, 'page2']); expect(models.map(m => m.model)).toEqual(['first', 'second']);
});
test('MCP configuration preserves session headers, timeouts, and stdio servers', () => {
  expect(buildCodexConfig({
    codiby: { type: 'http', url: 'http://localhost/mcp', headers: { 'x-session-id': 'test' }, timeoutMs: 86400000 },
    local: { type: 'stdio', command: 'test-mcp', args: ['--flag'], env: { KEY: 'value' } },
    internal: { type: 'sdk', server: {} },
  })).toEqual({ mcp_servers: {
    codiby: { url: 'http://localhost/mcp', http_headers: { 'x-session-id': 'test' }, tool_timeout_sec: 86400 },
    local: { command: 'test-mcp', args: ['--flag'], env: { KEY: 'value' } },
  } });
});


test('questions return answers keyed by protocol id and MCP forms preserve field types', async () => {
  for (const form of [false, true]) {
    const h = harness(); await h.session.sendUserMessage({ text: 'ask' }); await settle();
    const answer = h.handlers.request(form ? 'mcpServer/elicitation/request' : 'item/tool/requestUserInput', {
      threadId: 'thread', turnId: '1',
      ...(form ? { requestedSchema: { properties: { count: { type: 'integer', description: 'How many?' } } } } : { questions: [{ id: 'count-id', header: 'Count', question: 'How many?', options: [] }] }),
    });
    await settle(); h.approval.resolve({ allow: true, updatedInput: { answers: { 'How many?': '3' } } });
    expect(await answer).toEqual(form ? { action: 'accept', content: { count: 3 }, _meta: null } : { answers: { 'count-id': { answers: ['3'] } } });
    h.complete(); await settle(); await h.session.close();
  }
});
test('stop during initialization completes without starting a turn and permits retry', async () => {
  const ready = Promise.withResolvers<void>(), h = harness(opts, ready.promise);
  await h.session.sendUserMessage({ text: 'cancel' });
  const stopped = h.session.interrupt(); ready.resolve(); await stopped; await settle();
  expect(h.calls.filter(x => x.method === 'turn/start')).toHaveLength(0);
  expect(h.output.find(x => x.event === 'onTurnComplete').args[0].stopReason).toBe('interrupted');
  await h.session.sendUserMessage({ text: 'retry' }); await settle(); h.complete(); await settle();
  expect(h.output.filter(x => x.event === 'onTurnComplete')).toHaveLength(2);
  await h.session.close();
});

test('compaction has explicit start/end events and ignores other or cancelled turns', async () => {
  const h = harness();
  await h.session.sendUserMessage({ text: 'Continue' }); await settle();
  const states = () => h.output.filter(x => x.event === 'onCompaction').map(x => x.args[0]);
  h.notify('item/started', { item: { id: 'compact', type: 'contextCompaction' }, threadId: 'other' });
  expect(states()).toEqual([false]);
  h.notify('item/started', { item: { id: 'compact', type: 'contextCompaction' } });
  expect(states().at(-1)).toBe(true);
  h.notify('item/completed', { item: { id: 'compact', type: 'contextCompaction' } });
  expect(states().at(-1)).toBe(false);
  h.notify('item/started', { item: { id: 'compact-2', type: 'contextCompaction' } });
  await h.session.interrupt();
  expect(states().at(-1)).toBe(false);
  h.notify('item/started', { item: { id: 'late', type: 'contextCompaction' } });
  expect(states().at(-1)).toBe(false);
  h.complete('interrupted'); await settle(); await h.session.close();
});

test('turn completion clears compaction even when its item-completed event is absent', async () => {
  const h = harness(); await h.session.sendUserMessage({ text: 'Continue' }); await settle();
  h.notify('item/started', { item: { id: 'compact', type: 'contextCompaction' } });
  h.complete(); await settle();
  expect(h.output.filter(x => x.event === 'onCompaction').at(-1)?.args[0]).toBe(false);
  await h.session.close();
});
