import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from './claude-client';
import {
  collapseToolRuns,
  shortToolName,
  THINKING_LABEL,
  toolKindColor,
  toolRunSummary,
  type ToolRunGroup,
} from './tool-runs';

let seq = 0;
const nextId = () => `m${++seq}`;

function tool(toolName: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: nextId(), role: 'assistant', content: '', timestamp: 0, toolName, ...extra };
}

function thought(content = 'reasoning', extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: nextId(), role: 'assistant', content, timestamp: 0, isThinking: true, ...extra };
}

function text(content = 'done'): ChatMessage {
  return { id: nextId(), role: 'assistant', content, timestamp: 0 };
}

function result(isError = false, timestamp = 0): ChatMessage {
  return { id: nextId(), role: 'user', content: '', timestamp, isToolResult: true, isError };
}

const isRun = (item: unknown): item is ToolRunGroup =>
  typeof item === 'object' && item !== null && 'toolRun' in item;

describe('collapseToolRuns', () => {
  test('folds a run of consecutive tools', () => {
    const out = collapseToolRuns([tool('Read'), tool('Read'), tool('Edit')]);
    expect(out).toHaveLength(1);
    expect(isRun(out[0]) && out[0].items).toHaveLength(3);
  });

  test('reasoning between two tools stays inside the same run', () => {
    const a = tool('Bash');
    const t = thought();
    const b = tool('Edit');
    const out = collapseToolRuns([a, t, b]);
    expect(out).toHaveLength(1);
    expect(isRun(out[0]) && out[0].items.map((m) => m.id)).toEqual([a.id, t.id, b.id]);
  });

  test('reasoning that opens a run joins it', () => {
    const t = thought();
    const a = tool('Bash');
    const out = collapseToolRuns([t, a]);
    expect(out).toHaveLength(1);
    expect(isRun(out[0]) && out[0].items.map((m) => m.id)).toEqual([t.id, a.id]);
  });

  test('reasoning trailing a run joins it', () => {
    const a = tool('Bash');
    const t = thought();
    const out = collapseToolRuns([a, t]);
    expect(out).toHaveLength(1);
    expect(isRun(out[0]) && out[0].items.map((m) => m.id)).toEqual([a.id, t.id]);
  });

  test('reasoning with no tool around it keeps its own row', () => {
    const t1 = thought();
    const t2 = thought();
    const out = collapseToolRuns([t1, t2, text()]);
    expect(out.some(isRun)).toBe(false);
    expect(out).toHaveLength(3);
  });

  test('a lone tool keeps its own card', () => {
    const out = collapseToolRuns([text(), tool('Edit'), text()]);
    expect(out.some(isRun)).toBe(false);
  });

  test('assistant text ends the run', () => {
    const out = collapseToolRuns([tool('Read'), tool('Read'), text(), tool('Read'), tool('Read')]);
    expect(out).toHaveLength(3);
    expect(isRun(out[0])).toBe(true);
    expect(isRun(out[1])).toBe(false);
    expect(isRun(out[2])).toBe(true);
  });

  test('tools that own an interaction never collapse', () => {
    const out = collapseToolRuns([tool('ExitPlanMode'), tool('AskUserQuestion')]);
    expect(out.some(isRun)).toBe(false);
  });

  test('a written mockup keeps its own card, whichever server served it', () => {
    const out = collapseToolRuns([
      tool('mcp__codiby-code__ui_mockup_write'),
      tool('mcp__codiby-code-sdk__mockup_write'),
    ]);
    expect(out.some(isRun)).toBe(false);
  });

  test('a mockup splits the run around it instead of joining', () => {
    const a = tool('Read');
    const b = tool('Read');
    const mockup = tool('mcp__codiby-code__ui_mockup_write');
    const c = tool('Edit');
    const d = tool('Edit');
    const out = collapseToolRuns([a, b, mockup, c, d]);
    expect(out).toHaveLength(3);
    expect(isRun(out[0]) && out[0].items.map((m) => m.id)).toEqual([a.id, b.id]);
    expect(out[1]).toBe(mockup);
    expect(isRun(out[2]) && out[2].items.map((m) => m.id)).toEqual([c.id, d.id]);
  });

  test('reading or editing a mockup still collapses', () => {
    const out = collapseToolRuns([
      tool('mcp__codiby-code__ui_mockup_read'),
      tool('mcp__codiby-code__ui_mockup_edit'),
    ]);
    expect(out.some(isRun)).toBe(true);
  });

  test('agent groups and tool results pass through', () => {
    const agent = { agent: tool('Agent'), children: [] };
    const out = collapseToolRuns([agent, result()]);
    expect(out.some(isRun)).toBe(false);
    expect(out).toHaveLength(2);
  });
});

describe('toolRunSummary', () => {
  test('names what ran, in order, with repeats counted', () => {
    const { label, kinds } = toolRunSummary([
      tool('Bash'), tool('Bash'), tool('Edit'), thought(),
    ]);
    expect(label).toBe(`Bash ×2 · Edit · ${THINKING_LABEL}`);
    expect(kinds).toEqual(['Bash', 'Edit', THINKING_LABEL]);
  });

  test('counts failed tools, ignoring reasoning', () => {
    const bad = tool('Bash', { toolResult: result(true) });
    const ok = tool('Read', { toolResult: result(false) });
    expect(toolRunSummary([bad, ok, thought()]).failures).toBe(1);
  });

  test('takes the failure from an external result lookup when given one', () => {
    const call = tool('Bash');
    const res = result(true);
    const summary = toolRunSummary([call], () => res);
    expect(summary.failures).toBe(1);
  });

  test('measures from the first call to the last result', () => {
    const a = tool('Bash', { timestamp: 1_000, toolResult: result(false, 4_000) });
    const b = tool('Read', { timestamp: 5_000, toolResult: result(false, 13_000) });
    expect(toolRunSummary([a, b]).elapsed).toBe('12s');
  });

  test('rolls over to minutes', () => {
    const a = tool('Bash', { timestamp: 1_000 });
    const b = tool('Read', { timestamp: 121_000 });
    expect(toolRunSummary([a, b]).elapsed).toBe('2m');
  });

  test('stays silent under a second', () => {
    expect(toolRunSummary([tool('Read'), tool('Read')]).elapsed).toBeNull();
  });
});

describe('shortToolName', () => {
  test('keeps a plain tool name', () => {
    expect(shortToolName('Bash')).toBe('Bash');
  });

  test('strips the MCP server prefix and the underscores', () => {
    expect(shortToolName('mcp__codiby-code__ui_link_pr')).toBe('ui link pr');
  });
});

describe('toolKindColor', () => {
  test('reasoning is not the fallback grey', () => {
    expect(toolKindColor(THINKING_LABEL)).not.toBe(toolKindColor('SomeUnknownTool'));
  });
});
