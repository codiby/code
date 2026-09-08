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
import { logError } from '../lib/logger';
import { CODIBY_DIR } from '../config/config';


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

/** Prefix the frontend gives a group it renders on behalf of a remote
 *  (`ui/src/lib/remote-groups.ts` — keep the two in step). Identity by prefix
 *  rather than by "is it in some remote's cache" is what makes the check
 *  reliable: a cache can be stale, empty, or belong to a remote that has since
 *  been removed, and every one of those cases used to let another machine's
 *  group settle into ui-preferences.json for good. */
export const REMOTE_GROUP_PREFIX = 'rmt:';

/** True if `groupId` belongs to another machine, and so must never be written
 *  to this machine's preferences file. */
export function isRemoteGroupId(groupId: string): boolean {
  return groupId.startsWith(REMOTE_GROUP_PREFIX);
}
