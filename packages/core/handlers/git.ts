import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { corsHeaders } from '../config/config';
import { detectPackageManager } from './files';

const pExec = promisify(exec);

/** Run a git/shell command *off* the event loop. Mirrors the old `execSync`
 *  calls (shell semantics, cwd, timeout, throws on non-zero exit) but never
 *  blocks the single-threaded bridge — a slow git invocation (e.g. while a
 *  `bun install` saturates the disk) no longer freezes every other session.
 *  On non-zero exit it rejects with an Error carrying `.stdout`/`.stderr`/
 *  `.code`, exactly like Node's `exec`, so existing catch blocks still work. */
export async function runShell(cmd: string, cwd?: string, timeout = 5000): Promise<string> {
  const { stdout } = await pExec(cmd, {
    cwd,
    encoding: 'utf-8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout as string;
}

/** Where the current branch was created, read from its reflog entry
 *  ("branch: Created from <ref>"). `sha` is the commit the branch started at;
 *  `parent` is the ref it was cut from when that ref still exists and isn't
 *  the branch itself / bare HEAD / a raw sha. Returns null when there is no
 *  creation entry (clones, expired reflogs, detached HEAD). */
export async function branchOrigin(root: string): Promise<{ sha: string; parent: string | null } | null> {
  let branch = '';
  try { branch = (await runShell('git branch --show-current', root)).trim(); } catch {}
  if (!branch) return null;
  let entry = '';
  try {
    const out = await runShell(`git reflog show --format="%H %gs" ${JSON.stringify('refs/heads/' + branch)}`, root);
    entry = out.trim().split('\n').pop() || '';
  } catch {}
  const m = entry.match(/^([0-9a-f]{40}) branch: Created from (.+)$/i);
  if (!m) return null;
  const sha = m[1]!;
  let parent: string | null = m[2]!.trim().replace(/^refs\/(heads|remotes)\//, '');
  if (parent === 'HEAD' || parent === branch || /^[0-9a-f]{7,40}$/i.test(parent)) parent = null;
  if (parent) {
    try {
      await runShell(`git rev-parse --verify --quiet ${JSON.stringify(parent + '^{commit}')}`, root);
    } catch { parent = null; }
  }
  return { sha, parent };
}

/** The commit to diff against for a "vs <base>" comparison: the point where
 *  the current branch actually forked, so only work introduced on the branch
 *  since it was created shows up. Candidates are the branch's reflog creation
 *  point (and the ref it was cut from — which may not be `base` at all for
 *  stacked branches) plus the local and remote tips of `base`; the newest
 *  merge-base with HEAD wins. Taking the newest keeps a stale ref from
 *  dragging the fork point back, and advances past upstream commits the
 *  branch merged in later. When HEAD *is* the base branch the merge-base is
 *  HEAD itself, so the comparison degrades to uncommitted work only.
 *  Returns null when nothing resolves. */
export async function baseDiffRef(root: string, base: string): Promise<string | null> {
  const origin = await branchOrigin(root);
  const candidates = [base, `origin/${base}`];
  if (origin?.parent) candidates.push(origin.parent, `origin/${origin.parent}`);
  if (origin) candidates.push(origin.sha);
  let best: string | null = null;
  for (const ref of new Set(candidates)) {
    let mb = '';
    try {
      mb = (await runShell(`git merge-base ${JSON.stringify(ref)} HEAD`, root)).trim();
    } catch {}
    if (!mb || mb === best) continue;
    if (!best) { best = mb; continue; }
    try {
      await runShell(`git merge-base --is-ancestor ${JSON.stringify(best)} ${JSON.stringify(mb)}`, root);
      best = mb;
    } catch {}
  }
  return best;
}

/** Per-file added/deleted line counts from `git diff --numstat <args>`, keyed by
 *  repo-root-relative path. Binary files report `-` and map to 0/0. */
async function numstatMap(root: string, args: string): Promise<Map<string, { additions: number; deletions: number }>> {
  const m = new Map<string, { additions: number; deletions: number }>();
  try {
    const out = await runShell(`git diff --numstat ${args}`.trim(), root);
    for (const line of out.split('\n')) {
      if (!line) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const [a, d, ...rest] = parts;
      const path = rest.join('\t');
      m.set(path, {
        additions: a === '-' ? 0 : (parseInt(a, 10) || 0),
        deletions: d === '-' ? 0 : (parseInt(d, 10) || 0),
      });
    }
  } catch {}
  return m;
}

type ModifiedFile = { path: string; staged: boolean; untracked?: boolean; additions?: number; deletions?: number };

export async function handleGitModified(root: string, base?: string | null): Promise<Response> {
  try {
    const gitTop = (await runShell('git rev-parse --show-toplevel', root)).trim();

    // "vs main" mode: every path that differs from the merge-base — committed
    // on this branch plus anything uncommitted — rendered as one flat list.
    if (base) {
      const ref = (await baseDiffRef(root, base)) || base;
      let changed: string[] = [];
      try {
        changed = (await runShell(`git diff --name-only ${JSON.stringify(ref)}`, root)).split('\n').filter(Boolean);
      } catch {}
      const stats = await numstatMap(root, JSON.stringify(ref));
      const untracked = (await runShell('git ls-files --others --exclude-standard', root)).split('\n').filter(Boolean);
      const untrackedSet = new Set(untracked.map(f => resolve(gitTop, f)));
      const result: ModifiedFile[] = [];
      const seen = new Set<string>();
      for (const f of [...changed, ...untracked]) {
        const p = resolve(gitTop, f);
        if (!p.startsWith(root) || seen.has(p)) continue;
        seen.add(p);
        const st = stats.get(f);
        result.push({ path: p, staged: false, untracked: untrackedSet.has(p) || undefined, additions: st?.additions, deletions: st?.deletions });
      }
      return Response.json(result, { headers: corsHeaders });
    }

    const unstaged = (await runShell('git diff --name-only', root)).split('\n').filter(Boolean);
    const staged = (await runShell('git diff --name-only --cached', root)).split('\n').filter(Boolean);
    const untracked = (await runShell('git ls-files --others --exclude-standard', root)).split('\n').filter(Boolean);

    const stagedStats = await numstatMap(root, '--cached');
    const unstagedStats = await numstatMap(root, '');

    const result: ModifiedFile[] = [];
    const stagedSet = new Set<string>();
    const untrackedSet = new Set(untracked.map(f => resolve(gitTop, f)));

    for (const f of staged) {
      const p = resolve(gitTop, f);
      if (!p.startsWith(root)) continue;
      stagedSet.add(p);
      const st = stagedStats.get(f);
      result.push({ path: p, staged: true, additions: st?.additions, deletions: st?.deletions });
    }
    // Files with unstaged changes (including those also staged — shown in both sections)
    const unstagedSeen = new Set<string>();
    for (const f of [...unstaged, ...untracked]) {
      const p = resolve(gitTop, f);
      if (!p.startsWith(root) || unstagedSeen.has(p)) continue;
      unstagedSeen.add(p);
      const st = unstagedStats.get(f);
      result.push({ path: p, staged: false, untracked: untrackedSet.has(p) || undefined, additions: st?.additions, deletions: st?.deletions });
    }

    return Response.json(result, { headers: corsHeaders });
  } catch {
    return Response.json([], { headers: corsHeaders });
  }
}

export async function handleGitInfo(dirPath: string): Promise<Response> {
  if (!existsSync(dirPath)) {
    return Response.json({ is_git: false, error: 'Path does not exist' }, { headers: corsHeaders });
  }

  const packageManager = detectPackageManager(dirPath);
  const hasEnv = existsSync(`${dirPath}/.env`);

  try {
    await runShell('git rev-parse --is-inside-work-tree', dirPath);
    const branch = (await runShell('git branch --show-current', dirPath)).trim();
    const topLevel = (await runShell('git rev-parse --show-toplevel', dirPath)).trim();
    let worktrees: { path: string; branch: string }[] = [];
    try {
      const wtOut = await runShell('git worktree list --porcelain', dirPath);
      const blocks = wtOut.split('\n\n').filter(Boolean);
      worktrees = blocks.map(block => {
        const lines = block.split('\n');
        const wtPath = lines.find(l => l.startsWith('worktree '))?.slice(9) || '';
        const wtBranch = lines.find(l => l.startsWith('branch '))?.slice(7).replace('refs/heads/', '') || '';
        return { path: wtPath, branch: wtBranch };
      }).filter(w => w.path);
    } catch {}

    // Detect PM from top-level if dirPath didn't have it
    const pm = packageManager || detectPackageManager(topLevel);
    const envExists = hasEnv || existsSync(`${topLevel}/.env`);

    // The ref this branch was cut from (reflog), for the "vs <base>" label.
    // `origin/` is stripped for display; the diff endpoint re-tries both.
    let parentBranch: string | null = null;
    try {
      const origin = await branchOrigin(dirPath);
      parentBranch = origin?.parent?.replace(/^origin\//, '') || null;
      if (parentBranch === branch) parentBranch = null;
    } catch {}

    return Response.json({
      is_git: true, branch, top_level: topLevel, worktrees,
      parent_branch: parentBranch,
      package_manager: pm, has_env: envExists,
    }, { headers: corsHeaders });
  } catch {
    return Response.json({ is_git: false, package_manager: packageManager, has_env: hasEnv }, { headers: corsHeaders });
  }
}

export async function handleGhPrs(cwd: string, sessionName: string): Promise<Response> {
  try {
    const output = await runShell(
      'gh pr list --state all --json number,title,headRefName,state,url,isDraft --limit 20',
      cwd,
      10000,
    );
    let prs = JSON.parse(output) as { number: number; title: string; headRefName: string; state: string; url: string; isDraft: boolean }[];

    // Match PRs to session name if provided
    if (sessionName) {
      const words = sessionName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      if (words.length > 0) {
        const matched = prs.filter(pr => {
          const text = `${pr.title} ${pr.headRefName}`.toLowerCase();
          return words.some(w => text.includes(w));
        });
        prs = matched;
      }
    }

    return Response.json(prs, { headers: corsHeaders });
  } catch {
    return Response.json([], { headers: corsHeaders });
  }
}

export async function handleGitBranches(cwd: string): Promise<Response> {
  try {
    const output = await runShell('git branch -a', cwd);
    const current = (await runShell('git branch --show-current', cwd)).trim();
    const local: string[] = [];
    const remote: string[] = [];
    const localSet = new Set<string>();
    for (const raw of output.split('\n')) {
      const b = raw.replace(/^\*?\s+/, '').trim();
      if (!b || b.includes('HEAD')) continue;
      if (b.startsWith('remotes/origin/')) {
        const name = b.replace(/^remotes\/origin\//, '');
        if (!localSet.has(name)) remote.push(name);
      } else {
        local.push(b);
        localSet.add(b);
      }
    }
    return Response.json({ current, local, remote }, { headers: corsHeaders });
  } catch (e: any) {
    return Response.json({ current: '', local: [], remote: [], error: String(e) }, { headers: corsHeaders });
  }
}

export async function handleGitCheckout(cwd: string, branch: string): Promise<Response> {
  try {
    await runShell(`git checkout ${JSON.stringify(branch)} 2>&1`, cwd, 10000);
    const current = (await runShell('git branch --show-current', cwd)).trim();
    return Response.json({ ok: true, branch: current }, { headers: corsHeaders });
  } catch (e: any) {
    // When the branch is already checked out in another worktree, git prints
    // `fatal: '<branch>' is already used by worktree at '<path>'`. Surface the
    // path so the caller can switch into that worktree instead of failing.
    const msg = String(e?.stdout || e?.message || e);
    const m = msg.match(/already (?:used by|checked out at) worktree at ['"]?([^'"\n]+)['"]?/i)
      || msg.match(/is already checked out at ['"]?([^'"\n]+)['"]?/i);
    if (m) {
      return Response.json(
        { ok: false, error: msg, alreadyInWorktree: { path: m[1]!.trim(), branch } },
        { status: 409, headers: corsHeaders },
      );
    }
    return Response.json({ ok: false, error: msg }, { status: 400, headers: corsHeaders });
  }
}
