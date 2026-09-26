import type { ChatMessage } from './claude-client';
import type { ToolRunGroup } from './tool-runs';
import { buildToolSteps } from './tool-steps';

/**
 * Folds the *work* of each finished turn into one line.
 *
 * A turn is everything from one user message to the next. Inside it, the
 * agent narrates ("checking X first…"), calls tools, narrates again, and
 * finally answers. Once the turn is over the narration has done its job, and
 * left in place it reads as loose sentences stranded between tool lines. So a
 * finished turn becomes:
 *
 *   ▸ Worked 6m 12s · ✎ 5 files +212 −14 · ▶ 12 commands     ← the work, folded
 *   <the final answer>                                          ← what the reader wanted
 *
 * The final answer is the text after the agent's last tool call; everything
 * up to that call (narration, tools, reasoning) is the work. The rule reads
 * only the message order, so it holds for every provider — Claude's `result`
 * marker isn't needed.
 */

type AgentGroup = { agent: ChatMessage; children: ChatMessage[] };
export type ThreadItem = ChatMessage | AgentGroup | ToolRunGroup;

export interface TurnFileStat {
  path: string;
  added: number;
  removed: number;
}

export interface TurnStats {
  durationMs: number | null;
  files: TurnFileStat[];
  commands: number;
  failedCommands: number;
}

export interface TurnWork<T> {
  turnWork: true;
  /** Stable key: the first folded item's id. */
  key: string;
  items: T[];
  stats: TurnStats;
  /** The user stopped the turn before it finished. */
  stopped: boolean;
}

/**
 * Tools the reader interacts with or comes back to — a plan to approve, a
 * question to answer, a mockup to reopen. They are lifted out of the fold and
 * stay visible, in order, between the fold line and the answer.
 */
const KEEP_VISIBLE = /^(ExitPlanMode|AskUserQuestion)$|mockup_write$/;

function isGroup(item: unknown): item is AgentGroup | ToolRunGroup {
  return typeof item === 'object' && item !== null && ('agent' in item || 'toolRun' in item);
}

function isUserMessage(item: unknown): boolean {
  if (isGroup(item)) return false;
  const m = item as ChatMessage;
  return m.role === 'user' && !m.isToolResult;
}

function isTool(item: unknown): boolean {
  if (isGroup(item)) return true;
  return !!(item as ChatMessage).toolName;
}

function isKeepVisible(item: unknown): boolean {
  if (isGroup(item)) return false;
  const name = (item as ChatMessage).toolName;
  return !!name && KEEP_VISIBLE.test(name);
}

function isThinking(item: unknown): boolean {
  return !isGroup(item) && !!(item as ChatMessage).isThinking;
}

function keyOf(item: unknown): string {
  if (typeof item === 'object' && item !== null) {
    if ('agent' in item) return (item as AgentGroup).agent.id;
    if ('toolRun' in item) return (item as ToolRunGroup).items[0]?.id ?? '';
    const m = item as ChatMessage;
    return m.uiKey ?? m.id;
  }
  return '';
}

/** Every message an item stands for, sub-agent tools included. */
function messagesOf(item: unknown): ChatMessage[] {
  if (typeof item !== 'object' || item === null) return [];
  if ('agent' in item) return [(item as AgentGroup).agent, ...(item as AgentGroup).children];
  if ('toolRun' in item) return (item as ToolRunGroup).items;
  return [item as ChatMessage];
}

export function turnStats(items: unknown[], start: number | null): TurnStats {
  const messages = items.flatMap(messagesOf);
  const files = new Map<string, TurnFileStat>();
  let commands = 0;
  let failedCommands = 0;
  for (const step of buildToolSteps(messages.filter(m => m.toolName && !m.isToolResult))) {
    if (step.kind === 'change') {
      for (const f of step.files) {
        const cur = files.get(f.path) ?? { path: f.path, added: 0, removed: 0 };
        cur.added += f.added;
        cur.removed += f.removed;
        files.set(f.path, cur);
      }
    } else if (step.kind === 'bash') {
      commands++;
      if (step.failed || (step.outcome && !step.outcome.ok)) failedCommands++;
    }
  }

  let first = start ?? 0;
  let last = 0;
  for (const m of messages) {
    if (m.timestamp && (first === 0 || m.timestamp < first)) first = m.timestamp;
    const end = m.toolResult?.timestamp ?? m.timestamp;
    if (end && end > last) last = end;
  }
  const durationMs = first > 0 && last > first ? last - first : null;
  return { durationMs, files: [...files.values()], commands, failedCommands };
}

/**
 * Replaces the work of every finished turn with a `TurnWork` entry. The turn
 * still running (the last one, while `live`) is left exactly as it is — its
 * narration is how the reader follows along.
 */
export function foldTurns<T>(
  items: T[],
  opts: { live: boolean; interrupted?: boolean },
): (T | TurnWork<T>)[] {
  // Split into turns at each user message; the leading chunk before the first
  // user message is a turn of its own (e.g. a resumed session's tail).
  const bounds: number[] = [];
  items.forEach((item, i) => { if (isUserMessage(item)) bounds.push(i); });

  const out: (T | TurnWork<T>)[] = [];
  let cursor = 0;
  // Segments alternate: a user message on its own, then the agent's side of
  // the turn it opened.
  const segments: [number, number][] = [];
  for (const b of bounds) {
    if (b > cursor) segments.push([cursor, b]);
    segments.push([b, b + 1]);
    cursor = b + 1;
  }
  if (cursor < items.length) segments.push([cursor, items.length]);

  segments.forEach(([from, to], idx) => {
    const slice = items.slice(from, to);
    const isLastSegment = idx === segments.length - 1;
    if (slice.length === 1 && isUserMessage(slice[0])) { out.push(slice[0]!); return; }

    const running = isLastSegment && opts.live;
    let lastTool = -1;
    slice.forEach((item, i) => { if (isTool(item) && !isKeepVisible(item)) lastTool = i; });
    if (running || lastTool < 0) { out.push(...slice); return; }

    const work: T[] = [];
    const lifted: T[] = [];
    const answer: T[] = [];
    slice.forEach((item, i) => {
      if (isKeepVisible(item)) lifted.push(item);
      else if (i <= lastTool || isThinking(item)) work.push(item);
      else answer.push(item);
    });

    const prev = from > 0 ? items[from - 1] : undefined;
    const start = prev && isUserMessage(prev) ? (prev as unknown as ChatMessage).timestamp : null;
    out.push({
      turnWork: true,
      key: `turn-${keyOf(work[0])}`,
      items: work,
      stats: turnStats(work, start),
      stopped: isLastSegment && !!opts.interrupted,
    });
    out.push(...lifted, ...answer);
  });

  return out;
}

export function isTurnWork<T>(item: T | TurnWork<T>): item is TurnWork<T> {
  return typeof item === 'object' && item !== null && 'turnWork' in item;
}
