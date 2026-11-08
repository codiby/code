/**
 * Which Slack messages belong in the Inbox, and how they read there. Pure:
 * the Socket Mode client and the startup backfill both feed messages through
 * `slackMessageToItem`, so realtime and catch-up produce identical items.
 */

import type { InboxInput } from './store';

export interface SlackMessage {
  type?: string;
  subtype?: string;
  channel: string;
  channel_type?: string;       // 'im' | 'mpim' | 'channel' | 'group'
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
}

export interface SlackLookup {
  /** The connected user's id (Uxxx). */
  me: string;
  /** e.g. https://acme.slack.com/ */
  teamUrl?: string;
  userName: (id: string) => string;
  channelName: (id: string) => string;
  /** Thread roots (ts) the user has written in. */
  myThreads: ReadonlySet<string>;
}

/** Subtypes that are still someone talking to you. Edits, joins, topic
 *  changes and the like are not. */
const TALKING = new Set([undefined, '', 'thread_broadcast', 'file_share', 'me_message']);

/** Slack markup → plain text: `<@U1>` → `@name`, `<#C1|dev>` → `#dev`,
 *  `<https://x|label>` → `label`, plus the three HTML entities Slack escapes. */
export function plainSlackText(text: string, userName: (id: string) => string): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${userName(id)}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, (_, name) => `#${name}`)
    .replace(/<!(here|channel|everyone)>/g, (_, w) => `@${w}`)
    .replace(/<([^|>]+)\|([^>]+)>/g, (_, _url, label) => label)
    .replace(/<(https?:[^>]+)>/g, (_, url) => url)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function slackPermalink(teamUrl: string | undefined, channel: string, ts: string, threadTs?: string): string | null {
  if (!teamUrl) return null;
  const base = `${teamUrl.replace(/\/+$/, '')}/archives/${channel}/p${ts.replace('.', '')}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channel}` : base;
}

const isDirect = (m: SlackMessage) => m.channel_type === 'im' || m.channel_type === 'mpim' || m.channel.startsWith('D');

/** The Inbox item for `m`, or null when it isn't waiting on the user. */
export function slackMessageToItem(m: SlackMessage, l: SlackLookup): InboxInput | null {
  if (!TALKING.has(m.subtype)) return null;
  if (!m.user || m.user === l.me || m.bot_id) return null;
  const text = m.text ?? '';
  const mentioned = text.includes(`<@${l.me}>`) || text.includes(`<@${l.me}|`);
  const inMyThread = !!m.thread_ts && m.thread_ts !== m.ts && l.myThreads.has(m.thread_ts);
  const kind = isDirect(m) ? 'dm' : mentioned ? 'mention' : inMyThread ? 'thread_reply' : null;
  if (!kind) return null;

  const author = l.userName(m.user);
  const where = isDirect(m)
    ? (m.channel_type === 'mpim' ? 'group message' : 'direct message')
    : `#${l.channelName(m.channel)}`;
  return {
    id: `slack:${m.channel}:${m.ts}`,
    source: 'slack',
    kind,
    title: author,
    body: plainSlackText(text, l.userName).slice(0, 2000),
    context: {
      channel: m.channel,
      ts: m.ts,
      threadTs: m.thread_ts ?? null,
      user: m.user,
      where,
      inThread: !!m.thread_ts && m.thread_ts !== m.ts,
    },
    url: slackPermalink(l.teamUrl, m.channel, m.ts, m.thread_ts),
    occurredAt: Math.round(Number(m.ts) * 1000),
  };
}
