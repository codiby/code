/**
 * Session file watcher — watches a session's `cwd` recursively and broadcasts
 * batched file/folder change events to subscribed frontend clients.
 *
 * Uses Bun's native `fs.watch` (recursive) — no external dependency. Raw events
 * are coalesced over a short debounce window so a burst of writes (e.g. a
 * formatter rewriting many files, or a `git checkout`) arrives as a single
 * `file_changes` message instead of hundreds.
 *
 * Lifecycle: started from `startProviderSession` (lifecycle.ts) when a session
 * spawns, stopped when the session is stopped or deleted (handlers/sessions.ts).
 * The watcher follows the *session*, not the provider process — it keeps
 * running across provider restarts (startSessionWatcher is idempotent).
 */

import { watch, statSync, existsSync, type FSWatcher } from 'fs';
import { join, sep } from 'path';
import { log, logError } from './logger';
import { invalidateIndexFor } from './handlers/files';

export type FileChangeKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export type FileChange = {
  kind: FileChangeKind;
  /** Path relative to the session cwd, using POSIX separators. */
  path: string;
  isDir: boolean;
};

type Broadcast = (sessionId: string, msg: object) => void;

type Entry = {
  cwd: string;
  watcher: FSWatcher;
  broadcast: Broadcast;
  /** Coalesced changes keyed by relative path; last kind wins within a window. */
  pending: Map<string, FileChange>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Directories we've seen exist. A delete arrives after the path is already
   *  gone, so we can't `stat` it — this set lets us tell unlinkDir from
   *  unlink. */
  knownDirs: Set<string>;
};

const watchers = new Map<string, Entry>();

/** Debounce window for coalescing a burst of raw fs events into one message. */
const FLUSH_MS = 120;

/** Path segments that produce overwhelming churn and are never worth
 *  surfacing. Any change whose relative path crosses one of these is dropped. */
const IGNORED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  'electron-dist',
  'electron-out',
  '.next',
  '.turbo',
  '.cache',
  'build',
  '.wt',
]);

function isIgnored(relPath: string): boolean {
  if (!relPath) return true;
  for (const seg of relPath.split(/[\\/]/)) {
    if (IGNORED_SEGMENTS.has(seg)) return true;
    if (seg === '.DS_Store') return true;
  }
  return false;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * Start watching `cwd` for a session. Idempotent: a second call for the same
 * session is a no-op when the cwd matches, and restarts the watcher when it
 * differs. No-ops for empty cwds and silently bails if the OS can't watch the
 * path (e.g. it doesn't exist locally, or recursive watching is unsupported on
 * this platform).
 */
export function startSessionWatcher(sessionId: string, cwd: string, broadcast: Broadcast): void {
  const existing = watchers.get(sessionId);
  if (existing) {
    if (existing.cwd === cwd) return;
    stopSessionWatcher(sessionId);
  }
  if (!cwd) return;

  let watcher: FSWatcher;
  try {
    watcher = watch(cwd, { recursive: true });
  } catch (err) {
    logError(`[watch] could not watch ${cwd} for ${sessionId.slice(0, 8)}: ${err}`);
    return;
  }

  const entry: Entry = {
    cwd,
    watcher,
    broadcast,
    pending: new Map(),
    flushTimer: null,
    knownDirs: new Set(),
  };

  watcher.on('change', (eventType, filename) => {
    if (!filename) return;
    const rel = toPosix(typeof filename === 'string' ? filename : filename.toString());
    if (isIgnored(rel)) return;
    record(entry, sessionId, String(eventType), rel);
  });
  watcher.on('error', (err) => {
    logError(`[watch] watcher error for ${sessionId.slice(0, 8)}: ${err}`);
  });

  watchers.set(sessionId, entry);
  log(`[watch] started for ${sessionId.slice(0, 8)} at ${cwd}`);
}

/** Stop and dispose the watcher for a session (no-op if none is running). */
export function stopSessionWatcher(sessionId: string): void {
  const entry = watchers.get(sessionId);
  if (!entry) return;
  watchers.delete(sessionId);
  if (entry.flushTimer) {
    clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
  }
  try {
    entry.watcher.close();
  } catch {}
  log(`[watch] stopped for ${sessionId.slice(0, 8)}`);
}

/** Classify a raw fs event and stage it for the next flush. */
function record(entry: Entry, sessionId: string, eventType: string, rel: string): void {
  const abs = join(entry.cwd, rel);
  let exists = false;
  let isDir = false;
  try {
    isDir = statSync(abs).isDirectory();
    exists = true;
  } catch {
    exists = false;
  }

  let change: FileChange;
  if (exists) {
    if (isDir) {
      // A bare 'change' on a directory (mtime bump from a child write) is
      // noise — the child's own event already carries the real signal.
      if (eventType === 'change') return;
      entry.knownDirs.add(rel);
      change = { kind: 'addDir', path: rel, isDir: true };
    } else {
      // fs.watch reports atomic saves (write-temp + rename) as 'rename', so a
      // 'rename' on an existing file can be a modify rather than a create. We
      // still label it 'add' — the path existing now is the best signal we get
      // without tracking prior state for every file.
      change = { kind: eventType === 'rename' ? 'add' : 'change', path: rel, isDir: false };
    }
  } else if (entry.knownDirs.has(rel)) {
    entry.knownDirs.delete(rel);
    change = { kind: 'unlinkDir', path: rel, isDir: true };
  } else {
    change = { kind: 'unlink', path: rel, isDir: false };
    // macOS FSEvents frequently reports only the child deletions when a
    // directory is removed recursively — no event for the directory itself.
    // Synthesize unlinkDir for any known ancestor that's now gone from disk.
    reconcileDeletedAncestors(entry, rel);
  }

  stage(entry, sessionId, change);
}

/** Walk `rel`'s ancestors; for each one we knew was a directory and that no
 *  longer exists, stage an unlinkDir and forget it. */
function reconcileDeletedAncestors(entry: Entry, rel: string): void {
  let parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  while (parent) {
    if (entry.knownDirs.has(parent) && !existsSync(join(entry.cwd, parent))) {
      entry.knownDirs.delete(parent);
      stage(entry, '', { kind: 'unlinkDir', path: parent, isDir: true });
    }
    parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : '';
  }
}

/** Coalesce a change into the pending batch and arm the flush timer. The
 *  `sessionId` is only needed to schedule the flush; an empty string reuses an
 *  already-armed timer (callers that pass '' are staging alongside a sibling
 *  call that armed it). */
function stage(entry: Entry, sessionId: string, change: FileChange): void {
  entry.pending.set(change.path, change);
  if (!entry.flushTimer && sessionId) {
    entry.flushTimer = setTimeout(() => flush(entry, sessionId), FLUSH_MS);
  }
}

function flush(entry: Entry, sessionId: string): void {
  entry.flushTimer = null;
  if (entry.pending.size === 0) return;
  const changes = Array.from(entry.pending.values());
  entry.pending.clear();
  // Structural changes (anything but a content edit) invalidate the cached
  // workspace file index so the next /file-index fetch — driving the command
  // palette and the composer's @-mention list — rebuilds fresh.
  if (changes.some(c => c.kind !== 'change')) {
    try { invalidateIndexFor(entry.cwd); } catch {}
  }
  try {
    entry.broadcast(sessionId, { type: 'file_changes', sessionId, changes });
  } catch (err) {
    logError(`[watch] broadcast failed for ${sessionId.slice(0, 8)}: ${err}`);
  }
}
