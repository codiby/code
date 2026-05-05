import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { basename, dirname, join, resolve, sep } from 'path';
import { platform } from 'os';
import { corsHeaders } from '../config';

/** True when `s` ends with a path separator for the current OS (either `/` or,
 *  on Windows, `\`). The directory-autocomplete API treats a trailing separator
 *  as "list children" vs "filter siblings by prefix". */
function endsWithSep(s: string): boolean {
  return s.endsWith('/') || s.endsWith(sep);
}

export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.astro', '__pycache__', '.venv', 'vendor', 'coverage', '.cache', '.turbo', 'target', '__snapshots__']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

export type IndexEntry = { name: string; path: string; rel: string; type: 'file' | 'dir' };
export const fileIndexCache = new Map<string, { files: IndexEntry[]; ts: number }>();
export const FILE_INDEX_TTL = 30_000; // 30s cache

export function handleListDirs(prefix: string): Response {
  try {
    // If prefix ends with a separator (`/` or, on Windows, `\`), list contents
    // of that dir. Otherwise list parent filtered by partial name.
    let dir: string;
    let filter: string;
    if (endsWithSep(prefix)) {
      dir = prefix;
      filter = '';
    } else {
      dir = dirname(prefix);
      filter = basename(prefix).toLowerCase();
    }

    if (!existsSync(dir)) {
      return Response.json([], { headers: corsHeaders });
    }

    const entries = readdirSync(dir, { withFileTypes: true });
    const dirs = entries
      .filter(e => {
        if (!e.isDirectory()) return false;
        if (SKIP_DIRS.has(e.name)) return false;
        if (filter && !e.name.toLowerCase().startsWith(filter)) return false;
        return true;
      })
      // Trailing `sep` matches the platform and the check in `endsWithSep` above
      // — so the client can feed the returned string back in as a prefix.
      .map(e => resolve(dir, e.name) + sep)
      .sort();

    return Response.json(dirs, { headers: corsHeaders });
  } catch {
    return Response.json([], { headers: corsHeaders });
  }
}

export function handleListFiles(dirPath: string): Response {
  try {
    if (!existsSync(dirPath)) {
      return Response.json([], { headers: corsHeaders });
    }
    const entries = readdirSync(dirPath, { withFileTypes: true });
    const items = entries
      .filter(e => !(e.isDirectory() ? SKIP_DIRS.has(e.name) : SKIP_FILES.has(e.name)))
      .map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' as const : 'file' as const,
        path: resolve(dirPath, e.name),
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return Response.json(items, { headers: corsHeaders });
  } catch {
    return Response.json([], { headers: corsHeaders });
  }
}

export function buildFileIndex(root: string): IndexEntry[] {
  const files: IndexEntry[] = [];
  const maxDepth = 10;
  const maxFiles = 10_000;

  function walk(dir: string, rel: string, depth: number) {
    if (depth > maxDepth || files.length >= maxFiles) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_FILES.has(e.name)) continue;
      if (files.length >= maxFiles) break;
      const fullPath = resolve(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        files.push({ name: e.name, path: fullPath, rel: relPath, type: 'dir' });
        walk(fullPath, relPath, depth + 1);
      } else {
        files.push({ name: e.name, path: fullPath, rel: relPath, type: 'file' });
      }
    }
  }

  walk(root, '', 0);
  return files;
}

export function handleFileIndex(root: string): Response {
  try {
    const cached = fileIndexCache.get(root);
    if (cached && Date.now() - cached.ts < FILE_INDEX_TTL) {
      return Response.json(cached.files, { headers: corsHeaders });
    }
    const files = buildFileIndex(root);
    fileIndexCache.set(root, { files, ts: Date.now() });
    return Response.json(files, { headers: corsHeaders });
  } catch {
    return Response.json([], { headers: corsHeaders });
  }
}

function invalidateIndexFor(path: string): void {
  for (const root of fileIndexCache.keys()) {
    if (path === root || path.startsWith(root + sep) || path.startsWith(root + '/')) {
      fileIndexCache.delete(root);
    }
  }
}

export function handleDeletePath(path: string): Response {
  try {
    if (!existsSync(path)) {
      return Response.json({ error: 'Path does not exist' }, { status: 404, headers: corsHeaders });
    }
    rmSync(path, { recursive: true, force: true });
    invalidateIndexFor(path);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
  }
}

export function handleRenamePath(from: string, to: string): Response {
  try {
    if (!existsSync(from)) {
      return Response.json({ error: 'Source does not exist' }, { status: 404, headers: corsHeaders });
    }
    if (existsSync(to)) {
      return Response.json({ error: 'Target already exists' }, { status: 409, headers: corsHeaders });
    }
    renameSync(from, to);
    invalidateIndexFor(from);
    invalidateIndexFor(to);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
  }
}

export function handleCreateFile(path: string): Response {
  try {
    if (existsSync(path)) {
      return Response.json({ error: 'Already exists' }, { status: 409, headers: corsHeaders });
    }
    writeFileSync(path, '', 'utf-8');
    invalidateIndexFor(path);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
  }
}

export function handleCreateDir(path: string): Response {
  try {
    if (existsSync(path)) {
      return Response.json({ error: 'Already exists' }, { status: 409, headers: corsHeaders });
    }
    mkdirSync(path, { recursive: false });
    invalidateIndexFor(path);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
  }
}

export function handleRevealInFinder(path: string): Response {
  try {
    if (!existsSync(path)) {
      return Response.json({ error: 'Path does not exist' }, { status: 404, headers: corsHeaders });
    }
    const os = platform();
    if (os === 'darwin') {
      execFileSync('open', ['-R', path], { timeout: 5000 });
    } else if (os === 'win32') {
      execFileSync('explorer', ['/select,', path], { timeout: 5000 });
    } else {
      // Linux / other: open the parent directory
      execFileSync('xdg-open', [dirname(path)], { timeout: 5000 });
    }
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
  }
}

export function detectPackageManager(dir: string): string | null {
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'package-lock.json'))) return 'npm';
  if (existsSync(join(dir, 'package.json'))) return 'npm';
  return null;
}
