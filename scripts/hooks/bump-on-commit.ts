#!/usr/bin/env bun
/**
 * pre-commit: bump the patch version in `package.json` on every commit, so
 * each commit carries its own version and a remote bridge that is behind by
 * even one commit reports an older version than the desktop app.
 *
 * Only the `"version"` line is touched, in the index and in the working tree.
 * Several sessions share this working tree; `git add package.json` would sweep
 * whatever else someone left unstaged in the file into this commit.
 *
 * Skipped when:
 *   - SKIP_VERSION_BUMP=1
 *   - a merge, rebase, cherry-pick or revert is in progress
 *   - `git commit --amend` (the commit being amended already got its bump)
 *   - the staged version already differs from HEAD's (a manual
 *     `bun run version:bump minor` for a release wins)
 *
 * Releases are still cut by tagging (`v*`); a bump never publishes anything.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION_RE = /("version"\s*:\s*")(\d+)\.(\d+)\.(\d+)(")/;

function git(args: string[], input?: string): { ok: boolean; out: string } {
  const r = Bun.spawnSync(['git', ...args], { stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe' });
  return { ok: r.exitCode === 0, out: r.stdout.toString() };
}

function versionOf(json: string): string | null {
  const m = json.match(VERSION_RE);
  return m ? `${m[2]}.${m[3]}.${m[4]}` : null;
}

export function bumpPatch(version: string): string {
  const [maj, min, pat] = version.split('.').map(Number);
  return `${maj}.${min}.${pat! + 1}`;
}

function withVersion(json: string, version: string): string {
  return json.replace(VERSION_RE, `$1${version}$5`);
}

/** `git commit --amend`: the hook's parent is git itself (the shell wrapper `exec`s us). */
function isAmend(): boolean {
  const r = Bun.spawnSync(['ps', '-o', 'args=', '-p', String(process.ppid)], { stdout: 'pipe', stderr: 'ignore' });
  return /\s--amend\b/.test(r.stdout.toString());
}

function main(): void {
  if (process.env.SKIP_VERSION_BUMP === '1') return;

  const gitDir = git(['rev-parse', '--git-dir']).out.trim();
  const busy = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];
  if (busy.some(f => existsSync(join(gitDir, f)))) return;
  if (isAmend()) return;

  const head = git(['show', 'HEAD:package.json']);
  const staged = git(['show', ':package.json']);
  if (!head.ok || !staged.ok) return; // first commit, or no package.json
  const headVersion = versionOf(head.out);
  const stagedVersion = versionOf(staged.out);
  if (!headVersion || stagedVersion !== headVersion) return;

  const next = bumpPatch(headVersion);
  const blob = git(['hash-object', '-w', '--stdin'], withVersion(staged.out, next)).out.trim();
  const mode = git(['ls-files', '-s', 'package.json']).out.split(' ')[0] || '100644';
  if (!git(['update-index', '--cacheinfo', `${mode},${blob},package.json`]).ok) {
    console.error('[version] could not stage the bumped package.json');
    process.exit(1);
  }

  const root = git(['rev-parse', '--show-toplevel']).out.trim();
  const file = join(root, 'package.json');
  writeFileSync(file, withVersion(readFileSync(file, 'utf8'), next));
  console.log(`[version] ${headVersion} → ${next}`);
}

if (import.meta.main) main();
