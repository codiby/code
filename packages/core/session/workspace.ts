/**
 * A session's working directories.
 *
 * `session.cwd` is the primary one: the editor's file tree, the file watcher,
 * git status, LSP and new terminals all follow it. `additionalDirectories` are
 * the extra folders the agent may work in — the same idea as Claude Code's
 * `--add-dir`. Both can change while the session runs (see the
 * `ui_*_working_directory` MCP tools), so everything that reads them must
 * tolerate a change between turns.
 *
 * The provider process itself can't move: its cwd is fixed at spawn, and a
 * Claude transcript is stored under the project folder of the directory it was
 * started in, so resuming it from anywhere else finds nothing. `providerCwd`
 * records where the running conversation was started; a resume spawns there
 * and every other workspace directory goes in as an additional directory.
 */
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { isAbsolute, resolve, sep } from 'path';
import { saveSessions } from './sessions';
import { getSessionState, updateSessionState } from './state';
import { startSessionWatcher } from './watcher';
import type { Session } from '../types';

export type WorkspaceDeps = {
  broadcastToSession: (sessionId: string, msg: object) => void;
  broadcastSessionList: () => void;
};

/** Primary cwd first, then the additional directories, without duplicates. */
export function workspaceDirs(session: Pick<Session, 'cwd' | 'additionalDirectories'>): string[] {
  return [...new Set([session.cwd, ...(session.additionalDirectories ?? [])].filter(Boolean))];
}

/** Every workspace directory except `cwd` — what the provider gets as
 *  additional directories when it runs in `cwd`. */
export function additionalDirsFor(session: Pick<Session, 'cwd' | 'additionalDirectories'>, cwd: string): string[] {
  return workspaceDirs(session).filter(d => d !== cwd);
}

/** True when `path` is one of the session's workspace directories or inside one. */
export function isInWorkspace(session: Pick<Session, 'cwd' | 'additionalDirectories'>, path: string): boolean {
  const target = resolve(path);
  return workspaceDirs(session).some(dir => target === dir || target.startsWith(dir.endsWith(sep) ? dir : dir + sep));
}

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead']);

/**
 * True for a read-only tool whose target sits in an additional directory.
 * Claude already treats its own working directories this way, but only the
 * ones it was spawned with — a folder added mid-session would otherwise raise
 * an approval card on every read until the next restart.
 */
export function isWorkspaceRead(session: Session, toolName: string, input: Record<string, unknown>): boolean {
  if (!READ_TOOLS.has(toolName) || !session.additionalDirectories?.length) return false;
  const target = input.file_path ?? input.notebook_path ?? input.path;
  return typeof target === 'string' && isAbsolute(target) && isInWorkspace(session, target);
}

/**
 * Resolve a model-supplied directory: `~` expands to the home folder, relative
 * paths resolve against the session cwd. Rejects anything that isn't an
 * existing directory.
 */
export async function resolveDirectory(raw: string, base: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { ok: false, error: 'path is required.' };
  const expanded = trimmed === '~' ? homedir() : trimmed.startsWith('~/') ? homedir() + trimmed.slice(1) : trimmed;
  const path = isAbsolute(expanded) ? resolve(expanded) : resolve(base || homedir(), expanded);
  try {
    const stat = await fs.stat(path);
    if (!stat.isDirectory()) return { ok: false, error: `${path} is not a directory.` };
  } catch {
    return { ok: false, error: `${path} does not exist.` };
  }
  return { ok: true, path };
}

/**
 * Make `path` the session's primary working directory. The previous one stays
 * in the workspace as an additional directory unless `keepPrevious` is false.
 */
export function setWorkingDirectory(session: Session, path: string, deps: WorkspaceDeps, keepPrevious = true): void {
  const previous = session.cwd;
  const extra = (session.additionalDirectories ?? []).filter(d => d !== path);
  if (keepPrevious && previous && previous !== path && !extra.includes(previous)) extra.unshift(previous);
  session.cwd = path;
  session.additionalDirectories = extra;
  applyWorkspace(session, deps);
}

/** Add directories to the workspace. Returns the ones that were new. */
export function addWorkingDirectories(session: Session, paths: string[], deps: WorkspaceDeps): string[] {
  const known = new Set(workspaceDirs(session));
  const added = [...new Set(paths)].filter(p => !known.has(p));
  if (added.length === 0) return [];
  session.additionalDirectories = [...(session.additionalDirectories ?? []), ...added];
  applyWorkspace(session, deps);
  return added;
}

/** Drop an additional directory. The primary cwd can't be removed — change it first. */
export function removeWorkingDirectory(session: Session, path: string, deps: WorkspaceDeps): boolean {
  const extra = session.additionalDirectories ?? [];
  if (!extra.includes(path)) return false;
  session.additionalDirectories = extra.filter(d => d !== path);
  applyWorkspace(session, deps);
  return true;
}

/** Persist the workspace and push it everywhere that depends on it. */
function applyWorkspace(session: Session, deps: WorkspaceDeps): void {
  session.updatedAt = Date.now();
  saveSessions();

  // The explorer reads its root from `initInfo.cwd` first, which otherwise
  // keeps pointing at wherever the provider process was started.
  const prev = getSessionState(session.id).initInfo;
  if (prev && prev.cwd !== session.cwd) {
    const initInfo = { ...prev, cwd: session.cwd };
    updateSessionState(session.id, s => ({ ...s, initInfo }));
    deps.broadcastToSession(session.id, { type: 'init_info', sessionId: session.id, info: initInfo });
  }

  // Remote sessions' folders live on the other machine.
  if (!session.remoteId) startSessionWatcher(session.id, session.cwd, deps.broadcastToSession);

  const provider = session.providerSession;
  if (provider?.setWorkspace) {
    const processCwd = spawnCwdFor(session, true);
    void provider.setWorkspace({ cwd: session.cwd, additionalDirectories: additionalDirsFor(session, processCwd) }).catch(() => {});
  }

  deps.broadcastSessionList();
}

/**
 * Where a provider spawn should run. A fresh conversation starts in the
 * session cwd; a Claude/OpenCode resume goes back to where the conversation
 * was started (Codex threads resume from anywhere).
 */
export function spawnCwdFor(session: Session, resuming: boolean): string {
  if (!resuming || session.provider === 'codex') return session.cwd;
  return session.providerCwd || session.cwd;
}

/** System-prompt block for a workspace that isn't just the spawn cwd. Null otherwise. */
export function workspacePrompt(session: Session, spawnCwd: string): string | null {
  const extra = additionalDirsFor(session, session.cwd);
  if (spawnCwd === session.cwd && extra.length === 0) return null;
  const lines = ['Workspace (Codiby Code):', `- Working directory: ${session.cwd}`];
  if (spawnCwd !== session.cwd) {
    lines.push(`- The session was started in ${spawnCwd} and later moved. \`cd\` into the working directory before running shell commands, and use absolute paths for file tools.`);
  }
  if (extra.length) lines.push(`- Additional directories you may work in: ${extra.join(', ')}`);
  return lines.join('\n');
}

/** Tool-result text describing the workspace, so the agent knows where it is. */
export function describeWorkspace(session: Session): string {
  const extra = session.additionalDirectories ?? [];
  const lines = [`Working directory: ${session.cwd}`];
  lines.push(extra.length ? `Additional directories:\n${extra.map(d => `  - ${d}`).join('\n')}` : 'Additional directories: none');
  const processCwd = spawnCwdFor(session, true);
  if (session.providerSession && processCwd !== session.cwd) {
    lines.push(`Your shell was started in ${processCwd}. Run \`cd ${JSON.stringify(session.cwd)}\` before relying on relative paths in shell commands, and prefer absolute paths for file tools.`);
  }
  return lines.join('\n');
}
