/**
 * Plan-usage snapshot for the sidebar's Usage popover.
 *
 * Two providers, two very different sources:
 *
 *   Claude — the same OAuth endpoint the CLI's `/usage` reads. The bearer
 *     token lives in the macOS keychain (item "Claude Code-credentials");
 *     other platforms keep it in `~/.claude/.credentials.json`. We never
 *     refresh the token ourselves: a 401 is reported as "logged out" so the
 *     user re-runs `claude login` rather than us racing the CLI's refresh.
 *
 *   Codex — the app-server's `account/read` + `account/rateLimits/read`
 *     methods. Spawning app-server costs ~1s, which is why the whole
 *     snapshot is TTL-cached.
 *
 * Both are best-effort and independent: one provider failing still returns
 * the other. The UI renders whatever windows come back, so a new limit kind
 * appearing server-side shows up without a client change.
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { CodexAppServer } from '../provider/codex-app-server';

export type UsageSeverity = 'normal' | 'warning' | 'critical';

export type UsageWindow = {
  /** Stable key for React lists; unique within a provider. */
  id: string;
  /** 'session' = short rolling window, 'weekly' = the long one. */
  kind: 'session' | 'weekly' | 'other';
  /** Human label when `kind` is 'other' (an unknown limit from the API). */
  label?: string;
  /** Model or surface the limit applies to, when it isn't account-wide. */
  scope?: string | null;
  percent: number;
  severity: UsageSeverity;
  /** ISO timestamp, or null when the provider reports no reset. */
  resetsAt?: string | null;
  /** The window currently throttling the account. */
  isActive?: boolean;
  /** Window length in minutes, when the provider reports it. */
  windowMinutes?: number;
};

export type UsageCredits = {
  enabled: boolean;
  label: string;
  /** Minor units (cents) so the UI does the formatting. */
  usedMinor?: number | null;
  limitMinor?: number | null;
  currency?: string;
};

export type ProviderUsage = {
  provider: 'claude' | 'codex';
  status: 'ok' | 'logged_out' | 'error';
  account?: { email?: string | null; plan?: string | null };
  windows: UsageWindow[];
  credits?: UsageCredits | null;
  /** Claude only: share of the weekly window per surface. */
  breakdown?: { key: string; label: string; percent: number }[] | null;
  error?: string;
};

export type UsageSnapshot = { fetchedAt: string; providers: ProviderUsage[] };

const CACHE_TTL_OK = 60_000;
const CACHE_TTL_FAIL = 10_000;

let cached: { snapshot: UsageSnapshot; expires: number } | null = null;
let inflight: Promise<UsageSnapshot> | null = null;

export async function getUsageSnapshot(force = false): Promise<UsageSnapshot> {
  if (!force && cached && cached.expires > Date.now()) return cached.snapshot;
  if (inflight) return inflight;
  inflight = (async () => {
    const [claude, codex] = await Promise.all([readClaudeUsage(), readCodexUsage()]);
    return { fetchedAt: new Date().toISOString(), providers: [claude, codex] };
  })();
  const snapshot = await inflight;
  const healthy = snapshot.providers.some(p => p.status === 'ok');
  cached = { snapshot, expires: Date.now() + (healthy ? CACHE_TTL_OK : CACHE_TTL_FAIL) };
  inflight = null;
  return snapshot;
}

/* ------------------------------------------------------------------ Claude */

type ClaudeCredentials = { accessToken: string; subscriptionType?: string | null; rateLimitTier?: string | null; expiresAt?: number };

/**
 * The CLI writes its OAuth blob to the login keychain on macOS and to a
 * dotfile everywhere else. Read both, newest wins — a machine that once ran
 * an older CLI can still have a stale (empty-token) dotfile lying around.
 */
export function readClaudeCredentials(): ClaudeCredentials | null {
  const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv) return { accessToken: fromEnv };

  const candidates: unknown[] = [];
  if (process.platform === 'darwin') {
    try {
      const out = Bun.spawnSync(['security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w']);
      if (out.exitCode === 0) candidates.push(JSON.parse(out.stdout.toString()));
    } catch {}
  }
  try {
    candidates.push(JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf-8')));
  } catch {}

  for (const raw of candidates) {
    const oauth = (raw as any)?.claudeAiOauth;
    if (oauth && typeof oauth.accessToken === 'string' && oauth.accessToken.length > 0) {
      return {
        accessToken: oauth.accessToken,
        subscriptionType: oauth.subscriptionType ?? null,
        rateLimitTier: oauth.rateLimitTier ?? null,
        expiresAt: oauth.expiresAt,
      };
    }
  }
  return null;
}

async function readClaudeUsage(): Promise<ProviderUsage> {
  const creds = readClaudeCredentials();
  if (!creds) return { provider: 'claude', status: 'logged_out', windows: [] };
  try {
    const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        authorization: `Bearer ${creds.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': 'codiby-code (usage-panel)',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.status === 401 || resp.status === 403) {
      return { provider: 'claude', status: 'logged_out', windows: [], error: 'La sesión de Claude expiró' };
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return normalizeClaudeUsage(await resp.json(), creds.subscriptionType ?? null, creds.rateLimitTier ?? null);
  } catch (error) {
    return { provider: 'claude', status: 'error', windows: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** Turn the `/oauth/usage` payload into provider-neutral windows. Exported for tests. */
export function normalizeClaudeUsage(payload: any, subscriptionType: string | null, rateLimitTier: string | null = null): ProviderUsage {
  const windows: UsageWindow[] = [];
  const limits = Array.isArray(payload?.limits) ? payload.limits : [];

  for (const limit of limits) {
    const percent = clampPercent(limit?.percent);
    if (percent === null) continue;
    const scope = limit?.scope?.model?.display_name || limit?.scope?.surface?.display_name || null;
    const kind: UsageWindow['kind'] = limit?.group === 'session' ? 'session' : limit?.group === 'weekly' ? 'weekly' : 'other';
    windows.push({
      id: scope ? `${limit.kind}:${scope}` : String(limit.kind ?? `limit-${windows.length}`),
      kind,
      label: kind === 'other' ? humanize(String(limit?.kind ?? 'limit')) : undefined,
      scope,
      percent,
      severity: normalizeSeverity(limit?.severity, percent),
      resetsAt: limit?.resets_at ?? null,
      isActive: Boolean(limit?.is_active),
    });
  }

  // Older payloads (and any response where `limits` is missing) still carry
  // the two flat windows, so fall back rather than showing an empty panel.
  if (windows.length === 0) {
    for (const [key, kind] of [['five_hour', 'session'], ['seven_day', 'weekly']] as const) {
      const percent = clampPercent(payload?.[key]?.utilization);
      if (percent === null) continue;
      windows.push({ id: key, kind, percent, severity: normalizeSeverity(null, percent), resetsAt: payload[key]?.resets_at ?? null });
    }
  }

  const spend = payload?.spend;
  const credits: UsageCredits | null = spend
    ? {
        enabled: Boolean(spend.enabled),
        label: spend.enabled ? 'Créditos extra' : 'Créditos extra desactivados',
        usedMinor: spend.used?.amount_minor ?? null,
        limitMinor: spend.limit?.amount_minor ?? null,
        currency: spend.used?.currency || 'USD',
      }
    : null;

  const rows = payload?.seven_day_breakdown?.rows;
  const breakdown = Array.isArray(rows)
    ? rows
        .map((r: any) => ({ key: String(r?.key ?? ''), label: String(r?.display_name ?? r?.key ?? ''), percent: clampPercent(r?.percent) ?? 0 }))
        .filter((r: { key: string }) => r.key.length > 0)
    : null;

  return {
    provider: 'claude',
    status: 'ok',
    account: { plan: formatClaudePlan(subscriptionType, rateLimitTier) },
    windows: sortWindows(windows),
    credits,
    breakdown,
  };
}

/**
 * `subscriptionType` is only ever "max"/"pro"; the multiplier that people
 * actually think of their plan as lives in `rateLimitTier`, e.g.
 * "default_claude_max_20x" → "Max 20×".
 */
export function formatClaudePlan(subscriptionType: string | null, rateLimitTier: string | null): string | null {
  const base = subscriptionType === 'max' ? 'Max' : subscriptionType === 'pro' ? 'Pro' : subscriptionType ? humanize(subscriptionType) : null;
  const multiplier = rateLimitTier?.match(/_(\d+)x$/)?.[1];
  if (base && multiplier) return `${base} ${multiplier}×`;
  return base;
}

/* ------------------------------------------------------------------- Codex */

async function readCodexUsage(): Promise<ProviderUsage> {
  let rpc: CodexAppServer | null = null;
  try {
    rpc = new CodexAppServer({ notification() {}, async request(method) { throw new Error(`Unexpected usage request: ${method}`); }, exit() {} });
    const [account, limits] = await Promise.all([
      rpc.request<any>('account/read', {}),
      rpc.request<any>('account/rateLimits/read', {}),
    ]);
    if (!account?.account) return { provider: 'codex', status: 'logged_out', windows: [] };
    return normalizeCodexUsage(account, limits);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A codex that isn't installed is not an error worth a red panel — the
    // UI hides the provider entirely when it reports logged out.
    if (/runtime is missing|ENOENT|not found/i.test(message)) return { provider: 'codex', status: 'logged_out', windows: [] };
    return { provider: 'codex', status: 'error', windows: [], error: message };
  } finally {
    await rpc?.close().catch(() => {});
  }
}

/** Turn `account/read` + `account/rateLimits/read` into provider-neutral windows. Exported for tests. */
export function normalizeCodexUsage(account: any, limits: any): ProviderUsage {
  const rate = limits?.rateLimits;
  const windows: UsageWindow[] = [];
  for (const [key, raw] of [['primary', rate?.primary], ['secondary', rate?.secondary]] as const) {
    const percent = clampPercent(raw?.usedPercent);
    if (percent === null) continue;
    const minutes = typeof raw?.windowDurationMins === 'number' ? raw.windowDurationMins : undefined;
    windows.push({
      id: key,
      kind: minutes != null && minutes >= 1440 ? 'weekly' : 'session',
      scope: null,
      percent,
      severity: normalizeSeverity(null, percent),
      resetsAt: typeof raw?.resetsAt === 'number' ? new Date(raw.resetsAt * 1000).toISOString() : null,
      windowMinutes: minutes,
    });
  }

  // A plan with no credit balance and no unlimited flag has nothing to say —
  // an "$0.00" row is noise next to the bar that actually matters.
  const c = rate?.credits;
  const credits: UsageCredits | null = c && (c.hasCredits || c.unlimited)
    ? {
        enabled: Boolean(c.hasCredits) || Boolean(c.unlimited),
        label: c.unlimited ? 'Créditos ilimitados' : c.hasCredits ? 'Créditos' : 'Sin créditos',
        // `balance` is a decimal string of currency units; the UI works in minor units.
        usedMinor: null,
        limitMinor: c.unlimited ? null : toMinorUnits(c.balance),
        currency: 'USD',
      }
    : null;

  return {
    provider: 'codex',
    status: 'ok',
    account: { email: account?.account?.email ?? null, plan: formatCodexPlan(account?.account?.planType ?? rate?.planType ?? null) },
    windows: sortWindows(windows),
    credits,
  };
}

/** Codex plan ids are lowercase and unspaced ("prolite", "plus"). */
export function formatCodexPlan(planType: unknown): string | null {
  const id = typeof planType === 'string' ? planType.toLowerCase() : '';
  const known: Record<string, string> = { free: 'Free', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', business: 'Business', team: 'Team', enterprise: 'Enterprise', edu: 'Edu' };
  return known[id] ?? (humanize(id) || null);
}

function toMinorUnits(balance: unknown): number | null {
  const value = typeof balance === 'string' ? Number(balance) : typeof balance === 'number' ? balance : NaN;
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

/* ------------------------------------------------------------------ shared */

function clampPercent(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeSeverity(reported: unknown, percent: number): UsageSeverity {
  if (reported === 'critical' || reported === 'warning' || reported === 'normal') return reported;
  if (percent >= 90) return 'critical';
  if (percent >= 75) return 'warning';
  return 'normal';
}

/** Short windows first, then the long ones, then whatever we didn't recognise. */
function sortWindows(windows: UsageWindow[]): UsageWindow[] {
  const rank: Record<UsageWindow['kind'], number> = { session: 0, weekly: 1, other: 2 };
  // Account-wide limits read first; per-model ones are the detail underneath.
  return windows.slice().sort((a, b) => rank[a.kind] - rank[b.kind] || Number(Boolean(a.scope)) - Number(Boolean(b.scope)) || a.percent - b.percent);
}

function humanize(value: string): string {
  if (!value) return '';
  const spaced = value.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
