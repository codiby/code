/**
 * Resolves the user's env-var overrides for a given session — both the
 * global list (`globalEnvVars` in ui-preferences.json) and the
 * per-project list (`tabGroups[gid].envVars` for the session's group).
 *
 * Used by `exec_shell` Bash tool calls (server/handlers/exec.ts) and
 * by user-opened terminal panes (server/pty.ts), so commands launched
 * inside a project see the project's API keys / config without the
 * user having to remember to export them every shell.
 *
 * The Claude provider itself runs in-process and inherits the bun
 * server's env, so it is NOT covered here — global envs that need to
 * reach Claude must be set on the bun server, not via this module.
 */

import { loadPreferences } from './storage';

interface EnvVarRow {
  key: string;
  value: string;
}

interface PrefsShape {
  globalEnvVars?: EnvVarRow[];
  tabGroups?: Record<string, { envVars?: EnvVarRow[] }>;
  tabGroupMap?: Record<string, string>;
}

/** Returns a flat key→value record of the env overrides that should be
 *  layered on top of `process.env` for this session. Empty when the
 *  session is not part of a group and no globals are defined. The
 *  caller decides the precedence — typically `{ ...process.env,
 *  ...getSessionEnvOverrides(id) }` so project envs win. */
export function getSessionEnvOverrides(sessionId: string | undefined | null): Record<string, string> {
  const prefs = loadPreferences() as PrefsShape;
  const out: Record<string, string> = {};

  // Global first so project values win on conflict.
  const global = Array.isArray(prefs.globalEnvVars) ? prefs.globalEnvVars : [];
  for (const row of global) {
    if (row && typeof row.key === 'string' && row.key.trim()) {
      out[row.key.trim()] = typeof row.value === 'string' ? row.value : '';
    }
  }

  if (sessionId && prefs.tabGroupMap && prefs.tabGroups) {
    const gid = prefs.tabGroupMap[sessionId];
    const group = gid ? prefs.tabGroups[gid] : undefined;
    const list = Array.isArray(group?.envVars) ? group!.envVars! : [];
    for (const row of list) {
      if (row && typeof row.key === 'string' && row.key.trim()) {
        out[row.key.trim()] = typeof row.value === 'string' ? row.value : '';
      }
    }
  }

  return out;
}
