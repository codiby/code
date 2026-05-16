/**
 * One-shot migration: relocate Codiby's persisted state from the legacy
 * `~/.claude/ui-*` paths to `~/.codiby/`. Runs at startup before
 * loadSessions / loadRemotes, so the freshly-renamed files are what
 * those loaders see.
 *
 * We only move files/dirs we own. `~/.claude/bin/claude`,
 * `~/.claude/settings.json`, and anything else the Claude CLI itself
 * writes there stay put.
 */

import { existsSync, renameSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { log, logError } from './logger';
import { CODIBY_DIR } from './config';

const LEGACY_DIR = join(homedir(), '.claude');

/** Items owned by Codiby (relative names under the legacy dir). */
const MIGRATE_ITEMS = [
  'ui-sessions.json',
  'ui-preferences.json',
  'ui-mobile-token',
  'ui-pr-links.json',
  'ui-telegram.json',
  'ui-deepgram.json',
  'ui-tailscale.json',
  'ui-remotes.json',
  'ui-sessions',          // dir — message history + UI state per session
  'ui-processes',         // dir — tracked-process registry
  'ui-remote-sessions',   // dir — remote session metadata cache
  'tls',                  // dir — mkcert-issued certs
  'ssh-control',          // dir — ssh ControlPath sockets
];

/** Move each known item from `~/.claude/<name>` to `~/.codiby/<name>`
 *  the first time we see it. If the destination already exists we leave
 *  the source alone (assume manual setup or prior run). */
export function migrateToCodiby() {
  if (!existsSync(LEGACY_DIR)) return;
  try { mkdirSync(CODIBY_DIR, { recursive: true }); } catch {}
  let moved = 0;
  for (const name of MIGRATE_ITEMS) {
    const src = join(LEGACY_DIR, name);
    const dst = join(CODIBY_DIR, name);
    if (!existsSync(src) || existsSync(dst)) continue;
    try {
      renameSync(src, dst);
      moved++;
    } catch (e) {
      logError(`[migrate] Failed to move ${name}: ${e}`);
    }
  }
  if (moved) log(`[migrate] Moved ${moved} item(s) from ~/.claude/ to ~/.codiby/`);
}
