import { existsSync, readdirSync } from 'fs';
import { basename, dirname, join, resolve, sep } from 'path';
import { corsHeaders } from '../config';

/** True when `s` ends with a path separator for the current OS (either `/` or,
 *  on Windows, `\`). The directory-autocomplete API treats a trailing separator
 *  as "list children" vs "filter siblings by prefix". */
function endsWithSep(s: string): boolean {
  return s.endsWith('/') || s.endsWith(sep);
}

export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.astro', '__pycache__', '.venv', 'vendor', 'coverage', '.cache', '.turbo', 'target', '__snapshots__']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

export const fileIndexCache = new Map<string, { files: { name: string; path: string; rel: string }[]; ts: number }>();
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

export function buildFileIndex(root: string): { name: string; path: string; rel: string }[] {
  const files: { name: string; path: string; rel: string }[] = [];
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
        if (!SKIP_DIRS.has(e.name)) walk(fullPath, relPath, depth + 1);
      } else {
        files.push({ name: e.name, path: fullPath, rel: relPath });
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

export function detectPackageManager(dir: string): string | null {
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'package-lock.json'))) return 'npm';
  if (existsSync(join(dir, 'package.json'))) return 'npm';
  return null;
}
