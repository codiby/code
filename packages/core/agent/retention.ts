/**
 * Retention for `agent_messages` — every message in and out of every channel,
 * including strangers' messages stored as untrusted content. It is a delivery
 * log for the Agent view, not the agent's memory (that lives in agent_memory),
 * so rows older than 90 days go: the table would otherwise grow for as long
 * as the agent runs, and it holds other people's words.
 *
 * The attachments those messages brought (inbound.ts saves them under
 * `~/.codiby/agent/files/YYYY-MM-DD/`) follow the same 90 days: a day's
 * folder goes once everything in it is older than that.
 *
 * Runs when the agent starts and then once a day. The DELETE walks
 * `agent_messages_created_idx`, so it costs a range scan of what it removes.
 */

import { lstatSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { sqliteHandle } from '../database';
import { log, logError } from '../lib/logger';
import { onAgentStart, onAgentStop } from './registry';
import { agentDataDir } from './store';

export const AGENT_MESSAGE_RETENTION_MS = 90 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** Delete messages created before `now - maxAgeMs`. Returns how many went. Never throws. */
export function pruneAgentMessages(now = Date.now(), maxAgeMs = AGENT_MESSAGE_RETENTION_MS): number {
  try {
    // Raw statement: drizzle's bun-sqlite run() doesn't report how many rows went.
    const removed = sqliteHandle.query('DELETE FROM agent_messages WHERE created_at < ?').run(now - maxAgeMs).changes;
    if (removed > 0) log(`[agent] Pruned ${removed} channel message(s) older than ${Math.round(maxAgeMs / 86_400_000)} days`);
    return removed;
  } catch (err) {
    logError(`[agent] Could not prune old channel messages: ${err}`);
    return 0;
  }
}

const DAY_DIR_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Start of the UTC day a `YYYY-MM-DD` folder is named after (saveAttachment names them by UTC date), or null. */
function dayStart(name: string): number | null {
  const m = DAY_DIR_RE.exec(name);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = Date.UTC(y, mo - 1, d);
  // Reject what Date.UTC would silently roll over (2026-02-31 → 3 March).
  const back = new Date(at);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return at;
}

/**
 * Delete `~/.codiby/agent/files/YYYY-MM-DD/` folders whose whole day is older
 * than `maxAgeMs`. Only that exact layout is touched: entries with any other
 * name, plain files and symlinks (which could point anywhere) are left alone.
 * Returns how many folders went. Never throws.
 */
export function pruneAgentFiles(now = Date.now(), maxAgeMs = AGENT_MESSAGE_RETENTION_MS, root = agentDataDir('files')): number {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0; // no attachments saved yet
  }
  let removed = 0;
  for (const name of entries) {
    const start = dayStart(name);
    if (start === null || start + DAY_MS > now - maxAgeMs) continue;
    const dir = join(root, name);
    try {
      // lstat: a symlink named like a day is someone else's folder, not ours to empty.
      if (!lstatSync(dir).isDirectory()) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch (err) {
      logError(`[agent] Could not prune ${dir}: ${err}`);
    }
  }
  if (removed > 0) log(`[agent] Pruned ${removed} attachment folder(s) older than ${Math.round(maxAgeMs / 86_400_000)} days`);
  return removed;
}

function pruneAll(): void {
  pruneAgentMessages();
  pruneAgentFiles();
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startMessageRetention(): void {
  pruneAll();
  if (timer) return;
  timer = setInterval(pruneAll, PRUNE_EVERY_MS);
  // A daily chore must not keep the process (or a test run) alive.
  (timer as { unref?: () => void }).unref?.();
}

export function stopMessageRetention(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

onAgentStart('retention', startMessageRetention);
onAgentStop('retention', stopMessageRetention);
