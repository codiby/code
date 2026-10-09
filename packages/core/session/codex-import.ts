/**
 * Import Codex CLI threads (`codex` run in a terminal) as app sessions, so a
 * conversation started in the console can be continued here.
 *
 * Codex writes every thread to `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`.
 * The app never asks Codex for past turns (`thread/resume` runs with
 * `excludeTurns`), so the transcript is rebuilt from the rollout's
 * `item_completed` events into the same ChatMessage rows the Codex adapter
 * produces live, and the thread id becomes the session's resume id.
 *
 * Message ids come from the Codex item ids, so importing the same thread again
 * only appends what happened since — the way to pick up turns run in the
 * console after the first import.
 */

import { randomUUID } from 'crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getSessionState, addMessage } from './state';
import { sessions, saveSessions } from './sessions';
import type { ChatMessage } from './state';
import type { Session } from '../types';

let codexHomeOverride: string | null = null;

/** Tests point this at a fixture directory. */
export function setCodexHome(dir: string | null) {
  codexHomeOverride = dir;
}

function codexHome(): string {
  return codexHomeOverride || process.env.CODEX_HOME || join(homedir(), '.codex');
}

export type CodexThreadSummary = {
  id: string;
  name: string;
  cwd: string;
  /** Who started it: `codex-tui` for the terminal, `codiby_code` for this app. */
  originator: string;
  createdAt: number;
  updatedAt: number;
  /** App session already holding this thread, if it was imported or started here. */
  sessionId: string | null;
};

/** Newest-first rollout paths, walking the date folders so old ones are never read. */
function rolloutFiles(limit: number): string[] {
  const root = join(codexHome(), 'sessions');
  const out: string[] = [];
  const desc = (dir: string) => {
    try { return readdirSync(dir).sort().reverse(); } catch { return []; }
  };
  for (const y of desc(root)) for (const m of desc(join(root, y))) for (const d of desc(join(root, y, m))) {
    for (const f of desc(join(root, y, m, d))) {
      if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
      out.push(join(root, y, m, d, f));
    }
    if (out.length >= limit * 2) return out;
  }
  return out;
}

/** First `bytes` of a file — enough for the meta line and the opening prompt. */
function readHead(path: string, bytes = 256 * 1024): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

/** Latest `thread_name` per thread from Codex's own index (later lines win). */
function threadNames(): Map<string, string> {
  const names = new Map<string, string>();
  try {
    for (const line of readFileSync(join(codexHome(), 'session_index.jsonl'), 'utf-8').split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as { id?: string; thread_name?: string };
        if (row.id && row.thread_name) names.set(row.id, row.thread_name);
      } catch {}
    }
  } catch {}
  return names;
}

function userText(item: any): string {
  return (item?.content || []).filter((c: any) => c?.type === 'text').map((c: any) => c.text || '').join('\n').trim();
}

function sessionForThread(threadId: string): Session | null {
  for (const s of sessions.values()) if (s.provider === 'codex' && s.claudeSessionId === threadId) return s;
  return null;
}

export function listCodexThreads(limit = 50): CodexThreadSummary[] {
  const names = threadNames();
  const threads: CodexThreadSummary[] = [];
  for (const path of rolloutFiles(limit)) {
    if (threads.length >= limit) break;
    let meta: any = null;
    let firstPrompt = '';
    try {
      const lines = readHead(path).split('\n');
      meta = JSON.parse(lines[0] || '{}');
      if (meta?.type !== 'session_meta') continue;
      for (const line of lines.slice(1)) {
        if (!line.includes('"UserMessage"')) continue;
        try {
          const item = JSON.parse(line)?.payload?.item;
          if (item?.type === 'UserMessage') { firstPrompt = userText(item); break; }
        } catch {}
      }
    } catch { continue; }
    const p = meta.payload || {};
    if (!p.id) continue;
    const name = names.get(p.id) || firstPrompt.split('\n')[0]?.slice(0, 80) || 'Codex thread';
    threads.push({
      id: p.id,
      name,
      cwd: p.cwd || '',
      originator: p.originator || '',
      createdAt: Date.parse(p.timestamp || meta.timestamp) || 0,
      updatedAt: statSync(path).mtimeMs,
      sessionId: sessionForThread(p.id)?.id ?? null,
    });
  }
  return threads.sort((a, b) => b.updatedAt - a.updatedAt);
}

function findRollout(threadId: string): string | null {
  const root = join(codexHome(), 'sessions');
  if (!existsSync(root)) return null;
  // The thread id ends every rollout file name, so a filename match is enough.
  for (const path of rolloutFiles(Number.MAX_SAFE_INTEGER)) {
    if (path.endsWith(`-${threadId}.jsonl`)) return path;
  }
  return null;
}

/** `["/bin/zsh", "-lc", "ls"]` → `ls`; anything else is joined as-is. */
function shellCommand(command: unknown): string {
  if (typeof command === 'string') return command;
  if (!Array.isArray(command)) return '';
  const lc = command.findIndex(arg => arg === '-lc' || arg === '-c');
  return lc >= 0 && command.length === lc + 2 ? String(command[lc + 1]) : command.join(' ');
}

function fileCwd(cwd: unknown): string | undefined {
  return typeof cwd === 'string' ? cwd.replace(/^file:\/\//, '') : undefined;
}

export type CodexTurn = {
  turnId: string;
  startedAt: number;
  messages: ChatMessage[];
};

/**
 * Rebuilds the transcript of a rollout, grouped by turn. Rows mirror what the
 * live Codex adapter emits through the bridge (see adapters/codex.ts), so an
 * imported conversation renders exactly like one run in the app.
 */
export function parseCodexRollout(text: string): { meta: any; turns: CodexTurn[] } {
  let meta: any = null;
  const turns: CodexTurn[] = [];
  let turn: CodexTurn | null = null;
  const push = (msg: ChatMessage, at: number, turnId: string) => {
    if (!turn || turn.turnId !== turnId) {
      turn = { turnId, startedAt: at, messages: [] };
      turns.push(turn);
    }
    turn.messages.push(msg);
  };
  const tool = (item: any, at: number, turnId: string, name: string, input: unknown, content: string, isError: boolean) => {
    push({ id: item.id, role: 'assistant', content: `Using tool: **${name}**`, timestamp: at, toolName: name, toolInput: input, parentToolUseId: null }, at, turnId);
    push({ id: `${item.id}:result`, role: 'assistant', content, timestamp: at, isToolResult: true, toolUseId: item.id, parentToolUseId: null, isError }, at, turnId);
  };

  for (const line of text.split('\n')) {
    if (!line) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'session_meta') { meta ??= row.payload; continue; }
    if (row.type !== 'event_msg' || row.payload?.type !== 'item_completed') continue;
    const item = row.payload.item;
    if (!item?.id) continue;
    const at = Date.parse(row.timestamp) || 0;
    const turnId = row.payload.turn_id || '';
    const failed = item.status === 'failed' || item.status === 'declined';

    switch (item.type) {
      case 'UserMessage': {
        const content = userText(item);
        if (content) push({ id: item.id, role: 'user', content, timestamp: at }, at, turnId);
        break;
      }
      case 'AgentMessage': {
        const content = (item.content || []).map((c: any) => c?.text || '').join('');
        if (content.trim()) push({ id: item.id, role: 'assistant', content, timestamp: at, parentToolUseId: null }, at, turnId);
        break;
      }
      case 'Reasoning': {
        // Only the public summary is kept, as in the live adapter.
        const content = (item.summary_text || []).join('\n');
        if (content.trim()) push({ id: item.id, role: 'assistant', content, timestamp: at, isThinking: true, parentToolUseId: null }, at, turnId);
        break;
      }
      case 'CommandExecution': {
        const exit = typeof item.exit_code === 'number' ? item.exit_code : null;
        const output = `${item.aggregated_output ?? item.stdout ?? ''}${exit != null ? `\n[exit ${exit}]` : ''}`;
        tool(item, at, turnId, 'Bash', { command: shellCommand(item.command), cwd: fileCwd(item.cwd) }, output, failed || (exit != null && exit !== 0));
        break;
      }
      case 'FileChange': {
        // Rollouts key changes by path; the adapter's CodexEdit input is the
        // app-server list shape, which the UI diff renderer reads.
        const changes = Object.entries(item.changes || {}).map(([path, change]: [string, any]) => ({
          path,
          kind: { type: change?.type },
          diff: change?.unified_diff ?? change?.content ?? '',
        }));
        tool(item, at, turnId, 'CodexEdit', { changes }, changes.map(c => `${c.kind.type} ${c.path}`).join('\n'), failed);
        break;
      }
      case 'McpToolCall': {
        const result = item.error?.message || item.result?.content || item.result?.structuredContent || '';
        tool(item, at, turnId, `${item.server}__${item.tool}`, item.arguments || {}, typeof result === 'string' ? result : JSON.stringify(result), failed || !!item.error);
        break;
      }
      case 'Extension': {
        if (item.kind === 'web.search') tool(item, at, turnId, 'WebSearch', { query: item.query }, `Search complete: ${item.query || ''}`, false);
        break;
      }
    }
  }
  return { meta, turns };
}

function sameText(a: string, b: string) {
  return a.trim() === b.trim();
}

export type CodexImportResult = { session: Session; added: ChatMessage[]; created: boolean };

/**
 * Creates (or tops up) the app session for a Codex thread. The provider is not
 * started: the first message sent from the app resumes the thread, the same
 * way a session reloaded after a restart does.
 */
export function importCodexThread(threadId: string, opts: { permissionMode: string; model?: string | null }): CodexImportResult | null {
  const path = findRollout(threadId);
  if (!path) return null;
  const { meta, turns } = parseCodexRollout(readFileSync(path, 'utf-8'));

  let session = sessionForThread(threadId);
  const created = !session;
  if (!session) {
    const now = Date.now();
    const firstPrompt = turns.flatMap(t => t.messages).find(m => m.role === 'user')?.content || '';
    session = {
      id: randomUUID(),
      name: threadNames().get(threadId) || firstPrompt.split('\n')[0]?.slice(0, 40) || 'Codex import',
      cwd: meta?.cwd || homedir(),
      createdAt: now,
      updatedAt: now,
      claudeSessionId: threadId,
      browserWs: new Set(),
      providerSession: null,
      providerSessionGen: 0,
      ready: false,
      status: 'open',
      runtimeStatus: 'stopped',
      replayDone: false,
      savedCommands: [],
      model: opts.model ?? null,
      permissionMode: opts.permissionMode,
      effort: null,
      provider: 'codex',
      remoteId: null,
      portForwards: [],
      loopState: null,
      disposableTtlMs: null,
    };
    sessions.set(session.id, session);
  }

  // Turns run from the app live in the same rollout but were stored with the
  // app's own ids. Skip a turn whose prompt the app already holds from around
  // the same moment, so a re-import doesn't duplicate them.
  const existing = getSessionState(session.id).messages;
  const known = new Set(existing.map(m => m.id));
  const appPrompts = existing.filter(m => m.role === 'user');
  const added: ChatMessage[] = [];
  for (const turn of turns) {
    const prompt = turn.messages.find(m => m.role === 'user');
    if (prompt && !known.has(prompt.id) && appPrompts.some(m => sameText(m.content, prompt.content) && Math.abs(m.timestamp - turn.startedAt) < 120_000)) continue;
    for (const msg of turn.messages) if (addMessage(session.id, msg)) added.push(msg);
  }
  saveSessions();
  return { session, added, created };
}
