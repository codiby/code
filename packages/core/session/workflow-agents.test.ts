import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MAX_MESSAGES, agentStatus, clearWorkflowCaches, listWorkflowAgents, parseJournal, parseMeta, parseWorkflowLaunch,
  readWorkflowAgentMessages, resolveWorkflowDir, validateWorkflowDir,
} from './workflow-agents';
import type { ChatMessage } from './state';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'wf-agents-')));
const root = join(base, 'projects');
const session = join(root, '-Users-me-repo', 'sess-1');
const runDir = join(session, 'subagents', 'workflows', 'wf_ab12-cd3');
mkdirSync(runDir, { recursive: true });

afterAll(() => rmSync(base, { recursive: true, force: true }));
beforeEach(() => clearWorkflowCaches());

const launchText = (dir: string, runId = 'wf_ab12-cd3', taskId = 'wtask1') =>
  `Workflow launched in background. Task ID: ${taskId}\nSummary: Build things\nTranscript dir: ${dir}\nScript file: /x/y.js\nRun ID: ${runId}\n\nYou will be notified when it completes.`;

const result = (toolUseId: string, content: string): ChatMessage => ({
  id: `r-${toolUseId}`, role: 'assistant', content, timestamp: 1, isToolResult: true, toolUseId,
});

const wfTask = { taskId: 'wtask1', toolUseId: 'toolu_wf', taskType: 'local_workflow' };

describe('validateWorkflowDir', () => {
  test('accepts a run dir under the projects root and returns it resolved', () => {
    expect(validateWorkflowDir(runDir, root)).toBe(runDir);
    expect(validateWorkflowDir(`${runDir}/`, root)).toBe(runDir);
  });

  test('rejects relative paths, traversal and NUL bytes', () => {
    expect(validateWorkflowDir('projects/x/subagents/workflows/wf_ab12-cd3', root)).toBeNull();
    expect(validateWorkflowDir(`${session}/subagents/workflows/../workflows/wf_ab12-cd3`, root)).toBeNull();
    expect(validateWorkflowDir(`${root}/../../etc/subagents/workflows/wf_ab12-cd3`, root)).toBeNull();
    expect(validateWorkflowDir(`${runDir}\0`, root)).toBeNull();
    expect(validateWorkflowDir('', root)).toBeNull();
  });

  test('rejects dirs that are not a workflow run dir', () => {
    expect(validateWorkflowDir(session, root)).toBeNull();
    expect(validateWorkflowDir(join(session, 'subagents'), root)).toBeNull();
    const upper = join(session, 'subagents', 'workflows', 'wf_ABC');
    mkdirSync(upper, { recursive: true });
    expect(validateWorkflowDir(upper, root)).toBeNull();
    // Right shape, outside the root.
    const outside = join(base, 'elsewhere', 'subagents', 'workflows', 'wf_out1');
    mkdirSync(outside, { recursive: true });
    expect(validateWorkflowDir(outside, root)).toBeNull();
    // Missing.
    expect(validateWorkflowDir(join(session, 'subagents', 'workflows', 'wf_nope'), root)).toBeNull();
  });

  test('rejects a symlink that escapes the projects root', () => {
    const target = join(base, 'escape', 'subagents', 'workflows', 'wf_target');
    mkdirSync(target, { recursive: true });
    const link = join(session, 'subagents', 'workflows', 'wf_link1');
    symlinkSync(target, link);
    expect(validateWorkflowDir(link, root)).toBeNull();
    // A link whose target is not a run dir, even inside the root.
    const link2 = join(session, 'subagents', 'workflows', 'wf_link2');
    symlinkSync(session, link2);
    expect(validateWorkflowDir(link2, root)).toBeNull();
  });
});

describe('resolveWorkflowDir', () => {
  test('reads the dir from the Workflow tool result answering the task', () => {
    const messages = [result('toolu_other', launchText('/nope')), result('toolu_wf', launchText(runDir))];
    expect(resolveWorkflowDir('s1', wfTask, { messages, root })).toBe(runDir);
  });

  test('understands a result stored as content blocks', () => {
    const messages = [result('toolu_wf', JSON.stringify([{ type: 'text', text: launchText(runDir) }]))];
    expect(resolveWorkflowDir('s2', wfTask, { messages, root })).toBe(runDir);
  });

  test('falls back to the Task ID line when the task has no tool_use id', () => {
    const messages = [result('toolu_x', launchText(runDir, 'wf_ab12-cd3', 'other')), result('toolu_y', launchText(runDir))];
    expect(resolveWorkflowDir('s3', { ...wfTask, toolUseId: null }, { messages, root })).toBe(runDir);
    expect(resolveWorkflowDir('s3b', { ...wfTask, taskId: 'missing', toolUseId: null }, { messages, root })).toBeNull();
  });

  test('refuses a run id that does not match the dir, a bad dir, and non-workflow tasks', () => {
    expect(resolveWorkflowDir('s4', wfTask, { messages: [result('toolu_wf', launchText(runDir, 'wf_zzz'))], root })).toBeNull();
    expect(resolveWorkflowDir('s5', wfTask, { messages: [result('toolu_wf', launchText('/etc'))], root })).toBeNull();
    expect(resolveWorkflowDir('s6', { ...wfTask, taskType: 'local_agent' }, { messages: [result('toolu_wf', launchText(runDir))], root })).toBeNull();
    expect(resolveWorkflowDir('s7', wfTask, { messages: [], root })).toBeNull();
  });

  test('parseWorkflowLaunch picks the dir and run id', () => {
    expect(parseWorkflowLaunch(launchText('/a/b'))).toEqual({ dir: '/a/b', runId: 'wf_ab12-cd3' });
    expect(parseWorkflowLaunch('no dir here')).toBeNull();
  });
});

describe('journal and meta', () => {
  test('parses started and result lines in order, skipping junk', () => {
    const journal = [
      JSON.stringify({ type: 'launched' }),
      JSON.stringify({ type: 'started', key: 'k1', agentId: 'a1', label: 'build:core', phase: 'Build' }),
      '{not json',
      JSON.stringify({ type: 'started', key: 'k2', agentId: 'a2', label: 'build:ui', phase: 'Build' }),
      JSON.stringify({ type: 'started', agentId: '../evil', label: 'x' }),
      JSON.stringify({ type: 'result', agentId: 'a2', result: JSON.stringify({ summary: 'UI done' }) }),
      JSON.stringify({ type: 'result', agentId: 'a1', result: { summary: 'Core done', extra: 1 } }),
      '',
    ].join('\n');
    expect(parseJournal(journal)).toEqual([
      { agentId: 'a1', label: 'build:core', phase: 'Build', done: true, summary: 'Core done' },
      { agentId: 'a2', label: 'build:ui', phase: 'Build', done: true, summary: 'UI done' },
    ]);
  });

  test('a plain-text result is its own summary', () => {
    const [a] = parseJournal(JSON.stringify({ type: 'result', agentId: 'a9', result: 'just text' }));
    expect(a).toMatchObject({ agentId: 'a9', done: true, summary: 'just text', label: null });
  });

  test('meta gives the label and phase', () => {
    expect(parseMeta(JSON.stringify({ description: 'fix:ui', workflowPhase: 'Fix', agentType: 'workflow-subagent' }))).toEqual({ label: 'fix:ui', phase: 'Fix' });
    expect(parseMeta('oops')).toEqual({ label: null, phase: null });
  });

  test('status rules', () => {
    expect(agentStatus(true, true)).toBe('completed');
    expect(agentStatus(true, false)).toBe('completed');
    expect(agentStatus(false, true)).toBe('running');
    expect(agentStatus(false, false)).toBe('stopped');
  });
});

// --- Transcripts -------------------------------------------------------------

let n = 0;
const ts = (s: number) => new Date(Date.UTC(2026, 10, 12, 8, 0, s)).toISOString();
const userPrompt = (text: string, s = 0) => ({ type: 'user', uuid: `u${n++}`, parentUuid: null, timestamp: ts(s), message: { role: 'user', content: text } });
const assistant = (msgId: string, block: unknown, s: number, out = 10) => ({
  type: 'assistant', uuid: `u${n++}`, timestamp: ts(s), message: { id: msgId, role: 'assistant', model: 'claude-x', content: [block], usage: { output_tokens: out } },
});
const toolResult = (toolUseId: string, content: unknown, s: number, isError = false) => ({
  type: 'user', uuid: `u${n++}`, timestamp: ts(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
});
const jsonl = (entries: unknown[]) => entries.map(e => JSON.stringify(e)).join('\n') + '\n';

function makeRun(name: string): string {
  const dir = join(session, 'subagents', 'workflows', name);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

describe('listWorkflowAgents', () => {
  const dir = makeRun('wf_list1');
  writeFileSync(join(dir, 'journal.jsonl'), [
    JSON.stringify({ type: 'launched' }),
    JSON.stringify({ type: 'started', agentId: 'aaa1', label: 'review', phase: 'Review' }),
    JSON.stringify({ type: 'started', agentId: 'bbb2', label: 'build', phase: 'Build' }),
    JSON.stringify({ type: 'result', agentId: 'aaa1', result: { summary: 'Looks good' } }),
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'agent-aaa1.meta.json'), JSON.stringify({ description: 'review (meta)', workflowPhase: 'Review' }));
  writeFileSync(join(dir, 'agent-aaa1.jsonl'), jsonl([
    userPrompt('Review the code', 0),
    { type: 'api-request-blob', message: { content: [{ type: 'tool_use', id: 'x', name: 'Nope' }] } },
    assistant('m1', { type: 'thinking', thinking: 'hmm' }, 1, 30),
    assistant('m1', { type: 'text', text: 'Reading.' }, 1, 30),
    assistant('m1', { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a' } }, 2, 30),
    toolResult('toolu_1', 'file body', 3),
    { type: 'attachment', attachment: { x: 1 } },
    assistant('m2', { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'ls' } }, 4, 12),
    toolResult('toolu_2', [{ type: 'text', text: 'a\nb' }], 5),
    assistant('m3', { type: 'text', text: 'All   good\n\nthanks' }, 9, 5),
  ]));
  // Known only from its files (no journal line).
  writeFileSync(join(dir, 'agent-ccc3.meta.json'), JSON.stringify({ description: 'late', workflowPhase: 'Extra' }));
  // A symlinked transcript pointing outside the run is ignored.
  const secret = join(base, 'secret.jsonl');
  writeFileSync(secret, jsonl([assistant('s1', { type: 'tool_use', id: 't', name: 'Leak' }, 1)]));
  symlinkSync(secret, join(dir, 'agent-bbb2.jsonl'));

  test('folds journal, meta and transcript into one row per agent', async () => {
    const agents = await listWorkflowAgents(dir, 'running');
    expect(agents.map(a => a.agentId)).toEqual(['aaa1', 'bbb2', 'ccc3']);
    const [a, b, c] = agents;
    expect(a).toMatchObject({
      label: 'review', phase: 'Review', status: 'completed', toolUses: 2, outputTokens: 47,
      lastToolName: 'Bash', lastText: 'All good thanks', summary: 'Looks good',
      startedAt: Date.parse(ts(0)), endedAt: Date.parse(ts(9)),
    });
    expect(b).toMatchObject({ label: 'build', status: 'running', toolUses: 0, lastToolName: null, endedAt: null });
    expect(c).toMatchObject({ label: 'late', phase: 'Extra', status: 'running' });
    expect(typeof c!.startedAt).toBe('number');
  });

  test('agents without a result are stopped once the workflow is not running', async () => {
    const agents = await listWorkflowAgents(dir, 'completed');
    expect(agents.map(a => a.status)).toEqual(['completed', 'stopped', 'stopped']);
    expect((await listWorkflowAgents(dir, 'failed', { only: 'bbb2' })).map(a => a.agentId)).toEqual(['bbb2']);
  });
});

describe('readWorkflowAgentMessages', () => {
  test('maps the transcript like the bridge and pairs tool results', async () => {
    const dir = makeRun('wf_msgs1');
    writeFileSync(join(dir, 'agent-a1.jsonl'), jsonl([
      userPrompt('Do the thing', 0),
      assistant('m1', { type: 'thinking', thinking: 'plan' }, 1),
      assistant('m1', { type: 'tool_use', id: 'toolu_9', name: 'Grep', input: { pattern: 'x' } }, 2),
      toolResult('toolu_9', [{ type: 'text', text: 'hit' }, { type: 'image', source: { data: 'AAAA' } }], 3, true),
      { type: 'user', uuid: 'meta1', isMeta: true, timestamp: ts(4), message: { role: 'user', content: 'system note' } },
      { type: 'user', uuid: 'int1', timestamp: ts(5), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      assistant('m2', { type: 'redacted_thinking', data: 'zzz' }, 6),
      assistant('m2', { type: 'text', text: 'Done.' }, 7),
    ]));
    const res = (await readWorkflowAgentMessages(dir, 'a1'))!;
    expect(res.prompt).toBe('Do the thing');
    expect(res.total).toBe(6);
    expect(res.truncated).toBe(false);
    const [think, tool, out, interrupted, redacted, text] = res.messages;
    expect(think).toMatchObject({ role: 'assistant', isThinking: true, content: 'plan', seq: 1 });
    expect(think!.id).toMatch(/:0$/);
    expect(tool).toMatchObject({ id: 'toolu_9', toolName: 'Grep', toolInput: { pattern: 'x' }, content: 'Using tool: **Grep**' });
    expect(out).toMatchObject({ isToolResult: true, toolUseId: 'toolu_9', content: 'hit\n[image]', isError: true });
    expect(out!.toolUseId).toBe(tool!.id);
    expect(interrupted).toMatchObject({ role: 'user', content: '[Request interrupted by user]' });
    expect(redacted).toMatchObject({ isThinking: true, thinkingRedacted: true });
    expect(text).toMatchObject({ role: 'assistant', content: 'Done.', model: 'claude-x', timestamp: Date.parse(ts(7)) });
    // Ids are stable across a fresh read.
    clearWorkflowCaches();
    const again = (await readWorkflowAgentMessages(dir, 'a1'))!;
    expect(again.messages.map(m => m.id)).toEqual(res.messages.map(m => m.id));
  });

  test('reads only what was appended, waits for a half-written line, and restarts on a rewrite', async () => {
    const dir = makeRun('wf_grow1');
    const file = join(dir, 'agent-g1.jsonl');
    writeFileSync(file, jsonl([userPrompt('go', 0), assistant('m1', { type: 'text', text: 'one' }, 1)]));
    const first = (await readWorkflowAgentMessages(dir, 'g1'))!;
    expect(first.messages.map(m => m.content)).toEqual(['one']);

    const next = JSON.stringify(assistant('m2', { type: 'text', text: 'two' }, 2));
    appendFileSync(file, next.slice(0, 20));
    const partial = (await readWorkflowAgentMessages(dir, 'g1', { afterSeq: 1 }))!;
    expect(partial.messages).toEqual([]);
    appendFileSync(file, `${next.slice(20)}\n`);
    const grown = (await readWorkflowAgentMessages(dir, 'g1', { afterSeq: 1 }))!;
    expect(grown.messages.map(m => [m.seq, m.content])).toEqual([[2, 'two']]);
    expect(grown.total).toBe(2);

    // A final entry without its newline is taken once it parses.
    appendFileSync(file, JSON.stringify(assistant('m3', { type: 'text', text: 'three' }, 3)));
    expect((await readWorkflowAgentMessages(dir, 'g1', { afterSeq: 2 }))!.messages.map(m => m.content)).toEqual(['three']);

    truncateSync(file, 0);
    writeFileSync(file, jsonl([userPrompt('again', 0), assistant('m9', { type: 'text', text: 'fresh' }, 1)]));
    const rewritten = (await readWorkflowAgentMessages(dir, 'g1'))!;
    expect(rewritten.messages.map(m => m.content)).toEqual(['fresh']);
    expect(rewritten.prompt).toBe('again');
  });

  test('serves only the newest messages and says so', async () => {
    const dir = makeRun('wf_big1');
    const entries: unknown[] = [userPrompt('big', 0)];
    for (let i = 0; i < MAX_MESSAGES + 150; i++) entries.push(assistant(`m${i}`, { type: 'text', text: `t${i}` }, 1));
    writeFileSync(join(dir, 'agent-b1.jsonl'), jsonl(entries));
    const res = (await readWorkflowAgentMessages(dir, 'b1'))!;
    expect(res.messages.length).toBe(MAX_MESSAGES);
    expect(res.total).toBe(MAX_MESSAGES + 150);
    expect(res.truncated).toBe(true);
    expect(res.messages.at(-1)!.content).toBe(`t${MAX_MESSAGES + 149}`);
    // Asking from before the kept window is a gap: the client replaces.
    const gap = (await readWorkflowAgentMessages(dir, 'b1', { afterSeq: 10 }))!;
    expect(gap.gap).toBe(true);
    expect(gap.messages.length).toBe(MAX_MESSAGES);
  });

  test('refuses bad ids, missing agents and symlinked transcripts', async () => {
    const dir = makeRun('wf_safe1');
    const outside = join(base, 'outside.jsonl');
    writeFileSync(outside, jsonl([assistant('m', { type: 'text', text: 'secret' }, 1)]));
    symlinkSync(outside, join(dir, 'agent-s1.jsonl'));
    expect(await readWorkflowAgentMessages(dir, 's1')).toBeNull();
    expect(await readWorkflowAgentMessages(dir, '../../outside')).toBeNull();
    expect(await readWorkflowAgentMessages(dir, 'nobody')).toBeNull();
  });

  test('long tool output and inputs are cut', async () => {
    const dir = makeRun('wf_cut1');
    writeFileSync(join(dir, 'agent-c1.jsonl'), jsonl([
      userPrompt('cut', 0),
      assistant('m1', { type: 'tool_use', id: 'toolu_w', name: 'Write', input: { file_path: '/f', content: 'x'.repeat(50_000) } }, 1),
      toolResult('toolu_w', 'y'.repeat(50_000), 2),
    ]));
    const res = (await readWorkflowAgentMessages(dir, 'c1'))!;
    const input = res.messages[0]!.toolInput as { content: string; file_path: string };
    expect(input.file_path).toBe('/f');
    expect(input.content.length).toBeLessThan(21_000);
    expect(res.messages[1]!.content.length).toBeLessThan(21_000);
    expect(res.messages[1]!.content).toContain('more characters]');
  });
});
