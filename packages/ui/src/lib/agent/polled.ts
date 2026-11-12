/**
 * Which responses a polled Agent section may still show.
 *
 * A section's loads overlap: a poll still out when the next one starts, a
 * search typed on (Memory's query, Reminders' "show past"). Responses come
 * back in any order, and the older one landing last would put results for
 * "caf" under a box that says "cafe". So each load takes a ticket, and a
 * response only counts when nothing newer has been shown and its inputs are
 * still the current ones.
 *
 * "Newer than what was shown", not "the newest started": with a slow host
 * every poll is overtaken by the next before it answers, and the section
 * must still update.
 */
export interface ResponseOrder {
  /** Take a ticket when a load starts; `accept()` says whether its response may be shown. */
  begin(): { accept(): boolean };
  /** The inputs changed (or the section unmounted): every load out now is stale. */
  invalidate(): void;
}

/**
 * The first host whose agent is enabled, probing in order (this computer,
 * then each remote); `fallback` when none is. Probing a remote over a tunnel
 * can take seconds, so the owner may pick a host from the menu meanwhile:
 * `keepGoing()` turning false stops the search, and null means "leave the
 * owner's choice alone".
 */
export async function discoverAgentHost<T>(
  candidates: T[],
  isEnabled: (host: T) => Promise<boolean>,
  keepGoing: () => boolean,
  fallback: T,
): Promise<{ host: T } | null> {
  for (const host of candidates) {
    let enabled = false;
    try { enabled = await isEnabled(host); } catch { /* unreachable host: try the next */ }
    if (!keepGoing()) return null;
    if (enabled) return { host };
  }
  return keepGoing() ? { host: fallback } : null;
}

export function createResponseOrder(): ResponseOrder {
  let epoch = 0;
  let issued = 0;
  let shown = 0;
  return {
    begin() {
      const mine = { epoch, seq: ++issued };
      return {
        accept() {
          if (mine.epoch !== epoch || mine.seq <= shown) return false;
          shown = mine.seq;
          return true;
        },
      };
    },
    invalidate() {
      epoch++;
    },
  };
}
