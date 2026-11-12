import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  KEYCHAIN_TIMEOUT_MS,
  formatClaudePlan,
  formatCodexPlan,
  loadClaudeCredentials,
  normalizeClaudeUsage,
  normalizeCodexUsage,
  readClaudeKeychain,
  readClaudeUsage,
} from './usage';

// Trimmed copies of real payloads: the shapes below are what
// api.anthropic.com/api/oauth/usage and codex's account/* methods return.
const claudePayload = {
  five_hour: { utilization: 14.0, resets_at: '2026-09-19T09:50:00Z' },
  seven_day: { utilization: 67.0, resets_at: '2026-09-20T16:00:00Z' },
  limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 100, severity: 'critical', resets_at: '2026-09-20T15:59:59Z', scope: { model: { id: null, display_name: 'Fable' } }, is_active: true },
    { kind: 'session', group: 'session', percent: 14, severity: 'normal', resets_at: '2026-09-19T09:50:00Z', scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 67, severity: 'normal', resets_at: '2026-09-20T16:00:00Z', scope: null, is_active: false },
  ],
  spend: { used: { amount_minor: 1141, currency: 'USD' }, limit: { amount_minor: 15000 }, enabled: false },
  seven_day_breakdown: { rows: [{ key: 'claude_code', display_name: 'Claude Code', percent: 100 }, { key: 'chat', display_name: 'Chats', percent: 0 }] },
};

describe('normalizeClaudeUsage', () => {
  it('orders session before weekly, and account-wide before per-model', () => {
    const usage = normalizeClaudeUsage(claudePayload, 'max', 'default_claude_max_20x');
    expect(usage.windows.map(w => w.id)).toEqual(['session', 'weekly_all', 'weekly_scoped:Fable']);
    expect(usage.windows[2]).toMatchObject({ scope: 'Fable', percent: 100, severity: 'critical', isActive: true });
    expect(usage.account?.plan).toBe('Max 20×');
  });

  it('carries credits and the weekly breakdown through', () => {
    const usage = normalizeClaudeUsage(claudePayload, 'max', null);
    expect(usage.credits).toMatchObject({ enabled: false, usedMinor: 1141, limitMinor: 15000, currency: 'USD' });
    expect(usage.breakdown).toEqual([
      { key: 'claude_code', label: 'Claude Code', percent: 100 },
      { key: 'chat', label: 'Chats', percent: 0 },
    ]);
  });

  it('falls back to the flat windows when `limits` is absent', () => {
    const { limits, ...withoutLimits } = claudePayload;
    const usage = normalizeClaudeUsage(withoutLimits, 'pro', null);
    expect(usage.windows.map(w => [w.id, w.percent])).toEqual([['five_hour', 14], ['seven_day', 67]]);
    // No severity from the API at this layer, so it is derived from percent.
    expect(usage.windows[1].severity).toBe('normal');
  });

  it('derives severity from the percentage when the API omits it', () => {
    const usage = normalizeClaudeUsage({ limits: [{ kind: 'session', group: 'session', percent: 92, scope: null }] }, null, null);
    expect(usage.windows[0].severity).toBe('critical');
  });
});

describe('normalizeCodexUsage', () => {
  const account = { account: { type: 'chatgpt', email: 'dev@example.com', planType: 'prolite' } };
  const limits = {
    rateLimits: {
      primary: { usedPercent: 98, windowDurationMins: 10080, resetsAt: 1790006317 },
      secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1789900000 },
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      planType: 'prolite',
    },
  };

  it('maps both windows, converting unix seconds and window length', () => {
    const usage = normalizeCodexUsage(account, limits);
    expect(usage.windows.map(w => [w.id, w.kind, w.percent])).toEqual([['secondary', 'session', 12], ['primary', 'weekly', 98]]);
    expect(usage.windows[1].resetsAt).toBe(new Date(1790006317 * 1000).toISOString());
    expect(usage.windows[1].severity).toBe('critical');
    expect(usage.account).toEqual({ email: 'dev@example.com', plan: 'Pro Lite' });
  });

  it('skips a missing secondary window instead of emitting a zero bar', () => {
    const usage = normalizeCodexUsage(account, { rateLimits: { ...limits.rateLimits, secondary: null } });
    expect(usage.windows).toHaveLength(1);
  });

  it('omits the credits row for a plan with no balance, and keeps it otherwise', () => {
    expect(normalizeCodexUsage(account, limits).credits).toBeNull();
    const withCredits = normalizeCodexUsage(account, {
      rateLimits: { ...limits.rateLimits, credits: { hasCredits: true, unlimited: false, balance: '12.50' } },
    });
    expect(withCredits.credits).toMatchObject({ enabled: true, label: 'Credits', limitMinor: 1250 });
  });
});

describe('plan labels', () => {
  it('appends the rate-limit multiplier only when present', () => {
    expect(formatClaudePlan('max', 'default_claude_max_5x')).toBe('Max 5×');
    expect(formatClaudePlan('max', null)).toBe('Max');
    expect(formatClaudePlan(null, 'default_claude_max_20x')).toBeNull();
  });

  it('humanizes unknown codex plans rather than dropping them', () => {
    expect(formatCodexPlan('prolite')).toBe('Pro Lite');
    expect(formatCodexPlan('some_new_plan')).toBe('Some new plan');
    expect(formatCodexPlan(null)).toBeNull();
  });
});

describe('Claude keychain lookup', () => {
  type Call = { cmd: string[]; opts: { timeout: number } };
  const fakeSpawn = (result: { exitCode: number | null; exitedDueToTimeout?: boolean; signalCode?: string | null; stdout?: string }, calls: Call[] = []) =>
    (cmd: string[], opts: { timeout: number; stdout: 'pipe'; stderr: 'pipe' }) => {
      calls.push({ cmd, opts });
      return { ...result, stdout: Buffer.from(result.stdout ?? '') };
    };
  const blob = JSON.stringify({ claudeAiOauth: { accessToken: 'tok', subscriptionType: 'max' } });
  const noFile = join(tmpdir(), 'codiby-usage-test-missing', '.credentials.json');

  it('bounds the security call with a timeout', () => {
    const calls: Call[] = [];
    expect(readClaudeKeychain(fakeSpawn({ exitCode: 0, stdout: blob }, calls)).status).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd.slice(0, 2)).toEqual(['security', 'find-generic-password']);
    expect(calls[0]!.opts.timeout).toBe(KEYCHAIN_TIMEOUT_MS);
    expect(KEYCHAIN_TIMEOUT_MS).toBe(5000);
  });

  it('reports a timed-out or killed lookup as unavailable, not missing', () => {
    expect(readClaudeKeychain(fakeSpawn({ exitCode: null, exitedDueToTimeout: true })).status).toBe('unavailable');
    expect(readClaudeKeychain(fakeSpawn({ exitCode: null, signalCode: 'SIGTERM' })).status).toBe('unavailable');
    expect(readClaudeKeychain(() => { throw new Error('ENOENT'); }).status).toBe('unavailable');
    expect(readClaudeKeychain(fakeSpawn({ exitCode: 44 })).status).toBe('missing');
    expect(readClaudeKeychain(fakeSpawn({ exitCode: 0, stdout: 'not json' })).status).toBe('missing');
  });

  it('falls back to the dotfile when the keychain times out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codiby-usage-'));
    try {
      const file = join(dir, '.credentials.json');
      writeFileSync(file, blob);
      const read = loadClaudeCredentials({ env: {}, platform: 'darwin', credentialsFile: file, spawn: fakeSpawn({ exitCode: null, exitedDueToTimeout: true }) });
      expect(read.credentials?.accessToken).toBe('tok');
      expect(read.keychain?.status).toBe('unavailable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a timed-out keychain with no other login is an error, not logged out', async () => {
    const usage = await readClaudeUsage({ env: {}, platform: 'darwin', credentialsFile: noFile, spawn: fakeSpawn({ exitCode: null, exitedDueToTimeout: true }) });
    expect(usage.status).toBe('error');
    expect(usage.error).toContain('unavailable');
    expect(usage.windows).toEqual([]);
  });

  it('no keychain item and no dotfile is logged out', async () => {
    const usage = await readClaudeUsage({ env: {}, platform: 'darwin', credentialsFile: noFile, spawn: fakeSpawn({ exitCode: 44 }) });
    expect(usage.status).toBe('logged_out');
  });

  it('skips the keychain off macOS', () => {
    const calls: Call[] = [];
    const read = loadClaudeCredentials({ env: {}, platform: 'linux', credentialsFile: noFile, spawn: fakeSpawn({ exitCode: 0, stdout: blob }, calls) });
    expect(calls).toHaveLength(0);
    expect(read.credentials).toBeNull();
    expect(read.keychain).toBeNull();
  });
});
