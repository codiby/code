import { describe, expect, test } from 'bun:test';
import { compareVersions, parseVersion } from './claude-update';

describe('parseVersion', () => {
  test('extracts the semver from `claude --version` output', () => {
    expect(parseVersion('2.1.289 (Claude Code)')).toBe('2.1.289');
  });

  test('returns null when there is no version', () => {
    expect(parseVersion('command not found')).toBeNull();
  });
});

describe('compareVersions', () => {
  test('orders numerically, not lexically', () => {
    expect(compareVersions('2.1.289', '2.1.1000')).toBeLessThan(0);
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
  });

  test('equal versions compare to zero', () => {
    expect(compareVersions('2.1.292', '2.1.292')).toBe(0);
  });
});
