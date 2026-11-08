/**
 * The Inbox's stored items: what reaches the user from outside a session
 * (Slack, pull requests). Writes broadcast to every connected window so the
 * Inbox updates in real time; the broadcaster is injected by the server.
 */

import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import { database } from '../database';
import { inboxItems, type InboxItemRecord } from '../database/schema';

export interface InboxItem {
  id: string;
  source: 'slack' | 'pr';
  kind: string;
  title: string;
  body: string;
  context: Record<string, unknown>;
  url: string | null;
  occurredAt: number;
  readAt: number | null;
  doneAt: number | null;
}

export type InboxInput = Omit<InboxItem, 'readAt' | 'doneAt'>;

type Broadcast = (msg: Record<string, unknown>) => void;
let broadcast: Broadcast = () => {};
export function setInboxBroadcaster(fn: Broadcast): void { broadcast = fn; }

function toItem(r: InboxItemRecord): InboxItem {
  let context: Record<string, unknown> = {};
  try { context = JSON.parse(r.context); } catch { /* keep empty */ }
  return {
    id: r.id, source: r.source as InboxItem['source'], kind: r.kind, title: r.title, body: r.body,
    context, url: r.url, occurredAt: r.occurredAt, readAt: r.readAt, doneAt: r.doneAt,
  };
}

export function getInboxItem(id: string): InboxItem | null {
  const r = database.select().from(inboxItems).where(eq(inboxItems.id, id)).get();
  return r ? toItem(r) : null;
}

/** Insert a new item. An id already stored is left as is (realtime and the
 *  startup backfill can both see one message) — returns whether it was new. */
export function addInboxItem(input: InboxInput, now = Date.now()): boolean {
  if (getInboxItem(input.id)) return false;
  database.insert(inboxItems).values({
    id: input.id, source: input.source, kind: input.kind, title: input.title, body: input.body,
    context: JSON.stringify(input.context ?? {}), url: input.url ?? null,
    occurredAt: input.occurredAt, createdAt: now,
  }).run();
  broadcast({ type: 'inbox_item', item: getInboxItem(input.id) });
  return true;
}

/** Open items, newest first. */
export function listOpenInbox(limit = 200): InboxItem[] {
  return database.select().from(inboxItems)
    .where(isNull(inboxItems.doneAt))
    .orderBy(desc(inboxItems.occurredAt))
    .limit(limit).all().map(toItem);
}

export function markInboxDone(id: string, now = Date.now()): boolean {
  const cur = getInboxItem(id);
  if (!cur || cur.doneAt) return false;
  database.update(inboxItems).set({ doneAt: now, readAt: cur.readAt ?? now })
    .where(and(eq(inboxItems.id, id), isNull(inboxItems.doneAt))).run();
  broadcast({ type: 'inbox_removed', id });
  return true;
}

export function markInboxRead(id: string, now = Date.now()): boolean {
  const cur = getInboxItem(id);
  if (!cur || cur.readAt) return false;
  database.update(inboxItems).set({ readAt: now })
    .where(and(eq(inboxItems.id, id), isNull(inboxItems.readAt))).run();
  broadcast({ type: 'inbox_item', item: getInboxItem(id) });
  return true;
}

/** Record that an agent session is working on the item. The link lives in
 *  the item's context, so every window shows it "with an agent". */
export function linkInboxSession(id: string, sessionId: string, now = Date.now()): boolean {
  const cur = getInboxItem(id);
  if (!cur) return false;
  const context = { ...cur.context, sessionId, handedAt: now };
  database.update(inboxItems).set({ context: JSON.stringify(context), readAt: cur.readAt ?? now })
    .where(eq(inboxItems.id, id)).run();
  broadcast({ type: 'inbox_item', item: getInboxItem(id) });
  return true;
}

/** Close every open item of `source` that `stillOpen` no longer lists — a PR
 *  that got reviewed, checks that went green. */
export function closeMissing(source: InboxItem['source'], stillOpen: Set<string>, now = Date.now()): void {
  for (const item of listOpenInbox(1000)) {
    if (item.source === source && !stillOpen.has(item.id)) markInboxDone(item.id, now);
  }
}

/** Housekeeping: forget finished items after a month. */
export function pruneInbox(now = Date.now()): void {
  database.delete(inboxItems).where(lt(inboxItems.doneAt, now - 30 * 86_400_000)).run();
}
