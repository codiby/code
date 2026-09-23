import type { ChatMessage } from './claude-client';

export type ToolRunGroup = { toolRun: true; items: ChatMessage[] };

/** Tools whose card carries the interaction (a plan to approve, a question to
 *  answer, a sub-agent's whole transcript). Folding one into a one-line
 *  summary would hide the thing the reader has to act on. */
const NEVER_COLLAPSE = new Set([
  'Agent', 'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'TodoWrite',
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
]);

/**
 * A written mockup is the same case, by suffix rather than by name: its card
 * is the only handle for reopening it in the preview panel, and the html never
 * appears anywhere else in the thread. Buried two clicks deep inside a
 * collapsed run, a mockup is effectively gone.
 *
 * Matched on the suffix because the tool arrives under whichever MCP server
 * served it — `mcp__codiby-code__ui_mockup_write`, `mcp__codiby-code-sdk__mockup_write`.
 */
const MOCKUP_WRITE = /mockup_write$/;

/** Label a reasoning block carries inside the run summary. */
export const THINKING_LABEL = 'thought';

function isAgentGroup(item: unknown): boolean {
  return typeof item === 'object' && item !== null && 'agent' in item;
}

function isToolRun(item: unknown): item is ToolRunGroup {
  return typeof item === 'object' && item !== null && 'toolRun' in item;
}

function isCollapsibleTool(item: unknown): boolean {
  if (isAgentGroup(item) || isToolRun(item)) return false;
  const m = item as ChatMessage;
  if (!m.toolName || m.isToolResult) return false;
  return !NEVER_COLLAPSE.has(m.toolName) && !MOCKUP_WRITE.test(m.toolName);
}

function isReasoning(item: unknown): boolean {
  if (isAgentGroup(item) || isToolRun(item)) return false;
  return !!(item as ChatMessage).isThinking;
}

/**
 * Folds a run of consecutive tool calls — and the reasoning interleaved with
 * them — into a single collapsible card.
 *
 * Reasoning is part of the run, not a divider between runs. A `Thought` row
 * sitting between two tool calls used to split one stretch of work into two
 * cards with a third row wedged in the middle, which is three things to skip
 * where there was only ever one.
 *
 * A run only collapses once it holds a tool: reasoning on its own keeps its
 * row, which is where a one-line summary of the thinking belongs. A lone tool
 * also keeps its own card — on the desktop that card renders the diff, the
 * command output, the file, and none of that survives a summary line.
 */
export function collapseToolRuns<T>(items: T[]): (T | ToolRunGroup)[] {
  const out: (T | ToolRunGroup)[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i]!;
    if (isCollapsibleTool(item) || isReasoning(item)) {
      let j = i;
      let tools = 0;
      while (j < items.length && (isCollapsibleTool(items[j]!) || isReasoning(items[j]!))) {
        if (isCollapsibleTool(items[j]!)) tools++;
        j++;
      }
      // Trailing reasoning belongs to the run only if a tool preceded it in
      // the same stretch; `tools > 0` already says so.
      if (tools > 0 && j - i >= 2) {
        out.push({ toolRun: true, items: items.slice(i, j) as ChatMessage[] });
        i = j;
        continue;
      }
    }
    out.push(item);
    i++;
  }
  return out;
}

/**
 * MCP tools arrive as `mcp__<server>__<action>`. Unshortened, that identifier
 * is the widest thing in the summary line and says the least.
 */
export function shortToolName(name: string): string {
  const action = name.startsWith('mcp__') ? (name.split('__').pop() ?? name) : name;
  return action.replace(/_/g, ' ');
}

export interface ToolRunSummary {
  /** `Bash ×2 · Edit · thought`, in order of first appearance. */
  label: string;
  /** Distinct kinds, in the same order — one per colour dot. */
  kinds: string[];
  /** Wall time from the first call to the last result, or null if under a second. */
  elapsed: string | null;
  failures: number;
}

/**
 * The collapsed card's one-liner. Naming *what* ran, rather than counting how
 * many things did, is what lets the reader skip the card without opening it —
 * "3 tools" tells them nothing they can act on.
 */
export function toolRunSummary(
  items: ChatMessage[],
  resultOf: (m: ChatMessage) => ChatMessage | undefined = (m) => m.toolResult,
): ToolRunSummary {
  const order: string[] = [];
  const counts = new Map<string, number>();
  let failures = 0;
  let first = 0;
  let last = 0;

  for (const m of items) {
    const kind = m.isThinking ? THINKING_LABEL : shortToolName(m.toolName ?? 'Tool');
    if (!counts.has(kind)) order.push(kind);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);

    const result = m.isThinking ? undefined : resultOf(m);
    if (result?.isError) failures++;

    if (m.timestamp && (first === 0 || m.timestamp < first)) first = m.timestamp;
    // A tool's run ends when its result lands, not when it was called.
    const end = result?.timestamp ?? m.timestamp;
    if (end && end > last) last = end;
  }

  const label = order
    .map((kind) => {
      const times = counts.get(kind) ?? 1;
      return times > 1 ? `${kind} ×${times}` : kind;
    })
    .join(' · ');

  const seconds = first > 0 ? Math.round((last - first) / 1000) : 0;
  const elapsed = seconds <= 0 ? null : seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;

  return { label, kinds: order, elapsed, failures };
}

/**
 * One colour per family, tuned for the dark canvas. Reasoning gets its own,
 * the same violet the sparkle uses, so a run that is mostly thinking reads as
 * such from the dots alone.
 */
const KIND_COLORS: Record<string, string> = {
  Bash: '#cbd5e1',
  Edit: '#a78bfa',
  Write: '#4ade80',
  Read: '#38bdf8',
  Grep: '#fbbf24',
  Glob: '#fbbf24',
  [THINKING_LABEL]: '#c4b5fd',
};

const DEFAULT_COLOR = '#71717a';

export function toolKindColor(kind: string): string {
  return KIND_COLORS[kind] ?? DEFAULT_COLOR;
}
