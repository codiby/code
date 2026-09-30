/** Disposable sessions: throwaway questions started from the launcher.
 *
 *  They run in the user's home directory, land in one fixed sidebar folder
 *  instead of a project group, and archive themselves once they have gone
 *  `disposableTtlMs` without activity. "Activity" is `updatedAt`, which
 *  `addMessage` bumps on every non-tool message, so a reply resets the clock.
 *
 *  Pure: the IO (preferences write, broadcast, timer) lives in `index.ts`.
 */

import type { AutoGroup } from '../config/auto-group';

/** Fixed id so every client and every restart finds the same folder. */
export const DISPOSABLES_GROUP_ID = 'disposables';

export const DISPOSABLE_TTLS_MS = [60 * 60_000, 24 * 60 * 60_000, 7 * 24 * 60 * 60_000] as const;

/** Accepts only the lifetimes the launcher offers, so a bad client can't
 *  create a session that expires the instant it's made. */
export function parseDisposableTtl(value: unknown): number | null {
  return typeof value === 'number' && (DISPOSABLE_TTLS_MS as readonly number[]).includes(value) ? value : null;
}

/** Files `sessionId` under the Disposables folder, creating the folder when it
 *  is missing (first use, or the user deleted it). */
export function placeInDisposables(
  sessionId: string,
  groups: Record<string, AutoGroup & { allowEmpty?: boolean }>,
  map: Record<string, string>,
): { groups: Record<string, AutoGroup>; map: Record<string, string> } {
  const nextGroups = { ...groups };
  if (!nextGroups[DISPOSABLES_GROUP_ID]) {
    nextGroups[DISPOSABLES_GROUP_ID] = {
      id: DISPOSABLES_GROUP_ID, name: 'Disposables', color: 'green', icon: 'timer',
      parentId: null, allowEmpty: true,
    };
  }
  return { groups: nextGroups, map: { ...map, [sessionId]: DISPOSABLES_GROUP_ID } };
}

/** Puts back every disposable that sits in no existing folder. A client that
 *  writes `tabGroups`/`tabGroupMap` wholesale from a stale copy drops the
 *  folder and its entries, and nothing else would ever re-file them. Null when
 *  every disposable is already filed. */
export function refileDisposables(
  list: Iterable<{ id: string; disposableTtlMs?: number | null }>,
  groups: Record<string, AutoGroup & { allowEmpty?: boolean }>,
  map: Record<string, string>,
): { groups: Record<string, AutoGroup>; map: Record<string, string> } | null {
  let out: { groups: Record<string, AutoGroup>; map: Record<string, string> } | null = null;
  for (const s of list) {
    if (!s.disposableTtlMs) continue;
    const current = (out ?? { groups, map });
    const gid = current.map[s.id];
    if (gid && current.groups[gid]) continue;
    out = placeInDisposables(s.id, current.groups, current.map);
  }
  return out;
}

type Candidate = { id: string; status: string; updatedAt: number; disposableTtlMs?: number | null; busy: boolean };

/** Ids of open disposables whose idle time has run out. A session mid-turn is
 *  skipped even when its clock says otherwise: a long tool run doesn't bump
 *  `updatedAt`, and archiving under a live answer would hide it. */
export function expiredDisposables(list: Iterable<Candidate>, now: number): string[] {
  const out: string[] = [];
  for (const s of list) {
    if (!s.disposableTtlMs || s.status !== 'open' || s.busy) continue;
    if (now - s.updatedAt >= s.disposableTtlMs) out.push(s.id);
  }
  return out;
}
