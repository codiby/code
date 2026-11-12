/**
 * Notifications held for the end of quiet hours, on disk so a bridge restart
 * (or an agent stop and start) doesn't lose them: `held-notifications.json`
 * in the agent data dir, owner-only (0600) since it holds message text.
 *
 * Everything read back is shape- and size-checked; a file that doesn't parse
 * reads as an empty queue.
 */

import { agentDataDir, createJsonStore } from '../store';
import type { OutboundPriority } from '../types';
import type { NotifyOrigin, NotifyRequest } from './notify';

export interface HeldNotification {
  id: string;
  req: NotifyRequest;
  /** The composed message, as it goes out. */
  body: string;
  heldAt: number;
  /** When quiet hours were due to end as it was held — the delivery time. */
  until: number;
}

/** The queue never grows past this; the oldest go first. */
export const MAX_HELD = 100;
const MAX_TEXT = 20_000;
const MAX_NAME = 500;

const PRIORITIES: ReadonlySet<OutboundPriority> = new Set(['low', 'normal', 'urgent']);
const ORIGINS: ReadonlySet<NotifyOrigin> = new Set(['tool', 'heartbeat', 'brief', 'reminder']);

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const time = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function held(raw: unknown): HeldNotification | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const q = (r.req && typeof r.req === 'object' ? r.req : {}) as Record<string, unknown>;
  const id = str(r.id, 100);
  const body = str(r.body, MAX_TEXT);
  const heldAt = time(r.heldAt);
  const until = time(r.until);
  const text = str(q.text, MAX_TEXT);
  const sessionId = str(q.sessionId, MAX_NAME);
  const sessionName = str(q.sessionName, MAX_NAME);
  if (!id || !body || heldAt === null || until === null || text === null || !sessionId || sessionName === null) return null;
  const req: NotifyRequest = {
    text,
    sessionId,
    sessionName,
    priority: PRIORITIES.has(q.priority as OutboundPriority) ? (q.priority as OutboundPriority) : 'low',
  };
  const title = str(q.title, MAX_NAME);
  if (title) req.title = title;
  const channelId = str(q.channelId, 200);
  if (channelId) req.channelId = channelId;
  if (ORIGINS.has(q.origin as NotifyOrigin)) req.origin = q.origin as NotifyOrigin;
  return { id, req, body, heldAt, until };
}

export const heldStore = createJsonStore<HeldNotification[]>({
  file: agentDataDir('held-notifications.json'),
  mode: 0o600,
  normalize: (raw) => {
    const items = (Array.isArray(raw) ? raw : []).map(held).filter((h): h is HeldNotification => h !== null);
    return items.length > MAX_HELD ? items.slice(-MAX_HELD) : items;
  },
});
