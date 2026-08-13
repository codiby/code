/**
 * Session file watcher — watches a session's `cwd` recursively and broadcasts
 * batched file/folder change events to subscribed frontend clients.
 *
 * Uses Bun's native `fs.watch` — no external dependency. Raw events are
 * coalesced over a short debounce window so a burst of writes (e.g. a formatter
 * rewriting many files, or a `git checkout`) arrives as a single
 * `file_changes` message instead of hundreds.
 *
 * The tree is covered by one non-recursive watch on the cwd plus a recursive
 * watch per interesting top-level directory, rather than one recursive watch
 * over everything — see `startSessionWatcher` for why that distinction matters.
 *
 * Lifecycle: started from `startProviderSession` (lifecycle.ts) when a session
 * spawns, stopped when the session is stopped or deleted (handlers/sessions.ts).
 * The watcher follows the *session*, not the provider process — it keeps
 * running across provider restarts (startSessionWatcher is idempotent).
 */

import { watch, statSync, existsSync, readdirSync, type FSWatcher } from 'fs';
import { join, sep } from 'path';
import { log, logError } from '../lib/logger';
import { invalidateIndexFor } from '../handlers/files';
import { runShell } from '../handlers/git';

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
  /** One watcher on `cwd` itself plus one recursive watcher per watched
   *  top-level directory. See `startSessionWatcher` for why it isn't a single
   *  recursive watch on the whole tree. */
  watchers: FSWatcher[];
  /** Top-level directory names that already have a recursive watcher, so a
   *  rename event doesn't attach a second one. */
  watchedTopLevel: Set<string>;
  broadcast: Broadcast;
  /** Coalesced changes keyed by relative path; last kind wins within a window. */
  pending: Map<string, FileChange>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Directories we've seen exist. A delete arrives after the path is already
   *  gone, so we can't `stat` it — this set lets us tell unlinkDir from
   *  unlink. */
  knownDirs: Set<string>;
  /** Watches the repo's git dir so branch switches (checkout, worktree HEAD
   *  moves) are surfaced even though `.git` is ignored by the file watcher
   *  above. Null until resolved, or when the cwd isn't a git repo. */
  headWatcher: FSWatcher | null;
  /** Last branch we broadcast, used to suppress duplicate HEAD writes. */
  branch: string | null;
  /** Debounce timer for coalescing a burst of HEAD writes into one read. */
  headTimer: ReturnType<typeof setTimeout> | null;
};

const watchers = new Map<string, Entry>();

/** Debounce window for coalescing a burst of raw fs events into one message. */
const FLUSH_MS = 120;

/** Debounce window for HEAD writes — git rewrites HEAD via a lock-file rename,
 *  which can surface as a couple of events in quick succession. */
const HEAD_FLUSH_MS = 150;

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
  // Linked worktrees. `.worktrees` now sits *inside* the repo being watched, so
  // without this every branch checkout would replay the whole tree as changes.
  '.worktrees',
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

/** Immediate subdirectories of `dir` worth watching (ignored ones excluded). */
function watchableTopLevelDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !IGNORED_SEGMENTS.has(d.name))
      .map(d => d.name);
  } catch {
    return [];
  }
}

/** Attach one watcher to `dir` and wire it into `entry`.
 *  `prefix` ('' for the cwd watcher, 'name/' for a subtree) is prepended to the
 *  filenames it reports so every path stays relative to the session cwd.
 *  Returns false when the watch couldn't be established. */
function attachWatch(
  entry: Entry,
  sessionId: string,
  dir: string,
  prefix: string,
  recursive: boolean,
): boolean {
  let watcher: FSWatcher;
  try {
    watcher = watch(dir, { recursive });
  } catch (err) {
    logError(`[watch] could not watch ${dir} for ${sessionId.slice(0, 8)}: ${err}`);
    return false;
  }

  watcher.on('change', (eventType, filename) => {
    if (!filename) return;
    const raw = toPosix(typeof filename === 'string' ? filename : filename.toString());
    const rel = prefix ? `${prefix}${raw}` : raw;
    if (isIgnored(rel)) return;
    // The cwd watcher is non-recursive, so a directory appearing at the top
    // level needs its own subtree watcher or its contents go unwatched.
    if (!prefix && !rel.includes('/')) attachNewTopLevelDir(entry, sessionId, rel);
    record(entry, sessionId, String(eventType), rel);
  });
  watcher.on('error', (err) => {
    logError(`[watch] watcher error for ${sessionId.slice(0, 8)}: ${err}`);
  });

  entry.watchers.push(watcher);
  return true;
}

function attachSubtree(entry: Entry, sessionId: string, name: string): void {
  if (entry.watchedTopLevel.has(name)) return;
  entry.watchedTopLevel.add(name);
  attachWatch(entry, sessionId, join(entry.cwd, name), `${name}/`, true);
}

/** A top-level entry changed — start watching inside it if it's a directory we
 *  care about and aren't already following. */
function attachNewTopLevelDir(entry: Entry, sessionId: string, name: string): void {
  if (IGNORED_SEGMENTS.has(name) || entry.watchedTopLevel.has(name)) return;
  try {
    if (!statSync(join(entry.cwd, name)).isDirectory()) return;
  } catch {
    return; // removed, or unreadable
  }
  attachSubtree(entry, sessionId, name);
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

  const entry: Entry = {
    cwd,
    watchers: [],
    watchedTopLevel: new Set(),
    broadcast,
    pending: new Map(),
    flushTimer: null,
    knownDirs: new Set(),
    headWatcher: null,
    branch: null,
    headTimer: null,
  };

  // One watcher on the cwd itself — top-level files, and new top-level dirs —
  // plus one recursive watcher per top-level directory we actually care about.
  //
  // A single `watch(cwd, { recursive: true })` looks simpler but registers an
  // inotify watch for every directory in the tree, `node_modules` and `.git`
  // included. On a typical repo that's tens of thousands of descriptors held
  // for events `isIgnored` discards anyway, and it's enough to blow past the
  // per-user inotify limit — at which point the subtrees we *do* want fail to
  // register and their changes are silently never reported.
  if (!attachWatch(entry, sessionId, cwd, '', false)) return;
  for (const name of watchableTopLevelDirs(cwd)) attachSubtree(entry, sessionId, name);

  watchers.set(sessionId, entry);
  log(`[watch] started for ${sessionId.slice(0, 8)} at ${cwd} (${entry.watchers.length} watches)`);

  // Resolve the git dir and start watching HEAD asynchronously — the file
  // watcher above is live regardless of whether this is a git repo.
  void startBranchWatcher(entry, sessionId);
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
  if (entry.headTimer) {
    clearTimeout(entry.headTimer);
    entry.headTimer = null;
  }
  for (const watcher of entry.watchers) {
    try {
      watcher.close();
    } catch {}
  }
  entry.watchers.length = 0;
  entry.watchedTopLevel.clear();
  try {
    entry.headWatcher?.close();
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

/** Read the currently checked-out branch for `cwd`. Empty when detached. */
async function readBranch(cwd: string): Promise<string> {
  return (await runShell('git branch --show-current', cwd)).trim();
}

/**
 * Watch the session repo's HEAD and broadcast `branch_changed` whenever the
 * checked-out branch changes (e.g. `git checkout`, switching worktrees).
 *
 * We resolve the *absolute* git dir so this works for linked worktrees too,
 * whose HEAD lives under the main repo's `.git/worktrees/<name>/HEAD` —
 * outside the recursive cwd watch. We watch the git dir non-recursively (not
 * the HEAD file directly) because git rewrites HEAD via a lock-file rename,
 * which would invalidate an inode-bound watch on the file itself on Linux.
 */
async function startBranchWatcher(entry: Entry, sessionId: string): Promise<void> {
  let gitDir: string;
  try {
    gitDir = (await runShell('git rev-parse --absolute-git-dir', entry.cwd)).trim();
  } catch {
    return; // not a git repo (or git unavailable) — nothing to watch
  }
  if (!gitDir) return;
  // The watcher may have been stopped (or restarted onto a new cwd) while we
  // were awaiting git — bail unless we're still the live entry.
  if (watchers.get(sessionId) !== entry) return;

  try { entry.branch = await readBranch(entry.cwd); } catch {}

  try {
    entry.headWatcher = watch(gitDir, (_event, filename) => {
      if (!filename || String(filename) !== 'HEAD') return;
      if (entry.headTimer) return;
      entry.headTimer = setTimeout(() => {
        entry.headTimer = null;
        void flushBranch(entry, sessionId);
      }, HEAD_FLUSH_MS);
    });
    entry.headWatcher.on('error', (err) => {
      logError(`[watch] HEAD watcher error for ${sessionId.slice(0, 8)}: ${err}`);
    });
    log(`[watch] HEAD watch started for ${sessionId.slice(0, 8)} at ${gitDir}`);
  } catch (err) {
    logError(`[watch] could not watch HEAD for ${sessionId.slice(0, 8)}: ${err}`);
  }
}

/** Re-read the branch and broadcast only when it actually changed — a commit
 *  or other ref update doesn't move HEAD's content, and we dedupe so repeated
 *  HEAD rewrites for the same branch stay quiet. */
async function flushBranch(entry: Entry, sessionId: string): Promise<void> {
  let branch: string;
  try { branch = await readBranch(entry.cwd); } catch { return; }
  if (branch === entry.branch) return;
  entry.branch = branch;
  try {
    entry.broadcast(sessionId, { type: 'branch_changed', sessionId, branch });
  } catch (err) {
    logError(`[watch] branch broadcast failed for ${sessionId.slice(0, 8)}: ${err}`);
  }
}
