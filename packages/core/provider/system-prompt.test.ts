import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import {
  CODIBY_CODE_SYSTEM_PROMPT_APPEND,
  codibySystemPrompt,
  removeOpencodeInstructions,
  writeOpencodeInstructions,
} from './system-prompt';
import { ALWAYS_AUTO_APPROVE_TOOLS } from '../config/config';

describe('Codiby system prompt', () => {
  test('names a rename tool each provider can actually reach', () => {
    // Only Claude gets the in-process SDK server; Codex and OpenCode cannot
    // re-host one, so the prompt has to offer the HTTP tool as the fallback or
    // two of the three providers are told to call something they don't have.
    expect(CODIBY_CODE_SYSTEM_PROMPT_APPEND).toContain('rename_session');
    expect(CODIBY_CODE_SYSTEM_PROMPT_APPEND).toContain('ui_rename_session');
    for (const tool of ['mcp__codiby-code-sdk__rename_session', 'mcp__codiby-code__ui_rename_session']) {
      expect(ALWAYS_AUTO_APPROVE_TOOLS.has(tool)).toBe(true);
    }
  });

  test('tells every provider to link PRs without being asked', () => {
    expect(CODIBY_CODE_SYSTEM_PROMPT_APPEND).toContain('ui_link_pr');
    expect(CODIBY_CODE_SYSTEM_PROMPT_APPEND).toContain('AUTOMATICALLY');
    expect(CODIBY_CODE_SYSTEM_PROMPT_APPEND).toContain('MORE THAN ONE link');
  });

  test('appends the per-session extra rather than replacing the shared block', () => {
    const composed = codibySystemPrompt('Remote viewer briefing.');

    expect(composed.startsWith(CODIBY_CODE_SYSTEM_PROMPT_APPEND)).toBe(true);
    expect(composed).toEndWith('Remote viewer briefing.');
    expect(codibySystemPrompt(null)).toBe(CODIBY_CODE_SYSTEM_PROMPT_APPEND);
  });

  test('materializes an instruction file for opencode and cleans it up', () => {
    const sessionId = `sys-prompt-test-${crypto.randomUUID()}`;
    const path = writeOpencodeInstructions(sessionId, 'Remote viewer briefing.');

    expect(path).not.toBeNull();
    // OpenCode reads instruction *files*; the content has to be the prompt
    // itself, not a path or a JSON wrapper.
    expect(readFileSync(path!, 'utf-8')).toBe(codibySystemPrompt('Remote viewer briefing.'));

    removeOpencodeInstructions(sessionId);
    expect(() => readFileSync(path!, 'utf-8')).toThrow();
  });

  test('removing an instruction file that was never written is a no-op', () => {
    expect(() => removeOpencodeInstructions('never-existed')).not.toThrow();
  });
});
