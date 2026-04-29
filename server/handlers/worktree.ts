import { spawn } from 'child_process';
import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { basename, dirname, join } from 'path';
import { corsHeaders } from '../config';

/**
 * Minimal worktree creation — the `git worktree add` step only, no deps install
 * or env copy. Exposed so MCP tools (and anything else in-process) can create a
 * worktree without dealing with the SSE streaming protocol of the HTTP handler.
 *
 * Behaviour matches handleCreateWorktree's core:
 *  - branch name is sanitized to [a-zA-Z0-9_\-/.]
 *  - worktree is placed at `<dirname(repoPath)>/.wt/<safeBranch>`
 *  - if the branch already exists, the worktree is created from it (no -b)
 */
export function createWorktree(opts: { repoPath: string; branch: string }): { path: string; branch: string } {
  const repoPath = opts.repoPath;
  const branchName = opts.branch;
  if (!repoPath) throw new Error('repoPath is required');
  if (!branchName) throw new Error('branch is required');
  const safeBranch = branchName.replace(/[^a-zA-Z0-9_\-/.]/g, '-');
  const wtDir = join(dirname(repoPath), '.wt');
  if (!existsSync(wtDir)) mkdirSync(wtDir, { recursive: true });
  const wtPath = join(wtDir, safeBranch);

  try {
    execSync(`git worktree add "${wtPath}" -b "${safeBranch}" 2>&1`, { cwd: repoPath });
  } catch {
    // Branch likely already exists — fall back to attaching without -b.
    execSync(`git worktree add "${wtPath}" "${safeBranch}" 2>&1`, { cwd: repoPath });
  }
  const resolvedPath = execSync(`cd "${wtPath}" && pwd`, { stdio: 'pipe' }).toString().trim();
  return { path: resolvedPath, branch: safeBranch };
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
  // Optional: base the new branch on `source_branch` instead of the current
  // HEAD. When `pull_source` is also true, we first fetch origin for that
  // branch and use `origin/<source>` as the start-point — so the worktree
  // picks up the latest remote commits without touching the user's local
  // checkout.
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
        // 1. Optional: fetch origin for the requested source branch so the
        //    worktree can be based on the latest remote head without touching
        //    the user's local checkout of that branch. We only fetch — no
        //    merge/pull — and on failure we fall back to the local branch.
        let startPoint = sourceBranch; // may be '' (meaning: branch from HEAD)
        if (sourceBranch && doPullSource) {
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

        // 2. Create the worktree. If the target branch already exists we fall
        //    back to attaching it (no -b, ignore the source) — matching the
        //    previous behavior.
        const addCmd = startPoint
          ? `git worktree add "${wtPath}" -b "${safeBranch}" "${startPoint}"`
          : `git worktree add "${wtPath}" -b "${safeBranch}"`;
        log(`$ ${addCmd}`);
        try {
          const out = execSync(`${addCmd} 2>&1`, { cwd: repoPath }).toString();
          if (out.trim()) log(out.trim());
        } catch {
          log(`Branch exists, using existing: ${safeBranch}`);
          const out = execSync(`git worktree add "${wtPath}" "${safeBranch}" 2>&1`, { cwd: repoPath }).toString();
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
