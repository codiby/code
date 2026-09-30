import { describe, expect, test } from 'bun:test';
import { defaultModelLabel, readDefaultModels, resolveModelArg } from './default-models';

const claude = [
  { id: 'default', label: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { id: 'opus', label: 'Opus 5.5' },
  { id: 'sonnet', label: 'Sonnet 5' },
];

describe('defaultModelLabel', () => {
  test('names the configured model by its label', () => {
    expect(defaultModelLabel('sonnet', claude)).toBe('Sonnet 5');
  });
  test('falls back to the raw id for an unknown model', () => {
    expect(defaultModelLabel('claude-x', claude)).toBe('claude-x');
  });
  test("reads Claude's own default from the SDK entry", () => {
    expect(defaultModelLabel(undefined, claude)).toBe('Opus 5.5');
  });
  test("reads Codex's isDefault flag", () => {
    expect(defaultModelLabel(undefined, [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', isDefault: true }])).toBe('B');
  });
  test('includes the provider name for OpenCode models', () => {
    expect(defaultModelLabel('x/y', [{ id: 'x/y', label: 'Y', providerName: 'X' }])).toBe('X Y');
  });
  test('null when nothing is known', () => {
    expect(defaultModelLabel(undefined, [])).toBeNull();
  });
});

test('resolveModelArg matches id or label case-insensitively', () => {
  expect(resolveModelArg('Sonnet 5', claude)).toBe('sonnet');
  expect(resolveModelArg('OPUS', claude)).toBe('opus');
  expect(resolveModelArg('claude-opus-4-8', claude)).toBe('claude-opus-4-8');
});

test('readDefaultModels drops non-string and blank entries', () => {
  expect(readDefaultModels({ defaultModels: { claude: 'opus', codex: '', opencode: 3 } })).toEqual({ claude: 'opus' });
  expect(readDefaultModels({})).toEqual({});
});
