/**
 * The agents inside a workflow, for the Agents panel.
 *
 * The Claude Agent SDK reports a Workflow tool run as a single task: its
 * task_progress names the inner agent that just acted (`last_tool_name`), and
 * no message stamped with an inner agent's id ever reaches the bridge. What
 * those agents did lives only on disk, in the run's transcript dir — the
 * Workflow tool's result names it ("Transcript dir: …", "Run ID: wf_…"):
 *
 *   journal.jsonl          {type:'launched'} / {type:'started', agentId, label, phase}
 *                          / {type:'result', agentId, result}
 *   agent-<id>.meta.json   {description: label, workflowPhase, …}
 *   agent-<id>.jsonl       the agent's own SDK transcript
 *
 * The transcripts are read in file order. The SDK's getSubagentMessages()
 * follows `parentUuid` and, for these files, keeps about one message in ten.
 * They are append-only and reach tens of MB, so each one is read
 * incrementally: a cursor remembers how far it got and only parses what was
 * appended since — the panel polls every few seconds while a workflow runs.
 */

import { open, readdir, readFile, stat } from 'fs/promises';
import { realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'path';
import type { ChatMessage } from './state';
import type { SubagentTask, SubagentTaskStatus } from '../provider/types';

export type WorkflowAgentStatus = 'running' | 'completed' | 'stopped';

export interface WorkflowAgent {
  agentId: string;
  label: string;
  phase: string | null;
  status: WorkflowAgentStatus;
  startedAt: number | null;
  endedAt: number | null;
  toolUses: number;
  outputTokens: number;
  lastToolName: string | null;
  /** Its latest plain text, one line, for the row. */
  lastText: string | null;
  /** What it returned to the workflow (the journal's result), once done. */
  summary: string | null;
}

export interface WorkflowAgentMessages {
  /** The brief the workflow gave the agent — its first user message, kept out of `messages`. */
  prompt: string | null;
  messages: ChatMessage[];
  /** Messages the transcript holds in all; `seq` runs 1…total. */
  total: number;
  /** Older messages were left out: only the newest MAX_MESSAGES are served. */
  truncated: boolean;
  /** `afterSeq` was older than what is kept: replace instead of appending. */
  gap: boolean;
}

/** The most messages one response carries (and one cursor keeps). */
export const MAX_MESSAGES = 2000;
/** Tool output past this is cut: a screenshot or a file dump would dwarf the chat. */
const MAX_TOOL_RESULT_CHARS = 20_000;
const MAX_TEXT_CHARS = 60_000;
const MAX_INPUT_STRING_CHARS = 20_000;
const MAX_SUMMARY_CHARS = 8_000;
const LAST_TEXT_CHARS = 240;

const WORKFLOW_DIR_RE = /\/subagents\/workflows\/wf_[a-z0-9-]+$/;
/** Ids end up in file names: anything else is refused before it touches a path. */
const AGENT_ID_RE = /^[A-Za-z0-9]{1,64}$/;

// ---------------------------------------------------------------------------
// Where the run's files are
// ---------------------------------------------------------------------------

/** ~/.claude/projects, or the SDK's CLAUDE_CONFIG_DIR override. */
export function claudeProjectsRoot(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects');
}

/** A tool_result's text: the bridge stores block arrays as their JSON. */
function resultText(content: string): string {
  const trimmed = content.trimStart();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const blocks = Array.isArray(parsed) ? parsed : [parsed];
      const texts = blocks
        .map(b => (typeof b === 'string' ? b : b && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
        .filter(Boolean);
      if (texts.length) return texts.join('\n');
    } catch { /* Plain text that happens to start with a bracket. */ }
  }
  return content;
}

/** The dir and run id the Workflow tool's result announces. */
export function parseWorkflowLaunch(content: string): { dir: string; runId: string | null } | null {
  const text = resultText(content);
  const dir = /^Transcript dir: (.+?)\s*$/m.exec(text)?.[1];
  if (!dir) return null;
  const runId = /^Run ID: (wf_[a-z0-9-]+)\s*$/m.exec(text)?.[1] ?? null;
  return { dir, runId };
}

/**
 * The dir, resolved, if it is a workflow transcript dir inside the Claude
 * projects root; null for anything else. The path comes out of a tool
 * result, so it is checked both as written and after symlinks resolve.
 */
export function validateWorkflowDir(candidate: string, root = claudeProjectsRoot()): string | null {
  if (!candidate || candidate.includes('\0') || !isAbsolute(candidate)) return null;
  if (candidate.split(/[\\/]/).includes('..')) return null;
  const lexical = normalize(candidate).replace(/\/+$/, '');
  if (!WORKFLOW_DIR_RE.test(lexical)) return null;
  let real: string;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(lexical);
    if (!statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  if (!real.startsWith(realRoot + sep)) return null;
  if (!WORKFLOW_DIR_RE.test(real)) return null;
  return real;
}

/** Tool results never change, so a resolved dir is good for the task's lifetime. */
const resolvedDirs = new Map<string, string>();

/**
 * The transcript dir of a workflow task, from the Workflow tool's result in
 * the session's messages: the one answering the task's tool_use, or — when
 * the SDK did not say which tool_use started it — the one naming its task id.
 */
export function resolveWorkflowDir(
  sessionId: string,
  task: Pick<SubagentTask, 'taskId' | 'toolUseId' | 'taskType'>,
  opts: { messages: ChatMessage[]; root?: string },
): string | null {
  if (task.taskType !== 'local_workflow') return null;
  const key = `${sessionId}\0${task.taskId}`;
  const cached = resolvedDirs.get(key);
  if (cached) return cached;

  // "Workflow launched in background. Task ID: <id>" — mid-line, so no anchor.
  const taskIdLine = new RegExp(`\\bTask ID: ${task.taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
  const { messages } = opts;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (!m.isToolResult || typeof m.content !== 'string' || !m.content.includes('Transcript dir:')) continue;
    const matches = task.toolUseId ? m.toolUseId === task.toolUseId : taskIdLine.test(resultText(m.content));
    if (!matches) continue;
    const launch = parseWorkflowLaunch(m.content);
    if (!launch) return null;
    const dir = validateWorkflowDir(launch.dir, opts.root);
    if (!dir) return null;
    if (launch.runId && basename(dir) !== launch.runId) return null;
    if (resolvedDirs.size >= 500) resolvedDirs.delete(resolvedDirs.keys().next().value!);
    resolvedDirs.set(key, dir);
    return dir;
  }
  return null;
}

/** Test hook: forget resolved dirs. */
export function clearWorkflowCaches(): void {
  resolvedDirs.clear();
  cursors.clear();
  smallFiles.clear();
}

// ---------------------------------------------------------------------------
// journal.jsonl and agent-<id>.meta.json
// ---------------------------------------------------------------------------

export interface JournalAgent {
  agentId: string;
  label: string | null;
  phase: string | null;
  /** A `result` line arrived: the agent finished and handed back its result. */
  done: boolean;
  summary: string | null;
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more characters]` : text;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** The journal's `result` is the agent's structured output — an object, or its JSON. */
function summaryOf(result: unknown): string | null {
  let value = result;
  if (typeof value === 'string') {
    const text = value;
    try { value = JSON.parse(text); } catch { return str(text) ? cap(text, MAX_SUMMARY_CHARS) : null; }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const summary = str((value as Record<string, unknown>).summary);
    if (summary) return cap(summary, MAX_SUMMARY_CHARS);
  }
  if (value === null || value === undefined) return null;
  return cap(typeof value === 'string' ? value : JSON.stringify(value, null, 2), MAX_SUMMARY_CHARS);
}

/** Agents in the order the journal started them. Unknown and malformed lines are skipped. */
export function parseJournal(text: string): JournalAgent[] {
  const byId = new Map<string, JournalAgent>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object') continue;
    const agentId = str(entry.agentId);
    if (!agentId || !AGENT_ID_RE.test(agentId)) continue;
    const agent = byId.get(agentId) ?? { agentId, label: null, phase: null, done: false, summary: null };
    if (entry.type === 'started') {
      agent.label = agent.label ?? str(entry.label);
      agent.phase = agent.phase ?? str(entry.phase);
    } else if (entry.type === 'result') {
      agent.done = true;
      agent.summary = summaryOf(entry.result);
    } else {
      continue;
    }
    byId.set(agentId, agent);
  }
  return [...byId.values()];
}

export function parseMeta(text: string): { label: string | null; phase: string | null } {
  try {
    const meta = JSON.parse(text) as Record<string, unknown>;
    return { label: str(meta.description), phase: str(meta.workflowPhase) };
  } catch {
    return { label: null, phase: null };
  }
}

/**
 * A file in `dir`, resolved, only if it really is a regular file in it: a
 * symlink planted in the run dir must not lead the reader anywhere else.
 */
function fileIn(dir: string, name: string): string | null {
  try {
    const real = realpathSync(join(dir, name));
    if (dirname(real) !== dir || !statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

type SmallFile = { size: number; mtimeMs: number; value: unknown };
const smallFiles = new Map<string, SmallFile>();

/** Small files (journal, meta) re-read only when their size or mtime moved. */
async function readCached<T>(path: string, parse: (text: string) => T): Promise<{ value: T; mtimeMs: number } | null> {
  let st;
  try { st = await stat(path); } catch { return null; }
  const hit = smallFiles.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return { value: hit.value as T, mtimeMs: st.mtimeMs };
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { return null; }
  const value = parse(text);
  if (smallFiles.size >= 1024) smallFiles.delete(smallFiles.keys().next().value!);
  smallFiles.set(path, { size: st.size, mtimeMs: st.mtimeMs, value });
  return { value, mtimeMs: st.mtimeMs };
}

// ---------------------------------------------------------------------------
// agent-<id>.jsonl — the transcript, read incrementally
// ---------------------------------------------------------------------------

interface Cursor {
  path: string;
  size: number;
  mtimeMs: number;
  /** Bytes parsed so far — always at a line boundary. */
  offset: number;
  /** Stats-only cursors (the list) skip building messages. */
  keepMessages: boolean;
  messages: ChatMessage[];
  seq: number;
  prompt: string | null;
  toolUses: number;
  outputTokens: number;
  lastToolName: string | null;
  lastText: string | null;
  firstTs: number | null;
  lastTs: number | null;
  /** One API response is split into one entry per block, each with the whole response's usage. */
  usageMsgId: string | null;
  usageTokens: number;
  lines: number;
  busy: Promise<void> | null;
}

/** All cursors, least recently used first. */
const cursors = new Map<string, Cursor>();
const MAX_CURSORS = 256;
/** Cursors holding messages are the heavy ones; past this the oldest drop theirs. */
const MAX_MESSAGE_CURSORS = 8;

function newCursor(path: string, keepMessages: boolean): Cursor {
  return {
    path, size: -1, mtimeMs: -1, offset: 0, keepMessages, messages: [], seq: 0, prompt: null,
    toolUses: 0, outputTokens: 0, lastToolName: null, lastText: null, firstTs: null, lastTs: null,
    usageMsgId: null, usageTokens: 0, lines: 0, busy: null,
  };
}

function cursorFor(path: string, keepMessages: boolean): Cursor {
  let c = cursors.get(path);
  // A stats-only cursor never kept the messages it read past: start over.
  if (!c || (keepMessages && !c.keepMessages)) c = newCursor(path, keepMessages);
  cursors.delete(path);
  cursors.set(path, c);
  if (cursors.size > MAX_CURSORS) cursors.delete(cursors.keys().next().value!);
  if (keepMessages) {
    const heavy = [...cursors.values()].filter(x => x.keepMessages);
    for (const old of heavy.slice(0, Math.max(0, heavy.length - MAX_MESSAGE_CURSORS))) {
      // Its counters stay right; only the messages go.
      old.keepMessages = false;
      old.messages = [];
    }
  }
  return c;
}

function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return cap(content, MAX_TOOL_RESULT_CHARS);
  if (Array.isArray(content)) {
    const parts = content.map((b: any) => {
      if (b?.type === 'text' && typeof b.text === 'string') return b.text;
      if (b?.type === 'image') return '[image]';
      if (b?.type === 'tool_reference' && typeof b.tool_name === 'string') return b.tool_name;
      return JSON.stringify(b);
    });
    return cap(parts.join('\n'), MAX_TOOL_RESULT_CHARS);
  }
  return content === undefined || content === null ? '' : cap(JSON.stringify(content), MAX_TOOL_RESULT_CHARS);
}

/** Long string arguments (a Write's whole file) are cut; the shape stays. */
function capInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = typeof v === 'string' ? cap(v, MAX_INPUT_STRING_CHARS) : v;
  }
  return out;
}

function push(c: Cursor, msg: Omit<ChatMessage, 'seq'>): void {
  c.seq += 1;
  if (!c.keepMessages) return;
  c.messages.push({ ...msg, seq: c.seq });
  // Trimmed in batches, not on every push.
  if (c.messages.length > MAX_MESSAGES * 1.25) c.messages.splice(0, c.messages.length - MAX_MESSAGES);
}

/**
 * One transcript entry → chat messages, mapped the way the bridge maps the
 * live stream (adapters/claude.ts + provider/bridge.ts): text, thinking and
 * tool calls as assistant messages, tool output as `isToolResult` answering
 * `toolUseId`. A tool call's message id is its tool_use id — that is how the
 * chat pairs it with its result; everything else is `<entry uuid>:<block>`.
 */
function consume(c: Cursor, entry: any): void {
  if (!entry || (entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta) return;
  const message = entry.message;
  if (!message || typeof message !== 'object') return;
  const parsedTs = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  const ts = Number.isFinite(parsedTs) ? parsedTs : null;
  if (ts !== null) {
    c.firstTs = c.firstTs ?? ts;
    c.lastTs = ts;
  }
  const timestamp = ts ?? c.lastTs ?? 0;
  const uuid = typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : `line-${c.lines}`;
  const role: 'user' | 'assistant' = entry.type;

  if (role === 'assistant' && typeof message.id === 'string') {
    const out = Number(message.usage?.output_tokens);
    if (Number.isFinite(out) && out > 0) {
      if (message.id === c.usageMsgId) {
        if (out > c.usageTokens) { c.outputTokens += out - c.usageTokens; c.usageTokens = out; }
      } else {
        c.usageMsgId = message.id;
        c.usageTokens = out;
        c.outputTokens += out;
      }
    }
  }

  const content = message.content;
  const blocks: any[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];

  // The first thing the agent was told is its brief: the window shows it as the prompt card.
  if (role === 'user' && c.seq === 0 && c.prompt === null && blocks.every(b => b?.type === 'text')) {
    const brief = blocks.map(b => (typeof b.text === 'string' ? b.text : '')).join('\n').trim();
    if (brief) { c.prompt = cap(brief, MAX_TEXT_CHARS); return; }
  }

  blocks.forEach((block, i) => {
    const id = `${uuid}:${i}`;
    switch (block?.type) {
      case 'text': {
        const text = typeof block.text === 'string' ? block.text : '';
        if (!text.trim()) return;
        if (role === 'assistant') c.lastText = text;
        push(c, { id, role, content: cap(text, MAX_TEXT_CHARS), timestamp, ...(role === 'assistant' && message.model ? { model: message.model } : {}) });
        return;
      }
      case 'thinking': {
        const text = typeof block.thinking === 'string' ? block.thinking : '';
        if (!text.trim()) return;
        push(c, { id, role: 'assistant', content: cap(text, MAX_TEXT_CHARS), timestamp, isThinking: true });
        return;
      }
      case 'redacted_thinking':
        push(c, { id, role: 'assistant', content: '[Encrypted reasoning — preserved for multi-turn continuity.]', timestamp, isThinking: true, thinkingRedacted: true });
        return;
      case 'tool_use': {
        const name = typeof block.name === 'string' ? block.name : 'tool';
        c.toolUses += 1;
        c.lastToolName = name;
        push(c, {
          id: typeof block.id === 'string' && block.id ? block.id : id,
          role: 'assistant',
          content: `Using tool: **${name}**`,
          timestamp,
          toolName: name,
          toolInput: capInput(block.input),
        });
        return;
      }
      case 'tool_result':
        push(c, {
          id,
          role: 'assistant',
          content: flattenToolResult(block.content),
          timestamp,
          isToolResult: true,
          toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
          ...(block.is_error ? { isError: true } : {}),
        });
        return;
    }
  });
}

/** Cheap pre-check: most lines (API request dumps, attachments) are neither. */
const ENTRY_TYPE_RE = /"type"\s*:\s*"(?:user|assistant)"/;

function consumeLine(c: Cursor, line: string): boolean {
  c.lines += 1;
  if (!ENTRY_TYPE_RE.test(line)) return true;
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return false; }
  consume(c, entry);
  return true;
}

function reset(c: Cursor): void {
  Object.assign(c, newCursor(c.path, c.keepMessages), { busy: c.busy });
}

const CHUNK = 1 << 20;

/** Parse whatever was appended since the last call. */
async function readNew(c: Cursor): Promise<void> {
  let st;
  try { st = await stat(c.path); } catch { return; }
  if (st.size === c.size && st.mtimeMs === c.mtimeMs) return;
  // Shorter than what we already read: rewritten, not appended.
  if (st.size < c.offset) reset(c);
  const fh = await open(c.path, 'r');
  try {
    let pos = c.offset;
    let carry: Buffer = Buffer.alloc(0);
    while (pos < st.size) {
      const want = Math.min(CHUNK, st.size - pos);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let start = 0;
      // '\n' never occurs inside a multi-byte UTF-8 sequence, so splitting bytes is safe.
      for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
        if (nl > start) consumeLine(c, data.toString('utf8', start, nl));
        start = nl + 1;
      }
      carry = Buffer.from(data.subarray(start));
      c.offset = pos - carry.length;
    }
    // A last line without its newline is either still being written (wait for
    // it) or the file's final entry (take it once it parses).
    if (carry.length && pos >= st.size) {
      const tail = carry.toString('utf8');
      try {
        const entry = JSON.parse(tail);
        c.lines += 1;
        consume(c, entry);
        c.offset = pos;
      } catch { /* Partial write: read again when the file grows. */ }
    }
  } finally {
    await fh.close();
  }
  c.size = st.size;
  c.mtimeMs = st.mtimeMs;
}

function advance(c: Cursor): Promise<void> {
  const run = (c.busy ?? Promise.resolve()).then(() => readNew(c));
  c.busy = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

export function isWorkflowRunning(status: SubagentTaskStatus): boolean {
  return status === 'running' || status === 'pending' || status === 'paused';
}

/**
 * Done once the journal has its result. Otherwise it is running while the
 * workflow is — and stopped once the workflow is not, since nothing will
 * ever finish it then.
 */
export function agentStatus(done: boolean, workflowRunning: boolean): WorkflowAgentStatus {
  if (done) return 'completed';
  return workflowRunning ? 'running' : 'stopped';
}

function oneLine(text: string | null): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > LAST_TEXT_CHARS ? `${flat.slice(0, LAST_TEXT_CHARS - 1)}…` : flat;
}

/**
 * Every agent the run started, oldest first: the journal's order, then any
 * agent only its files know about (an older SDK without a journal).
 */
export async function listWorkflowAgents(
  dir: string,
  workflowStatus: SubagentTaskStatus,
  opts: { only?: string } = {},
): Promise<WorkflowAgent[]> {
  const running = isWorkflowRunning(workflowStatus);
  const journalPath = fileIn(dir, 'journal.jsonl');
  const journal = journalPath ? (await readCached(journalPath, parseJournal))?.value ?? [] : [];

  const ids: string[] = journal.map(a => a.agentId);
  const seen = new Set(ids);
  let names: string[] = [];
  try { names = await readdir(dir); } catch { /* Gone: what the journal says is all there is. */ }
  const extra: string[] = [];
  for (const name of names) {
    const id = /^agent-([A-Za-z0-9]{1,64})\.(?:meta\.json|jsonl)$/.exec(name)?.[1];
    if (id && !seen.has(id)) { seen.add(id); extra.push(id); }
  }
  ids.push(...extra.sort());

  const byId = new Map(journal.map(a => [a.agentId, a]));
  const agents: WorkflowAgent[] = [];
  for (const agentId of ids) {
    if (opts.only && agentId !== opts.only) continue;
    const j = byId.get(agentId);
    const metaPath = fileIn(dir, `agent-${agentId}.meta.json`);
    const meta = metaPath ? await readCached(metaPath, parseMeta) : null;
    const transcript = fileIn(dir, `agent-${agentId}.jsonl`);
    let c: Cursor | null = null;
    if (transcript) {
      c = cursorFor(transcript, cursors.get(transcript)?.keepMessages ?? false);
      await advance(c);
    }
    const status = agentStatus(!!j?.done, running);
    agents.push({
      agentId,
      label: j?.label ?? meta?.value.label ?? agentId,
      phase: j?.phase ?? meta?.value.phase ?? null,
      status,
      startedAt: c?.firstTs ?? (meta ? Math.round(meta.mtimeMs) : null),
      endedAt: status === 'running' ? null : c?.lastTs ?? null,
      toolUses: c?.toolUses ?? 0,
      outputTokens: c?.outputTokens ?? 0,
      lastToolName: c?.lastToolName ?? null,
      lastText: oneLine(c?.lastText ?? null),
      summary: j?.summary ?? null,
    });
  }
  return agents;
}

/**
 * One agent's conversation, oldest first, capped to the newest MAX_MESSAGES.
 * `afterSeq` returns only what came after it (the window polls with it).
 * Null when the id is not an agent of this run.
 */
export async function readWorkflowAgentMessages(
  dir: string,
  agentId: string,
  opts: { afterSeq?: number } = {},
): Promise<WorkflowAgentMessages | null> {
  if (!AGENT_ID_RE.test(agentId)) return null;
  const transcript = fileIn(dir, `agent-${agentId}.jsonl`);
  if (!transcript) return null;
  const c = cursorFor(transcript, true);
  await advance(c);
  const kept = c.messages.length > MAX_MESSAGES ? c.messages.slice(-MAX_MESSAGES) : c.messages;
  const firstKept = kept[0]?.seq ?? c.seq + 1;
  const after = opts.afterSeq;
  if (typeof after === 'number' && Number.isFinite(after) && after >= 0) {
    const gap = after < firstKept - 1;
    return {
      prompt: c.prompt,
      messages: gap ? kept : kept.filter(m => (m.seq ?? 0) > after),
      total: c.seq,
      truncated: firstKept > 1,
      gap,
    };
  }
  return { prompt: c.prompt, messages: kept, total: c.seq, truncated: firstKept > 1, gap: false };
}
