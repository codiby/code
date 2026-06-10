import { spawn } from 'child_process';
import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { corsHeaders } from '../config';

function refExists(cwd: string, ref: string): boolean {
  try {
    execSync(`git rev-parse --verify --quiet "${ref}"`, { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Minimal worktree creation — the `git worktree add` step only, no deps install
 * or env copy. Exposed so MCP tools (and anything else in-process) can create a
 * worktree without dealing with the SSE streaming protocol of the HTTP handler.
 *
 *  - branch name is sanitized to [a-zA-Z0-9_\-/.]
 *  - worktree is placed at `<dirname(repoPath)>/.wt/<safeBranch>`
 *  - newBranch=true creates the branch (fails if it already exists)
 *  - newBranch=false attaches an existing branch (fails if it doesn't exist)
 *  - sourceBranch / pullSource only apply when newBranch=true
 */
export function createWorktree(opts: {
  repoPath: string;
  branch: string;
  newBranch: boolean;
  sourceBranch?: string;
  pullSource?: boolean;
}): { path: string; branch: string } {
  const repoPath = opts.repoPath;
  const branchName = opts.branch;
  if (!repoPath) throw new Error('repoPath is required');
  if (!branchName) throw new Error('branch is required');
  if (typeof opts.newBranch !== 'boolean') throw new Error('newBranch (boolean) is required');
  const safeBranch = branchName.replace(/[^a-zA-Z0-9_\-/.]/g, '-');
  const sourceBranch = opts.sourceBranch?.trim()
    ? opts.sourceBranch.trim().replace(/[^a-zA-Z0-9_\-/.]/g, '-')
    : '';
  const wtDir = join(dirname(repoPath), '.wt');
  if (!existsSync(wtDir)) mkdirSync(wtDir, { recursive: true });
  const wtPath = join(wtDir, safeBranch);

  if (opts.newBranch) {
    // Optional: fetch origin/<sourceBranch> first so the new branch is based on
    // the latest remote head. On fetch failure, fall back to the local branch.
    let startPoint = sourceBranch;
    if (sourceBranch && opts.pullSource) {
      try {
        execSync(`git fetch origin "${sourceBranch}" 2>&1`, { cwd: repoPath });
        startPoint = `origin/${sourceBranch}`;
      } catch {
        // fall through with local sourceBranch as start-point
      }
    }

    const addCmd = startPoint
      ? `git worktree add "${wtPath}" -b "${safeBranch}" "${startPoint}" 2>&1`
      : `git worktree add "${wtPath}" -b "${safeBranch}" 2>&1`;
    try {
      execSync(addCmd, { cwd: repoPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Surface a clearer error when the branch already exists instead of
      // silently attaching it — that would hide the agent's intent.
      if (/already exists|already used/i.test(msg)) {
        throw new Error(`Branch "${safeBranch}" already exists. Use new_branch: false to attach it, or pick a different branch name.`);
      }
      throw err;
    }
  } else {
    // Attach an existing branch. If it doesn't exist locally but does exist
    // as a remote-tracking ref (e.g. user picked `feature` from the list and
    // it's only present as `origin/feature`), create a local tracking branch
    // explicitly — DWIM is unreliable across git versions / remotes.
    const hasLocal = refExists(repoPath, `refs/heads/${safeBranch}`);
    if (hasLocal) {
      execSync(`git worktree add "${wtPath}" "${safeBranch}" 2>&1`, { cwd: repoPath });
    } else if (refExists(repoPath, `refs/remotes/origin/${safeBranch}`)) {
      execSync(`git worktree add --track -b "${safeBranch}" "${wtPath}" "origin/${safeBranch}" 2>&1`, { cwd: repoPath });
    } else {
      execSync(`git worktree add "${wtPath}" "${safeBranch}" 2>&1`, { cwd: repoPath });
    }
  }

  const resolvedPath = execSync(`cd "${wtPath}" && pwd`, { stdio: 'pipe' }).toString().trim();
  return { path: resolvedPath, branch: safeBranch };
}

/**
 * Remove a git worktree by path. Refuses to remove the main worktree (the
 * repo root itself) — git won't, and neither should we. Uses `--force` so a
 * worktree with uncommitted changes or an open session still detaches; the
 * caller (UI) gates this behind an explicit confirm.
 */
export function removeWorktree(opts: { repoPath: string; worktreePath: string }): { removed: boolean } {
  const { repoPath, worktreePath } = opts;
  if (!repoPath) throw new Error('repoPath is required');
  if (!worktreePath) throw new Error('worktreePath is required');
  const mainTop = execSync('git rev-parse --show-toplevel', { cwd: repoPath, stdio: 'pipe' }).toString().trim();
  const resolved = existsSync(worktreePath)
    ? execSync(`cd "${worktreePath}" && pwd`, { stdio: 'pipe' }).toString().trim()
    : worktreePath;
  if (resolved === mainTop) throw new Error('Refusing to remove the main worktree.');
  execSync(`git worktree remove --force "${resolved}"`, { cwd: repoPath, stdio: 'pipe', timeout: 15_000 });
  return { removed: true };
}

/** Plain JSON endpoint for `removeWorktree` — POST /worktree/remove. */
export async function handleRemoveWorktree(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: corsHeaders });
  }
  const repoPath = body.repo_path as string;
  const worktreePath = body.worktree_path as string;
  if (!repoPath || !worktreePath) {
    return Response.json({ error: 'repo_path and worktree_path required' }, { status: 400, headers: corsHeaders });
  }
  try {
    const result = removeWorktree({ repoPath, worktreePath });
    return Response.json({ ok: true, ...result }, { headers: corsHeaders });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500, headers: corsHeaders });
  }
}

/**
 * Worktree creation with SSE streaming of setup logs.
 * Returns text/event-stream with log lines, and a final `done` or `error` event.
 */
export async function handleCreateWorktree(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: corsHeaders });
  }

  const repoPath = body.repo_path as string;
  const branchName = body.branch as string;
  const doCopyEnv = body.copy_env === true;
  const doInstallDeps = body.install_deps === true;
  const doCopyNodeModules = body.copy_node_modules === true;
  const doLinkNodeModules = body.link_node_modules === true;
  const pm = (body.package_manager as string) || 'npm';
  // new_branch=true  → create a fresh branch (optionally based on
  //                   `source_branch` / fetched from origin first).
  // new_branch=false → attach an existing branch into the worktree.
  // Defaults to true for backwards compat with old clients.
  const newBranch = body.new_branch !== false;
  const sourceBranchRaw = (body.source_branch as string | undefined)?.trim();
  const doPullSource = body.pull_source === true;

  if (!repoPath || !branchName) {
    return Response.json({ error: 'repo_path and branch required' }, { status: 400, headers: corsHeaders });
  }

  const safeBranch = branchName.replace(/[^a-zA-Z0-9_\-/.]/g, '-');
  const sourceBranch = sourceBranchRaw && sourceBranchRaw.replace(/[^a-zA-Z0-9_\-/.]/g, '-') || '';
  const wtDir = join(dirname(repoPath), '.wt');
  if (!existsSync(wtDir)) mkdirSync(wtDir, { recursive: true });
  const wtPath = join(wtDir, safeBranch);

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: string) => {
        if (closed) return;
        try { controller.enqueue(`event: ${event}\ndata: ${data}\n\n`); } catch {}
      };
      const log = (msg: string) => send('log', msg);
      const finish = () => { if (!closed) { closed = true; controller.close(); } };

      try {
        // 1. New branch path: optionally fetch origin for `source_branch` so
        //    the new branch is based on the latest remote head (no merge,
        //    just fetch — falls back to the local branch on failure). Skipped
        //    entirely when attaching an existing branch.
        let startPoint = sourceBranch; // may be '' (meaning: branch from HEAD)
        if (newBranch && sourceBranch && doPullSource) {
          log(`$ git fetch origin "${sourceBranch}"`);
          try {
            const out = execSync(`git fetch origin "${sourceBranch}" 2>&1`, { cwd: repoPath }).toString();
            if (out.trim()) log(out.trim());
            startPoint = `origin/${sourceBranch}`;
            log(`Using origin/${sourceBranch} as start-point.`);
          } catch (e) {
            log(`Fetch failed (${String(e).slice(0, 120)}). Falling back to local ${sourceBranch}.`);
          }
        }

        // 2. Create the worktree.
        //    - new_branch=true  → `git worktree add -b <branch> <path> [start]`
        //    - new_branch=false → `git worktree add <path> <branch>`
        //    When new_branch=true and the branch already exists, surface the
        //    error to the user instead of silently attaching — the agent or
        //    operator explicitly asked for a fresh branch.
        if (newBranch) {
          const addCmd = startPoint
            ? `git worktree add "${wtPath}" -b "${safeBranch}" "${startPoint}"`
            : `git worktree add "${wtPath}" -b "${safeBranch}"`;
          log(`$ ${addCmd}`);
          const out = execSync(`${addCmd} 2>&1`, { cwd: repoPath }).toString();
          if (out.trim()) log(out.trim());
        } else {
          // If the branch doesn't exist locally but does exist as a remote-
          // tracking ref, explicitly create a tracking branch — DWIM is
          // unreliable, and the "Existing branch" picker mixes local + remote
          // names with no distinction.
          const hasLocal = refExists(repoPath, `refs/heads/${safeBranch}`);
          const hasRemote = !hasLocal && refExists(repoPath, `refs/remotes/origin/${safeBranch}`);
          const addCmd = hasRemote
            ? `git worktree add --track -b "${safeBranch}" "${wtPath}" "origin/${safeBranch}"`
            : `git worktree add "${wtPath}" "${safeBranch}"`;
          log(`$ ${addCmd}`);
          const out = execSync(`${addCmd} 2>&1`, { cwd: repoPath }).toString();
          if (out.trim()) log(out.trim());
        }
        const resolvedPath = execSync(`cd "${wtPath}" && pwd`, { stdio: 'pipe' }).toString().trim();
        log(`Worktree created at ${resolvedPath}`);

        // 3. Copy .env
        if (doCopyEnv) {
          const envSrc = `${repoPath}/.env`;
          const envDst = `${resolvedPath}/.env`;
          if (existsSync(envSrc) && !existsSync(envDst)) {
            const { copyFileSync } = await import('fs');
            copyFileSync(envSrc, envDst);
            log('Copied .env');
          } else if (!existsSync(envSrc)) {
            log('.env not found in source, skipping');
          }
        }

        // 4. Install dependencies (streamed)
        if (doInstallDeps) {
          if (!existsSync(`${resolvedPath}/package.json`)) {
            log('No package.json found, skipping install');
          } else {
          const installCmd: Record<string, string> = {
            bun: 'bun install', yarn: 'yarn install',
            pnpm: 'pnpm install', npm: 'npm install',
          };
          const cmd = installCmd[pm] || 'npm install';
          log(`$ ${cmd}`);

          await new Promise<void>((resolve) => {
            const parts = cmd.split(' ');
            const proc = spawn(parts[0]!, parts.slice(1), {
              cwd: resolvedPath,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, TERM: 'dumb', FORCE_COLOR: '0' },
            });

            proc.stdout?.on('data', (d: Buffer) => {
              for (const line of d.toString().split('\n').filter(Boolean)) log(line);
            });
            proc.stderr?.on('data', (d: Buffer) => {
              for (const line of d.toString().split('\n').filter(Boolean)) log(line);
            });
            proc.on('close', (code) => {
              log(code === 0 ? 'Dependencies installed' : `Install exited with code ${code}`);
              resolve();
            });
            proc.on('error', (err) => {
              log(`Error: ${err.message}`);
              resolve();
            });
          });
          } // end else (has package.json)
        }

        // 5. Copy node_modules from source repo
        if (doCopyNodeModules) {
          const nmSrc = `${repoPath}/node_modules`;
          const nmDst = `${resolvedPath}/node_modules`;
          if (!existsSync(nmSrc)) {
            log('node_modules not found in source, skipping copy');
          } else if (existsSync(nmDst)) {
            log('node_modules already exists in worktree, skipping copy');
          } else {
            log(`$ tar c node_modules | tar x -C ${resolvedPath}`);
            await new Promise<void>((resolve) => {
              const proc = spawn('sh', ['-c', `cd "${repoPath}" && tar cf - node_modules | tar xf - -C "${resolvedPath}"`], { stdio: ['ignore', 'pipe', 'pipe'] });
              proc.stdout?.on('data', (d: Buffer) => {
                for (const line of d.toString().split('\n').filter(Boolean)) log(line);
              });
              proc.stderr?.on('data', (d: Buffer) => {
                for (const line of d.toString().split('\n').filter(Boolean)) log(line);
              });
              proc.on('close', (code) => {
                log(code === 0 ? 'node_modules linked' : `cp exited with code ${code}`);
                resolve();
              });
              proc.on('error', (err) => {
                log(`Error: ${err.message}`);
                resolve();
              });
            });
          }
        }

        // 6. Symlink node_modules from source repo
        if (doLinkNodeModules) {
          const nmSrc = `${repoPath}/node_modules`;
          const nmDst = `${resolvedPath}/node_modules`;
          if (!existsSync(nmSrc)) {
            log('node_modules not found in source, skipping link');
          } else if (existsSync(nmDst)) {
            log('node_modules already exists in worktree, skipping link');
          } else {
            log(`$ ln -s ${nmSrc} → ${nmDst}`);
            const { symlinkSync } = await import('fs');
            symlinkSync(nmSrc, nmDst);
            log('node_modules symlinked');
          }
        }

        send('done', JSON.stringify({ path: resolvedPath, branch: safeBranch }));
      } catch (e) {
        send('error', String(e));
      }

      finish();
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
