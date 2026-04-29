import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { corsHeaders } from '../config';
import { detectPackageManager } from './files';

export function handleGitModified(root: string): Response {
  try {
    const gitTop = execSync('git rev-parse --show-toplevel', { cwd: root, encoding: 'utf-8', timeout: 5000 }).trim();
    const unstaged = execSync('git diff --name-only', { cwd: root, encoding: 'utf-8', timeout: 5000 }).split('\n').filter(Boolean);
    const staged = execSync('git diff --name-only --cached', { cwd: root, encoding: 'utf-8', timeout: 5000 }).split('\n').filter(Boolean);
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: root, encoding: 'utf-8', timeout: 5000 }).split('\n').filter(Boolean);

    const result: { path: string; staged: boolean; untracked?: boolean }[] = [];
    const stagedSet = new Set<string>();
    const untrackedSet = new Set(untracked.map(f => resolve(gitTop, f)));

    for (const f of staged) {
      const p = resolve(gitTop, f);
      if (!p.startsWith(root)) continue;
      stagedSet.add(p);
      result.push({ path: p, staged: true });
    }
    // Files with unstaged changes (including those also staged — shown in both sections)
    const unstagedSeen = new Set<string>();
    for (const f of [...unstaged, ...untracked]) {
      const p = resolve(gitTop, f);
      if (!p.startsWith(root) || unstagedSeen.has(p)) continue;
      unstagedSeen.add(p);
      result.push({ path: p, staged: false, untracked: untrackedSet.has(p) || undefined });
    }

    return Response.json(result, { headers: corsHeaders });
  } catch {
    return Response.json([], { headers: corsHeaders });
  }
}

export function handleGitInfo(dirPath: string): Response {
  if (!existsSync(dirPath)) {
    return Response.json({ is_git: false, error: 'Path does not exist' }, { headers: corsHeaders });
  }

  const packageManager = detectPackageManager(dirPath);
  const hasEnv = existsSync(`${dirPath}/.env`);

  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dirPath, stdio: 'pipe' });
    const branch = execSync('git branch --show-current', { cwd: dirPath, stdio: 'pipe' }).toString().trim();
    const topLevel = execSync('git rev-parse --show-toplevel', { cwd: dirPath, stdio: 'pipe' }).toString().trim();
    let worktrees: { path: string; branch: string }[] = [];
    try {
      const wtOut = execSync('git worktree list --porcelain', { cwd: dirPath, stdio: 'pipe' }).toString();
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

    return Response.json({
      is_git: true, branch, top_level: topLevel, worktrees,
      package_manager: pm, has_env: envExists,
    }, { headers: corsHeaders });
  } catch {
    return Response.json({ is_git: false, package_manager: packageManager, has_env: hasEnv }, { headers: corsHeaders });
  }
}

export function handleGhPrs(cwd: string, sessionName: string): Response {
  try {
    const output = execSync(
      'gh pr list --state all --json number,title,headRefName,state,url,isDraft --limit 20',
      { cwd, encoding: 'utf-8', timeout: 10000 },
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

export function handleGitBranches(cwd: string): Response {
  try {
    const output = execSync('git branch -a', { cwd, encoding: 'utf-8', timeout: 5000 });
    const current = execSync('git branch --show-current', { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
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

export function handleGitCheckout(cwd: string, branch: string): Response {
  try {
    execSync(`git checkout ${JSON.stringify(branch)}`, { cwd, encoding: 'utf-8', timeout: 10000 });
    const current = execSync('git branch --show-current', { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
    return Response.json({ ok: true, branch: current }, { headers: corsHeaders });
  } catch (e: any) {
    return Response.json({ ok: false, error: e.message }, { status: 400, headers: corsHeaders });
  }
}
