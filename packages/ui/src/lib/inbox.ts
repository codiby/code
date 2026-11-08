import type { InboxItem, SessionInfo } from './claude-client';

/**
 * The Inbox's rows: stored items from the bridge (Slack, pull requests) plus
 * items derived live from session state (a permission to grant, a finished
 * turn not yet read, an interrupted run). Each row says where it came from
 * first — the source decides the tile, the label and the colour — and lands
 * in one of three buckets by what it asks of the user.
 */

export type InboxSource = 'session' | 'slack' | 'pr';
export type InboxBucket = 'decision' | 'broke' | 'read';
export type RowStatus = 'wait' | 'err' | 'ok' | null;

export interface InboxRow {
  id: string;
  source: InboxSource;
  bucket: InboxBucket;
  /** Headline: a person, a PR title, a session name. */
  title: string;
  /** Second half of the source line: `#up-dev · mention in thread`. */
  where: string;
  body: string;
  tag?: { label: string; tone?: 'warn' | 'err' };
  /** Small badge on the source tile: a person's initials, or a state. */
  person?: string;
  status?: RowStatus;
  at: number;
  unread: boolean;
  sessionId?: string;
  item?: InboxItem;
}

export const BUCKETS: { key: InboxBucket; label: string }[] = [
  { key: 'decision', label: 'Needs a decision' },
  { key: 'broke', label: 'Something broke' },
  { key: 'read', label: 'To read' },
];

export interface SessionFlags {
  hasPermission: Record<string, boolean>;
  interrupted: Record<string, boolean>;
  awaitingReply: ReadonlySet<string>;
  lastMessageAt: Record<string, number>;
  lastPreview: Record<string, string>;
  /** `code · Opus 5.5` — where the session runs and with what. */
  describe: (s: SessionInfo) => string;
}

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1]![0] : parts[0]?.[1] ?? '')).toUpperCase();
}

export function sessionRows(sessions: SessionInfo[], f: SessionFlags): InboxRow[] {
  const rows: InboxRow[] = [];
  for (const s of sessions) {
    const base = {
      id: `session:${s.id}`, source: 'session' as const, title: s.name, where: f.describe(s),
      body: f.lastPreview[s.id] ?? '', at: f.lastMessageAt[s.id] || s.updated_at, unread: true, sessionId: s.id,
    };
    if (f.hasPermission[s.id]) rows.push({ ...base, bucket: 'decision', status: 'wait', tag: { label: 'Needs approval', tone: 'warn' } });
    else if (f.interrupted[s.id]) rows.push({ ...base, bucket: 'broke', status: 'err', tag: { label: 'Interrupted', tone: 'err' } });
    else if (f.awaitingReply.has(s.id)) rows.push({ ...base, bucket: 'read', status: 'ok', tag: { label: 'Turn finished' } });
  }
  return rows;
}

export function itemRow(item: InboxItem): InboxRow {
  const ctx = item.context as Record<string, string | number | boolean | null>;
  const unread = !item.readAt;
  if (item.source === 'slack') {
    const where = String(ctx.where ?? 'Slack');
    const what = item.kind === 'dm' ? '' : item.kind === 'mention' ? (ctx.inThread ? ' · mention in thread' : ' · mention') : ' · reply in your thread';
    return {
      id: item.id, source: 'slack', bucket: item.kind === 'dm' ? 'read' : 'decision',
      title: item.title, where: `${where}${what}`, body: item.body, person: initials(item.title),
      at: item.occurredAt, unread, item,
    };
  }
  const repo = String(ctx.repo ?? '').split('/').pop();
  if (item.kind === 'checks_failing') {
    return {
      id: item.id, source: 'pr', bucket: 'broke', title: item.title, where: `${repo} #${ctx.number} · yours`,
      body: item.body, status: 'err', tag: { label: 'Checks failing', tone: 'err' }, at: item.occurredAt, unread, item,
    };
  }
  return {
    id: item.id, source: 'pr', bucket: 'decision', title: item.title, where: `${repo} #${ctx.number} · review requested`,
    body: item.body, person: ctx.author ? initials(String(ctx.author)) : undefined, at: item.occurredAt, unread, item,
  };
}

/** Every row, bucket by bucket, newest first inside each. */
export function buildInboxRows(items: InboxItem[], sessions: SessionInfo[], f: SessionFlags): InboxRow[] {
  const rows = [...items.filter(i => !i.doneAt).map(itemRow), ...sessionRows(sessions, f)];
  const order = new Map(BUCKETS.map((b, i) => [b.key, i]));
  return rows.sort((a, b) => (order.get(a.bucket)! - order.get(b.bucket)!) || b.at - a.at);
}
