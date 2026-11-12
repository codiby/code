import { describe, expect, test } from 'bun:test';

import { turnCompleteFromResult } from './claude';
import { providerFailure } from '../../agent/dispatch';

describe('turnCompleteFromResult', () => {
  test('a successful result is not an error', () => {
    const info = turnCompleteFromResult({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      stop_reason: 'end_turn',
      total_cost_usd: 0.01,
      duration_ms: 1200,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(info.isError).toBe(false);
    expect(info.errors).toBeUndefined();
    expect(info.resultText).toBe('Done.');
    expect(info.stopReason).toBe('end_turn');
    expect(info.costUsd).toBe(0.01);
    expect(info.durationMs).toBe(1200);
    expect(providerFailure(info, [])).toBeNull();
  });

  test('is_error marks the turn failed and the dispatch relays the result text', () => {
    const info = turnCompleteFromResult({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Not logged in · Please run /login',
    });
    expect(info.isError).toBe(true);
    expect(providerFailure(info, [])).toBe('Not logged in · Please run /login');
  });

  test('an error_* subtype marks the turn failed and carries its errors', () => {
    const info = turnCompleteFromResult({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: false,
      errors: ['Upstream overloaded', 42, null],
      stop_reason: null,
    });
    expect(info.isError).toBe(true);
    // Non-string entries are dropped so the dispatch can trim each one.
    expect(info.errors).toEqual(['Upstream overloaded']);
    expect(info.resultText).toBeUndefined();
    expect(providerFailure(info, [])).toBe('Upstream overloaded');
  });

  test('error_max_turns without details still reads as a failure', () => {
    const info = turnCompleteFromResult({ type: 'result', subtype: 'error_max_turns' });
    expect(info.isError).toBe(true);
    expect(info.errors).toBeUndefined();
    expect(providerFailure(info, [])).toBe('The agent\'s turn failed with a provider error.');
  });

  test('a result with no subtype and no flag is not an error', () => {
    const info = turnCompleteFromResult({ type: 'result', result: 'ok' });
    expect(info.isError).toBe(false);
    expect(info.stopReason).toBeNull();
  });

  test('non-array errors are ignored', () => {
    const info = turnCompleteFromResult({ type: 'result', subtype: 'error_during_execution', errors: 'boom' });
    expect(info.errors).toBeUndefined();
  });
});
