import { afterAll, beforeAll, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { importCodexThread, listCodexThreads, parseCodexRollout, setCodexHome } from './codex-import';
import { addMessage, getSessionState } from './state';
import { sessions } from './sessions';

const THREAD = '01a0ef01-1555-7763-8794-4569b601aaa0';
let home = '';
let rollout = '';

const line = (type: string, payload: object, timestamp = '2026-09-29T21:10:40.000Z') => JSON.stringify({ timestamp, type, payload });
const item = (turn: string, it: object, timestamp?: string) => line('event_msg', { type: 'item_completed', turn_id: turn, item: it }, timestamp);

const firstTurn = [
  line('session_meta', { id: THREAD, cwd: '/r/fw', originator: 'codex-tui', timestamp: '2026-09-29T21:10:20.000Z' }),
  line('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'system stuff' }] }),
  item('t1', { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'descompila el firmware' }] }),
  item('t1', { type: 'Reasoning', id: 'r1', summary_text: ['Looking at files'] }),
  item('t1', { type: 'Reasoning', id: 'r2', summary_text: [] }),
  item('t1', { type: 'CommandExecution', id: 'c1', command: ['/bin/zsh', '-lc', 'ls'], cwd: 'file:///r/fw', aggregated_output: 'a.bin\n', exit_code: 0, status: 'completed' }),
  item('t1', { type: 'CommandExecution', id: 'c2', command: ['/bin/zsh', '-lc', 'false'], aggregated_output: '', exit_code: 1, status: 'completed' }),
  item('t1', { type: 'FileChange', id: 'f1', changes: { '/r/fw/a.c': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b\n' } }, status: 'completed' }),
  item('t1', { type: 'McpToolCall', id: 'm1', server: 'srv', tool: 'ping', arguments: { x: 1 }, result: { content: [{ type: 'text', text: 'pong' }] }, status: 'completed' }),
  item('t1', { type: 'ContextCompaction', id: 'cc1' }),
  item('t1', { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'Listo.' }] }),
].join('\n') + '\n';

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'codex-home-'));
  const dir = join(home, 'sessions', '2026', '09', '29');
  mkdirSync(dir, { recursive: true });
  rollout = join(dir, `rollout-2026-09-29T14-10-20-${THREAD}.jsonl`);
  writeFileSync(rollout, firstTurn);
  writeFileSync(join(home, 'session_index.jsonl'), `${JSON.stringify({ id: THREAD, thread_name: 'hola' })}\n${JSON.stringify({ id: THREAD, thread_name: 'Descompilar firmware' })}\n`);
  setCodexHome(home);
});

afterAll(() => {
  setCodexHome(null);
  rmSync(home, { recursive: true, force: true });
});

test('maps rollout items to the rows the live Codex adapter writes', () => {
  const { meta, turns } = parseCodexRollout(firstTurn);
  expect(meta.cwd).toBe('/r/fw');
  const msgs = turns.flatMap(t => t.messages);
  expect(msgs.map(m => m.id)).toEqual(['u1', 'r1', 'c1', 'c1:result', 'c2', 'c2:result', 'f1', 'f1:result', 'm1', 'm1:result', 'a1']);
  expect(msgs[0]).toMatchObject({ role: 'user', content: 'descompila el firmware' });
  expect(msgs[1]).toMatchObject({ isThinking: true, content: 'Looking at files' });
  expect(msgs[2]).toMatchObject({ toolName: 'Bash', toolInput: { command: 'ls', cwd: '/r/fw' } });
  expect(msgs[3]).toMatchObject({ isToolResult: true, toolUseId: 'c1', content: 'a.bin\n\n[exit 0]', isError: false });
  expect(msgs[5]).toMatchObject({ isError: true });
  expect(msgs[6]).toMatchObject({ toolName: 'CodexEdit', toolInput: { changes: [{ path: '/r/fw/a.c', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' }] } });
  expect(msgs[8]).toMatchObject({ toolName: 'srv__ping' });
  expect(msgs[10]).toMatchObject({ role: 'assistant', content: 'Listo.' });
});

test('lists terminal threads with their Codex name', () => {
  const [thread] = listCodexThreads();
  expect(thread).toMatchObject({ id: THREAD, name: 'Descompilar firmware', cwd: '/r/fw', originator: 'codex-tui', sessionId: null });
});

test('imports a thread as a stopped Codex session that resumes it', () => {
  const result = importCodexThread(THREAD, { permissionMode: 'default' })!;
  expect(result.created).toBe(true);
  expect(result.added).toHaveLength(11);
  expect(result.session).toMatchObject({ provider: 'codex', claudeSessionId: THREAD, cwd: '/r/fw', name: 'Descompilar firmware', runtimeStatus: 'stopped' });
  expect(listCodexThreads()[0]!.sessionId).toBe(result.session.id);
});

test('re-importing adds only console turns, not the ones run from the app', () => {
  const session = [...sessions.values()].find(s => s.claudeSessionId === THREAD)!;
  // A turn sent from the app: stored with app ids, then written to the rollout by Codex.
  addMessage(session.id, { id: 'app-1', role: 'user', content: 'ahora en C', timestamp: Date.parse('2026-09-29T22:00:00.000Z') });
  appendFileSync(rollout, [
    item('t2', { type: 'UserMessage', id: 'u2', content: [{ type: 'text', text: 'ahora en C' }] }, '2026-09-29T22:00:01.000Z'),
    item('t2', { type: 'AgentMessage', id: 'a2', content: [{ type: 'Text', text: 'hecho' }] }, '2026-09-29T22:00:05.000Z'),
    item('t3', { type: 'UserMessage', id: 'u3', content: [{ type: 'text', text: 'desde la consola' }] }, '2026-09-29T23:00:00.000Z'),
    item('t3', { type: 'AgentMessage', id: 'a3', content: [{ type: 'Text', text: 'ok' }] }, '2026-09-29T23:00:05.000Z'),
  ].join('\n') + '\n');

  const result = importCodexThread(THREAD, { permissionMode: 'default' })!;
  expect(result.created).toBe(false);
  expect(result.session.id).toBe(session.id);
  expect(result.added.map(m => m.id)).toEqual(['u3', 'a3']);
  expect(getSessionState(session.id).messages.filter(m => m.content === 'ahora en C')).toHaveLength(1);
});

test('unknown thread returns null', () => {
  expect(importCodexThread('nope', { permissionMode: 'default' })).toBeNull();
});
