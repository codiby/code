/**
 * Data behind the Overview screen: for a set of sessions (the sidebar's
 * current project scope) over the last N days, how much was spent, how many
 * tokens each provider used, how many sessions were worked in, what landed in
 * git, and how many PRs were opened and merged — each with the previous
 * period for the deltas.
 *
 * Usage comes from the message logs (see usage-scan.ts). Git and GitHub
 * numbers come from the repos those sessions run in, and are cached briefly
 * because `gh` goes over the network.
 */

import { join } from 'path';
import { CODIBY_DIR } from '../config/config';
import { sessions } from '../session/sessions';
import { runShell } from '../handlers/git';
import { dayKey, usageForFile } from './usage-scan';

export interface OverviewRequest {
  sessionIds: string[];
  days: number;
}

export interface OverviewResponse {
  /** Day keys, oldest first; `days` long. */
  days: string[];
  /** Tokens per day, per provider (`claude`, `codex`, `opencode`, …). */
  tokensByProvider: Record<string, number[]>;
  spend: { total: number; previous: number; daily: number[] };
  sessions: { active: number; previous: number; daily: number[] };
  lines: { additions: number; deletions: number; daily: number[] } | null;
  prs: { merged: number; opened: number; daily: number[] } | null;
  /** Branch and uncommitted +/- for each session's folder. */
  perSession: Record<string, { branch: string | null; additions: number; deletions: number }>;
}

const DAY_MS = 86_400_000;

function windowKeys(days: number, endTs: number): string[] {
  const out: string[] = [];
  const end = new Date(endTs);
  end.setHours(12, 0, 0, 0);    // noon: DST shifts can't push a step into the wrong day
  for (let i = days - 1; i >= 0; i--) out.push(dayKey(end.getTime() - i * DAY_MS));
  return out;
}

// ── git / gh, cached ───────────────────────────────────────────────────────

const shellCache = new Map<string, { at: number; value: Promise<string | null> }>();
function cachedShell(cmd: string, cwd: string, ttlMs: number, timeout = 8000): Promise<string | null> {
  const key = `${cwd}\0${cmd}`;
  const hit = shellCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = runShell(cmd, cwd, timeout).then(s => s, () => null);
  shellCache.set(key, { at: Date.now(), value });
  return value;
}

async function folderGit(cwd: string): Promise<{ top: string | null; branch: string | null; additions: number; deletions: number }> {
  const [top, branch, numstat] = await Promise.all([
    cachedShell('git rev-parse --show-toplevel', cwd, 300_000),
    cachedShell('git rev-parse --abbrev-ref HEAD', cwd, 30_000),
    cachedShell('git diff --numstat HEAD', cwd, 30_000),
  ]);
  let additions = 0, deletions = 0;
  for (const line of (numstat ?? '').split('\n')) {
    const [a, d] = line.split('\t');
    if (a && a !== '-') additions += Number(a) || 0;
    if (d && d !== '-') deletions += Number(d) || 0;
  }
  return { top: top?.trim() || null, branch: branch?.trim() || null, additions, deletions };
}

/** Lines added/removed per day by the repo's own user, across all branches.
 *  Commit hashes are returned so worktrees of one repo count once. */
async function repoLines(top: string, sinceTs: number): Promise<Map<string, { day: string; add: number; del: number }>> {
  const out = new Map<string, { day: string; add: number; del: number }>();
  const email = (await cachedShell('git config user.email', top, 300_000))?.trim();
  if (!email) return out;
  const since = new Date(sinceTs).toISOString();
  const log = await cachedShell(
    `git log --all --no-merges --author=${JSON.stringify(email)} --since=${JSON.stringify(since)} --numstat --pretty=format:@%H\\ %ct`,
    top, 60_000, 15000,
  );
  let cur: { day: string; add: number; del: number } | null = null;
  for (const line of (log ?? '').split('\n')) {
    if (line.startsWith('@')) {
      const [hash, ct] = line.slice(1).split(' ');
      cur = { day: dayKey(Number(ct) * 1000), add: 0, del: 0 };
      if (hash) out.set(hash, cur);
      continue;
    }
    if (!cur || !line) continue;
    const [a, d] = line.split('\t');
    if (a && a !== '-') cur.add += Number(a) || 0;
    if (d && d !== '-') cur.del += Number(d) || 0;
  }
  return out;
}

async function repoPrs(top: string, sinceTs: number): Promise<{ repo: string; created: number[]; merged: number[] } | null> {
  const since = dayKey(sinceTs);
  const raw = await cachedShell(
    `gh pr list --state all --author @me --search ${JSON.stringify(`created:>=${since}`)} --json number,createdAt,mergedAt,url --limit 200`,
    top, 300_000, 12000,
  );
  if (!raw) return null;
  try {
    const list = JSON.parse(raw) as { url: string; createdAt: string; mergedAt: string | null }[];
    const repo = list[0]?.url.replace(/\/pull\/\d+$/, '') ?? top;
    return {
      repo,
      created: list.map(p => Date.parse(p.createdAt)),
      merged: list.filter(p => p.mergedAt).map(p => Date.parse(p.mergedAt!)),
    };
  } catch { return null; }
}

// ── assembly ───────────────────────────────────────────────────────────────

export async function buildOverview(req: OverviewRequest, now = Date.now()): Promise<OverviewResponse> {
  const days = Math.max(1, Math.min(90, Math.floor(req.days) || 7));
  const keys = windowKeys(days, now);
  const prevKeys = windowKeys(days, now - days * DAY_MS);
  const index = new Map(keys.map((k, i) => [k, i]));
  const prevSet = new Set(prevKeys);

  const tokensByProvider: Record<string, number[]> = {};
  const spendDaily = keys.map(() => 0);
  const activeDaily = keys.map(() => 0);
  let spendPrev = 0;
  let activeNow = 0, activePrev = 0;

  // Remote sessions keep their logs on their own host; only local ones count.
  const local = req.sessionIds.map(id => sessions.get(id)).filter((s): s is NonNullable<typeof s> => !!s);

  for (const s of local) {
    const usage = usageForFile(join(CODIBY_DIR, 'ui-sessions', s.id, 'messages.jsonl'));
    const provider = s.provider || 'claude';
    let wasActive = false, wasActivePrev = false;
    for (const [day, u] of usage) {
      const i = index.get(day);
      if (i !== undefined) {
        (tokensByProvider[provider] ??= keys.map(() => 0))[i]! += u.tokens;
        spendDaily[i]! += u.costUsd;
        if (u.userMessages > 0) { activeDaily[i]! += 1; wasActive = true; }
      } else if (prevSet.has(day)) {
        spendPrev += u.costUsd;
        if (u.userMessages > 0) wasActivePrev = true;
      }
    }
    if (wasActive) activeNow += 1;
    if (wasActivePrev) activePrev += 1;
  }

  // Git per folder, then per repo.
  const folders = [...new Set(local.map(s => s.cwd))];
  const git = new Map(await Promise.all(folders.map(async cwd => [cwd, await folderGit(cwd)] as const)));
  const perSession: OverviewResponse['perSession'] = {};
  for (const s of local) {
    const g = git.get(s.cwd);
    perSession[s.id] = { branch: g?.branch ?? null, additions: g?.additions ?? 0, deletions: g?.deletions ?? 0 };
  }

  const tops = [...new Set([...git.values()].map(g => g.top).filter((t): t is string => !!t))];
  const windowStart = new Date(now - (days - 1) * DAY_MS);
  windowStart.setHours(0, 0, 0, 0);
  const sinceTs = windowStart.getTime();

  let lines: OverviewResponse['lines'] = null;
  let prs: OverviewResponse['prs'] = null;
  if (tops.length) {
    const [lineMaps, prLists] = await Promise.all([
      Promise.all(tops.map(t => repoLines(t, sinceTs))),
      Promise.all(tops.map(t => repoPrs(t, sinceTs))),
    ]);
    const commits = new Map<string, { day: string; add: number; del: number }>();
    for (const m of lineMaps) for (const [h, c] of m) commits.set(h, c);
    const daily = keys.map(() => 0);
    let additions = 0, deletions = 0;
    for (const c of commits.values()) {
      const i = index.get(c.day);
      if (i === undefined) continue;
      additions += c.add; deletions += c.del; daily[i]! += c.add + c.del;
    }
    lines = { additions, deletions, daily };

    const seenRepo = new Set<string>();
    const okLists = prLists.filter((p): p is NonNullable<typeof p> => !!p && !seenRepo.has(p.repo) && !!seenRepo.add(p.repo));
    if (okLists.length) {
      const mergedDaily = keys.map(() => 0);
      let merged = 0, opened = 0;
      for (const p of okLists) {
        for (const t of p.created) if (index.has(dayKey(t))) opened += 1;
        for (const t of p.merged) {
          const i = index.get(dayKey(t));
          if (i !== undefined) { merged += 1; mergedDaily[i]! += 1; }
        }
      }
      prs = { merged, opened, daily: mergedDaily };
    }
  }

  return {
    days: keys,
    tokensByProvider,
    spend: { total: spendDaily.reduce((a, b) => a + b, 0), previous: spendPrev, daily: spendDaily },
    sessions: { active: activeNow, previous: activePrev, daily: activeDaily },
    lines,
    prs,
    perSession,
  };
}
