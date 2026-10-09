/**
 * Turns cut off by the bridge going away — the app quitting with its sidecar,
 * a crash, a kill — so the next launch can offer to resume them.
 *
 * While the bridge runs, the ids of sessions mid-turn are mirrored to a small
 * file whenever `isStreaming` flips (see `updateSessionState`). A clean turn
 * end removes the id; a turn the process never got to finish stays on disk.
 * Shutdown freezes the file first, because closing the providers fires
 * `onExit` for every busy session, which would otherwise clear exactly the
 * entries this exists to keep.
 *
 * On boot the leftover ids become the "interrupted" list the UI asks about,
 * and the file starts empty for this run. A bridge that outlives the app (the
 * launchd service) never loses its turns, so it has nothing to report.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CODIBY_DIR } from '../config/config';
import { log } from '../lib/logger';

let FILE = join(CODIBY_DIR, 'inflight-turns.json');

/** Tests point this at a scratch file; the config module may already be loaded. */
export function setInterruptedTurnsFile(path: string) {
  FILE = path;
}

const inflight = new Set<string>();
let frozen = false;

export type InterruptedTurn = { sessionId: string; at: number };
let interrupted: InterruptedTurn[] = [];

function write() {
  try {
    writeFileSync(FILE, JSON.stringify({ at: Date.now(), sessionIds: [...inflight] }));
  } catch {}
}

/** Called on every `isStreaming` flip. Cheap when nothing changed. */
export function trackTurnState(sessionId: string, streaming: boolean) {
  if (frozen) return;
  if (streaming ? inflight.has(sessionId) : !inflight.has(sessionId)) return;
  if (streaming) inflight.add(sessionId);
  else inflight.delete(sessionId);
  write();
}

/** First thing on shutdown: keep the record of busy sessions as it is now. */
export function freezeTurnTracking() {
  frozen = true;
}

/**
 * Reads what the previous run left mid-turn. `keep` filters out sessions that
 * no longer exist or shouldn't be offered (archived, loops that come back
 * paused on their own).
 */
export function loadInterruptedTurns(keep: (sessionId: string) => boolean) {
  let ids: string[] = [];
  let at = Date.now();
  try {
    if (existsSync(FILE)) {
      const raw = JSON.parse(readFileSync(FILE, 'utf-8'));
      if (Array.isArray(raw?.sessionIds)) ids = raw.sessionIds.filter((s: unknown) => typeof s === 'string');
      if (typeof raw?.at === 'number') at = raw.at;
    }
  } catch {}
  interrupted = ids.filter(keep).map(sessionId => ({ sessionId, at }));
  if (interrupted.length) log(`[interrupted] ${interrupted.length} session(s) were mid-turn when the bridge stopped`);
  // This run starts with nothing in flight.
  inflight.clear();
  write();
}

export function getInterruptedTurns(): InterruptedTurn[] {
  return interrupted;
}

/** Drops ids from the list (resumed or dismissed); all of them when omitted. */
export function clearInterruptedTurns(sessionIds?: string[]) {
  interrupted = sessionIds ? interrupted.filter(t => !sessionIds.includes(t.sessionId)) : [];
}
