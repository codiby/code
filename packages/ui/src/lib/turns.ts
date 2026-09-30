import type { ChatMessage } from './claude-client';
import type { ToolRunGroup } from './tool-runs';
import { buildToolSteps } from './tool-steps';
import { parseToolResultImages } from './tool-result-images';

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

/** Something the agent showed during the turn that the fold would hide. */
export type TurnMediaItem =
  | { kind: 'image'; src: string; caption?: string }
  | { kind: 'mockup'; name: string; html: string };

/**
 * The images and mockups folded away with a turn's work, repeated as a strip
 * of thumbnails under its answer — closing the fold shouldn't make a
 * screenshot the agent posted disappear.
 */
export interface TurnMedia {
  turnMedia: true;
  key: string;
  items: TurnMediaItem[];
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

/** An image the agent posted into the chat. It lands after the tool call
 *  that posted it, so the last one would otherwise read as part of the answer
 *  and render full size; it belongs with the work, shown in the media strip. */
function isPostedImage(item: unknown): boolean {
  if (isGroup(item)) return false;
  const m = item as ChatMessage;
  return m.role === 'system' && !!m.images?.length;
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

const MOCKUP_WRITE = /mockup_write$/;

/** Posted images, image tool results and written mockups, in thread order. */
export function turnMedia(items: unknown[]): TurnMediaItem[] {
  const out: TurnMediaItem[] = [];
  for (const m of items.flatMap(messagesOf)) {
    for (const img of m.images ?? []) {
      out.push({ kind: 'image', src: `data:${img.media_type};base64,${img.data}`, ...(m.content ? { caption: m.content } : {}) });
    }
    if (!m.toolName || m.isToolResult) continue;
    const result = m.toolResult;
    if (!result || result.isError) continue;
    const input = m.toolInput as Record<string, unknown> | undefined;
    if (MOCKUP_WRITE.test(m.toolName)) {
      if (typeof input?.name === 'string' && typeof input.html === 'string') {
        out.push({ kind: 'mockup', name: input.name, html: input.html });
      }
      continue;
    }
    // Cheap check before parsing: most results are plain text.
    if (typeof result.content === 'string' && result.content.includes('"image"')) {
      for (const src of parseToolResultImages(result.content)?.images ?? []) out.push({ kind: 'image', src });
    }
  }
  return out;
}

/**
 * Replaces the work of every finished turn with a `TurnWork` entry. The turn
 * still running (the last one, while `live`) is left exactly as it is — its
 * narration is how the reader follows along.
 */
export function foldTurns<T>(
  items: T[],
  opts: { live: boolean; interrupted?: boolean },
): (T | TurnWork<T> | TurnMedia)[] {
  // Split into turns at each user message; the leading chunk before the first
  // user message is a turn of its own (e.g. a resumed session's tail).
  const bounds: number[] = [];
  items.forEach((item, i) => { if (isUserMessage(item)) bounds.push(i); });

  const out: (T | TurnWork<T> | TurnMedia)[] = [];
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
      else if (i <= lastTool || isThinking(item) || isPostedImage(item)) work.push(item);
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
    const media = turnMedia(work);
    if (media.length) out.push({ turnMedia: true, key: `media-${keyOf(work[0])}`, items: media });
  });

  return out;
}

export function isTurnWork<T>(item: T | TurnWork<T> | TurnMedia): item is TurnWork<T> {
  return typeof item === 'object' && item !== null && 'turnWork' in item;
}

export function isTurnMedia(item: unknown): item is TurnMedia {
  return typeof item === 'object' && item !== null && 'turnMedia' in item;
}
