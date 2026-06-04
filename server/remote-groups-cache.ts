/**
 * Read-through cache of a remote's tab-group ("project") metadata.
 *
 * Tab groups live in each machine's ~/.codiby/ui-preferences.json under
 * `tabGroups` (group definitions) + `tabGroupMap` (sessionId → groupId).
 * Sessions spawned on a remote are grouped there, but that grouping never
 * reaches us — so remote sessions land ungrouped locally. We mirror the
 * subset of the remote's groups that its own sessions reference, then merge
 * it into the preferences blob we broadcast to the desktop client.
 *
 * Group ids are crypto.randomUUID() (see ChatApp.handleCreateGroup) so they're
 * globally unique — no namespacing needed to merge across machines.
 *
 * File layout:
 *   ~/.codiby/ui-remote-groups/{remoteId}.json  →  RemoteGroups
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { logError } from './logger';
import { CODIBY_DIR } from './config';
import { remotes } from './remotes';

export const REMOTE_GROUPS_DIR = join(CODIBY_DIR, 'ui-remote-groups');

export type RemoteGroups = {
  /** Group definitions, keyed by groupId. */
  tabGroups: Record<string, unknown>;
  /** sessionId → groupId for this remote's sessions. */
  tabGroupMap: Record<string, string>;
};

function fileFor(remoteId: string): string {
  return join(REMOTE_GROUPS_DIR, `${remoteId}.json`);
}

export function loadRemoteGroups(remoteId: string): RemoteGroups {
  try {
    const data = JSON.parse(readFileSync(fileFor(remoteId), 'utf-8'));
    if (data && typeof data === 'object') {
      return {
        tabGroups: data.tabGroups ?? {},
        tabGroupMap: data.tabGroupMap ?? {},
      };
    }
  } catch {
    // Missing or invalid — treat as empty.
  }
  return { tabGroups: {}, tabGroupMap: {} };
}

export function saveRemoteGroups(remoteId: string, data: RemoteGroups) {
  try {
    mkdirSync(REMOTE_GROUPS_DIR, { recursive: true });
    writeFileSync(fileFor(remoteId), JSON.stringify(data, null, 2));
  } catch (e) {
    logError(`[remote-groups] save ${remoteId} failed: ${e}`);
  }
}

export function clearRemoteGroups(remoteId: string) {
  try {
    if (existsSync(fileFor(remoteId))) unlinkSync(fileFor(remoteId));
  } catch (e) {
    logError(`[remote-groups] clear ${remoteId} failed: ${e}`);
  }
}

/** Union of every known remote's cached groups — what we splice into the
 *  preferences blob sent to the frontend. */
export function getMergedRemoteGroups(): RemoteGroups {
  const tabGroups: Record<string, unknown> = {};
  const tabGroupMap: Record<string, string> = {};
  for (const remoteId of remotes.keys()) {
    const g = loadRemoteGroups(remoteId);
    Object.assign(tabGroups, g.tabGroups);
    Object.assign(tabGroupMap, g.tabGroupMap);
  }
  return { tabGroups, tabGroupMap };
}

/** True if `groupId` belongs to a remote — used to strip remote groups back
 *  out before persisting the local preferences file (the client can't tell
 *  local from remote groups, so a prefs write echoes them back). */
export function isRemoteGroupId(groupId: string): boolean {
  for (const remoteId of remotes.keys()) {
    if (groupId in loadRemoteGroups(remoteId).tabGroups) return true;
  }
  return false;
}
