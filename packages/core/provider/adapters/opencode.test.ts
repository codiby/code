import { describe, expect, test } from 'bun:test';
import type { ReasoningPart, TextPart } from '@opencode-ai/sdk';
import type { ProviderEvents } from '../types';
import {
  buildOpenCodeMcpConfig,
  normalizeQuestionToolInput,
  OpenCodeContentStream,
  PLAN_MODE_SYSTEM_PROMPT,
  toAskUserQuestionInput,
  toOpenCodeAnswers,
  type OpenCodeQuestionInfo,
} from './opencode';

function contentEvents() {
  const assistantDeltas: string[] = [];
  const assistantTexts: string[] = [];
  const thinkingDeltas: string[] = [];
  const thinkingBlocks: string[] = [];
  const events = {
    onAssistantDelta: (text: string) => assistantDeltas.push(text),
    onAssistantText: (text: string) => assistantTexts.push(text),
    onThinkingDelta: (text: string) => thinkingDeltas.push(text),
    onThinking: (block) => thinkingBlocks.push(block.text),
  } satisfies Pick<
    ProviderEvents,
    'onAssistantDelta' | 'onAssistantText' | 'onThinkingDelta' | 'onThinking'
  >;
  return { events, assistantDeltas, assistantTexts, thinkingDeltas, thinkingBlocks };
}

function reasoningPart(text: string, end?: number): ReasoningPart {
  return {
    id: 'reasoning-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'reasoning',
    text,
    time: { start: 1, ...(end ? { end } : {}) },
  };
}

function textPart(text: string, end?: number): TextPart {
  return {
    id: 'text-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'text',
    text,
    time: { start: 1, ...(end ? { end } : {}) },
  };
}

describe('OpenCode plan-mode steering', () => {
  test('requires the ExitPlanMode tool instead of a plain-text plan', () => {
    expect(PLAN_MODE_SYSTEM_PROMPT).toContain('MUST call the `ExitPlanMode` tool');
    expect(PLAN_MODE_SYSTEM_PROMPT).toContain('Do not reply with the plan only');
  });
});

describe('OpenCode MCP configuration', () => {
  test('binds the owning UI session into remote MCP URLs', () => {
    const config = buildOpenCodeMcpConfig({
      codiby: {
        type: 'http',
        url: 'http://localhost:3111/mcp',
        headers: { 'x-session-id': 'ui session/id' },
      },
    });

    expect(config?.codiby).toEqual({
      type: 'remote',
      url: 'http://localhost:3111/mcp?session_id=ui+session%2Fid',
      headers: { 'x-session-id': 'ui session/id' },
    });
  });
});

describe('OpenCode question tool', () => {
  // Verbatim payload from a real opencode turn (the `question` tool call in the
  // FEAT-E90 session), minus the accents, to lock the field names down.
  const questions: OpenCodeQuestionInfo[] = [
    {
      header: 'API key',
      question: 'Should POST /provider/upsert keep working with an API key?',
      options: [
        { label: 'No, require JWT', description: 'Guarantees a real actor.' },
        { label: 'Yes, keep the API key', description: 'Needs a source for user-less calls.' },
      ],
      multiple: false,
    },
  ];

  test('maps opencode questions onto the AskUserQuestion input shape', () => {
    expect(toAskUserQuestionInput(questions)).toEqual({
      questions: [
        {
          header: 'API key',
          question: 'Should POST /provider/upsert keep working with an API key?',
          options: [
            { label: 'No, require JWT', description: 'Guarantees a real actor.' },
            { label: 'Yes, keep the API key', description: 'Needs a source for user-less calls.' },
          ],
          multiSelect: false,
        },
      ],
    });
  });

  test('renames the multi-select flag on the raw tool input and passes other tools through', () => {
    const normalized = normalizeQuestionToolInput({ questions: [{ ...questions[0]!, multiple: true }] });
    expect((normalized.questions as { multiSelect: boolean }[])[0]!.multiSelect).toBe(true);
    expect(normalizeQuestionToolInput({ command: 'ls' })).toEqual({ command: 'ls' });
  });

  test('turns the UI answer map into positional reply arrays', () => {
    const answers = toOpenCodeAnswers(questions, {
      'Should POST /provider/upsert keep working with an API key?': 'No, require JWT',
    });
    expect(answers).toEqual([['No, require JWT']]);
  });

  test('keeps a slot for every question so unanswered ones stay aligned', () => {
    const two = [questions[0]!, { ...questions[0]!, question: 'Second?' }];
    expect(toOpenCodeAnswers(two, { 'Second?': 'Yes' })).toEqual([[], ['Yes']]);
    expect(toOpenCodeAnswers(two, undefined)).toEqual([[], []]);
  });

  test('accepts multi-select answers and drops blanks', () => {
    const answers = toOpenCodeAnswers(questions, {
      'Should POST /provider/upsert keep working with an API key?': ['No, require JWT', '  ', 'Yes, keep the API key'],
    });
    expect(answers).toEqual([['No, require JWT', 'Yes, keep the API key']]);
  });
});

describe('OpenCode content streaming', () => {
  test('streams reasoning deltas and commits the completed thinking block', () => {
    const sink = contentEvents();
    const stream = new OpenCodeContentStream(sink.events, () => 'anthropic/claude');

    stream.handlePart(reasoningPart(''));
    stream.handleDelta('reasoning-1', 'text', 'Checking');
    stream.handleDelta('reasoning-1', 'text', ' the code');
    stream.handlePart(reasoningPart('Checking the code', 2));
    stream.flush();

    expect(sink.thinkingDeltas).toEqual(['Checking', 'Checking the code']);
    expect(sink.thinkingBlocks).toEqual(['Checking the code']);
    expect(sink.assistantDeltas).toEqual([]);
    expect(sink.assistantTexts).toEqual([]);
  });

  test('flushes unfinished reasoning at idle without losing streamed text', () => {
    const sink = contentEvents();
    const stream = new OpenCodeContentStream(sink.events, () => 'anthropic/claude');

    stream.handlePart(reasoningPart('Thinking'));
    stream.handlePart(textPart('Answer'));
    stream.handleDelta('reasoning-1', 'text', ' more');
    stream.handleDelta('text-1', 'text', ' now');
    stream.flush();

    expect(sink.thinkingDeltas).toEqual(['Thinking', 'Thinking more']);
    expect(sink.assistantDeltas).toEqual(['Answer', 'Answer now']);
    expect(sink.thinkingBlocks).toEqual(['Thinking more']);
    expect(sink.assistantTexts).toEqual(['Answer now']);
  });
});
