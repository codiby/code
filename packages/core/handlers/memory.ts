/**
 * Agent memory — what each coding agent remembers across sessions on this host.
 *
 * Two kinds of memory, both plain markdown on disk:
 *
 *   user     global instruction files every session of that agent loads
 *              claude    ~/.claude/CLAUDE.md
 *              codex     $CODEX_HOME/AGENTS.md (default ~/.codex)
 *              opencode  ~/.config/opencode/AGENTS.md
 *
 *   project  Claude Code's auto-memory: one file per fact under
 *            ~/.claude/projects/<slug>/memory/, indexed by MEMORY.md, where
 *            <slug> is the project's cwd with every non-alphanumeric char
 *            replaced by '-'.
 *
 * The slug isn't reversible, so a project's real path comes from the `cwd`
 * recorded in its newest transcript. Projects also carry a `key` derived from
 * the git remote, so the same repo checked out at different paths on two hosts
 * pairs up for syncing.
 *
 * Every host serves this API for its own disk; the UI reaches remotes through
 * their tunnel and does the cross-host diffing and copying itself.
 */

import { createHash } from 'crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, hostname } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { corsHeaders } from '../config/config';
import { loadPreferences, savePreferences } from '../session/storage';

export type MemoryProvider = 'claude' | 'codex' | 'opencode';
export const MEMORY_PROVIDERS: MemoryProvider[] = ['claude', 'codex', 'opencode'];
export const MEMORY_INDEX = 'MEMORY.md';

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const SLUG_RE = /^[A-Za-z0-9-]+$/;

/** Preference that injects the other agents' memory into every new session. */
export const SHARE_MEMORY_PREF = 'shareMemoryAcrossProviders';

export function shareMemoryEnabled(): boolean {
  return loadPreferences()[SHARE_MEMORY_PREF] !== false;
}

export function userMemoryPath(provider: MemoryProvider, home = homedir()): string {
  switch (provider) {
    case 'claude': return join(home, '.claude', 'CLAUDE.md');
    case 'codex': return join(process.env.CODEX_HOME || join(home, '.codex'), 'AGENTS.md');
    case 'opencode': return join(home, '.config', 'opencode', 'AGENTS.md');
  }
}

export function projectsRoot(home = homedir()): string {
  return join(home, '.claude', 'projects');
}

/** Claude Code's project directory name for a cwd. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function projectMemoryDir(cwd: string, home = homedir()): string {
  return join(projectsRoot(home), projectSlug(cwd), 'memory');
}

// ── frontmatter ──────────────────────────────────────────────────────────────

export interface MemoryFrontmatter { name?: string; description?: string; type?: string }

/** Pull name/description/type out of a memory file's frontmatter. `type` may
 *  sit at the top level or nested under `metadata:`. */
export function parseMemoryFrontmatter(raw: string): MemoryFrontmatter {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: MemoryFrontmatter = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv || !kv[2]) continue;
    const val = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    const key = kv[1].toLowerCase();
    if (key === 'name' || key === 'description' || key === 'type') out[key] = val;
  }
  return out;
}

// ── discovery ────────────────────────────────────────────────────────────────

function hashOf(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 12);
}

function readHead(file: string, bytes = 256 * 1024): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

/** The cwd a project dir was created for, from its newest transcript. */
function projectCwd(projectDir: string): string | null {
  let transcripts: { file: string; mtime: number }[];
  try {
    transcripts = readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ file: join(projectDir, f), mtime: statSync(join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return null;
  }
  for (const t of transcripts.slice(0, 3)) {
    try {
      const m = readHead(t.file).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) return JSON.parse(`"${m[1]}"`);
    } catch {}
  }
  return null;
}

/** Fallback for projects whose transcripts were cleaned up: walk the disk from
 *  `/`, descending into any entry whose slug is a prefix of what's left. Only
 *  finds paths that still exist, which are the only ones worth syncing to. */
export function resolveSlugPath(slug: string, dir = '/', depth = 0): string | null {
  if (depth > 12 || !slug.startsWith('-')) return null;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return null; }
  for (const e of entries) {
    const part = `-${projectSlug(e)}`;
    if (slug === part) return join(dir, e);
    if (!slug.startsWith(`${part}-`)) continue;
    try { if (!statSync(join(dir, e)).isDirectory()) continue; } catch { continue; }
    const found = resolveSlugPath(slug.slice(part.length), join(dir, e), depth + 1);
    if (found) return found;
  }
  return null;
}

/** "github.com/owner/repo" from any git remote URL form. */
export function normalizeRemoteUrl(url: string): string {
  return url.trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/:(?!\d)/, '/')
    .replace(/\.git\/?$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** Read the origin URL straight from git's config — cheaper than spawning git
 *  once per project. Worktrees keep `.git` as a file pointing at their gitdir,
 *  whose `commondir` leads back to the shared config. */
function gitOrigin(cwd: string): { url: string; worktree: boolean } | null {
  const dotGit = join(cwd, '.git');
  let configDir = dotGit;
  let worktree = false;
  try {
    if (statSync(dotGit).isFile()) {
      worktree = true;
      const gitdir = readFileSync(dotGit, 'utf-8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
      if (!gitdir) return null;
      const abs = resolve(cwd, gitdir);
      const common = join(abs, 'commondir');
      configDir = existsSync(common) ? resolve(abs, readFileSync(common, 'utf-8').trim()) : abs;
    }
    const config = readFileSync(join(configDir, 'config'), 'utf-8');
    const origin = config.match(/\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/)?.[1];
    const url = origin?.match(/^\s*url\s*=\s*(.+)$/m)?.[1];
    return url ? { url: normalizeRemoteUrl(url), worktree } : null;
  } catch {
    return null;
  }
}

/** Identity used to pair a project across hosts. The git remote when there is
 *  one (paths differ between machines); a worktree adds its folder name so it
 *  doesn't collide with the main checkout. Otherwise the folder name. */
export function projectKey(cwd: string | null, slug: string): string {
  if (!cwd) return slug;
  const origin = gitOrigin(cwd);
  if (!origin) return basename(cwd);
  return origin.worktree ? `${origin.url}@${basename(cwd)}` : origin.url;
}

export interface MemoryFileInfo {
  name: string;
  path: string;
  hash: string;
  size: number;
  mtime: number;
  type: string | null;
  description: string | null;
}

export interface UserMemoryInfo {
  provider: MemoryProvider;
  path: string;
  exists: boolean;
  hash: string | null;
  size: number;
  mtime: number | null;
}

export interface ProjectMemoryInfo {
  slug: string;
  key: string;
  name: string;
  path: string | null;
  dir: string;
  files: MemoryFileInfo[];
}

function fileInfo(path: string): MemoryFileInfo | null {
  try {
    const st = statSync(path);
    const content = readFileSync(path, 'utf-8');
    const fm = parseMemoryFrontmatter(content);
    return {
      name: basename(path),
      path,
      hash: hashOf(content),
      size: st.size,
      mtime: st.mtimeMs,
      type: fm.type ?? null,
      description: fm.description ?? null,
    };
  } catch {
    return null;
  }
}

export function listUserMemory(home = homedir()): UserMemoryInfo[] {
  return MEMORY_PROVIDERS.map(provider => {
    const path = userMemoryPath(provider, home);
    try {
      const content = readFileSync(path, 'utf-8');
      const st = statSync(path);
      return { provider, path, exists: true, hash: hashOf(content), size: st.size, mtime: st.mtimeMs };
    } catch {
      return { provider, path, exists: false, hash: null, size: 0, mtime: null };
    }
  });
}

export function listProjectMemory(home = homedir()): ProjectMemoryInfo[] {
  const root = projectsRoot(home);
  let slugs: string[];
  try { slugs = readdirSync(root); } catch { return []; }
  const out: ProjectMemoryInfo[] = [];
  for (const slug of slugs) {
    const dir = join(root, slug, 'memory');
    let names: string[];
    try { names = readdirSync(dir).filter(n => FILE_RE.test(n)); } catch { continue; }
    if (names.length === 0) continue;
    const files = names.map(n => fileInfo(join(dir, n))).filter((f): f is MemoryFileInfo => !!f);
    // The index first, then by name — the order the modal lists them in.
    files.sort((a, b) => (a.name === MEMORY_INDEX ? -1 : b.name === MEMORY_INDEX ? 1 : a.name.localeCompare(b.name)));
    const path = projectCwd(join(root, slug)) ?? resolveSlugPath(slug);
    // A folder that no longer exists keeps its slug, minus the home prefix.
    const homeSlug = `${projectSlug(home)}-`;
    const name = path ? basename(path) : slug.startsWith(homeSlug) ? slug.slice(homeSlug.length) : slug;
    out.push({ slug, key: projectKey(path, slug), name, path, dir, files });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ── addressing ───────────────────────────────────────────────────────────────

export type MemoryTarget =
  | { scope: 'user'; provider: MemoryProvider }
  | { scope: 'project'; slug: string; name: string };

export function parseMemoryTarget(q: URLSearchParams): MemoryTarget | string {
  const scope = q.get('scope');
  if (scope === 'user') {
    const provider = q.get('provider') as MemoryProvider;
    if (!MEMORY_PROVIDERS.includes(provider)) return 'provider must be claude, codex or opencode';
    return { scope, provider };
  }
  if (scope === 'project') {
    const slug = q.get('slug') ?? '';
    const name = q.get('name') ?? '';
    if (!SLUG_RE.test(slug)) return 'invalid slug';
    if (!FILE_RE.test(name)) return 'invalid file name';
    return { scope, slug, name };
  }
  return "scope must be 'user' or 'project'";
}

export function targetPath(t: MemoryTarget, home = homedir()): string {
  return t.scope === 'user'
    ? userMemoryPath(t.provider, home)
    : join(projectsRoot(home), t.slug, 'memory', t.name);
}

/** Make sure MEMORY.md points at `name`, appending a line if it doesn't. */
function ensureIndexed(dir: string, name: string, content: string) {
  if (name === MEMORY_INDEX) return;
  const index = join(dir, MEMORY_INDEX);
  const current = existsSync(index) ? readFileSync(index, 'utf-8') : '';
  if (current.includes(`(${name})`)) return;
  const fm = parseMemoryFrontmatter(content);
  const title = fm.name || name.replace(/\.md$/, '');
  const line = `- [${title}](${name})${fm.description ? ` — ${fm.description}` : ''}`;
  const sep = current && !current.endsWith('\n') ? '\n' : '';
  writeFileSync(index, `${current}${sep}${line}\n`, 'utf-8');
}

function dropFromIndex(dir: string, name: string) {
  const index = join(dir, MEMORY_INDEX);
  if (!existsSync(index)) return;
  const lines = readFileSync(index, 'utf-8').split('\n');
  const kept = lines.filter(l => !l.includes(`(${name})`));
  if (kept.length !== lines.length) writeFileSync(index, kept.join('\n'), 'utf-8');
}

export function writeMemory(t: MemoryTarget, content: string, home = homedir()): string {
  const path = targetPath(t, home);
  if (t.scope === 'project' && !existsSync(join(projectsRoot(home), t.slug))) {
    throw new Error('project not found on this host');
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  if (t.scope === 'project') ensureIndexed(dirname(path), t.name, content);
  return path;
}

export function deleteMemory(t: MemoryTarget, home = homedir()): boolean {
  const path = targetPath(t, home);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  if (t.scope === 'project') dropFromIndex(dirname(path), t.name);
  return true;
}

// ── handlers ─────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders });
}
function err(message: string, status: number): Response {
  return json({ error: message }, status);
}

/** GET /memory */
export function handleListMemory(): Response {
  return json({
    hostname: hostname(),
    shareAcrossProviders: shareMemoryEnabled(),
    user: listUserMemory(),
    projects: listProjectMemory(),
  });
}

/** GET /memory/file?scope=user&provider=… | scope=project&slug=…&name=… */
export function handleReadMemory(q: URLSearchParams): Response {
  const t = parseMemoryTarget(q);
  if (typeof t === 'string') return err(t, 400);
  const path = targetPath(t);
  if (!existsSync(path)) return err('memory not found', 404);
  try {
    const content = readFileSync(path, 'utf-8');
    return json({ path, content, hash: hashOf(content) });
  } catch (e: any) {
    return err(e.message, 500);
  }
}

/** PUT /memory/file?… body { content } */
export function handleWriteMemory(q: URLSearchParams, body: { content?: unknown }): Response {
  const t = parseMemoryTarget(q);
  if (typeof t === 'string') return err(t, 400);
  if (typeof body.content !== 'string') return err('content must be a string', 400);
  try {
    const path = writeMemory(t, body.content);
    return json({ path, hash: hashOf(body.content) });
  } catch (e: any) {
    return err(e.message, e.message === 'project not found on this host' ? 404 : 500);
  }
}

/** DELETE /memory/file?… */
export function handleDeleteMemory(q: URLSearchParams): Response {
  const t = parseMemoryTarget(q);
  if (typeof t === 'string') return err(t, 400);
  try {
    return deleteMemory(t) ? json({ ok: true }) : err('memory not found', 404);
  } catch (e: any) {
    return err(e.message, 500);
  }
}

/** PUT /memory/settings body { shareAcrossProviders } */
export function handleMemorySettings(body: { shareAcrossProviders?: unknown }): Response {
  if (typeof body.shareAcrossProviders !== 'boolean') return err('shareAcrossProviders must be a boolean', 400);
  savePreferences({ ...loadPreferences(), [SHARE_MEMORY_PREF]: body.shareAcrossProviders });
  return json({ shareAcrossProviders: body.shareAcrossProviders });
}
