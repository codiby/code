/**
 * Which Slack messages belong in the Inbox, and how they read there. Pure:
 * the Socket Mode client and the startup backfill both feed messages through
 * `slackMessageToItem`, so realtime and catch-up produce identical items.
 */

import type { InboxInput } from './store';
import { emojifyMarkdown, emojifyPlain } from './emoji';

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
  return emojifyPlain(text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${userName(id)}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, (_, name) => `#${name}`)
    .replace(/<!(here|channel|everyone)>/g, (_, w) => `@${w}`)
    .replace(/<([^|>]+)\|([^>]+)>/g, (_, _url, label) => label)
    .replace(/<(https?:[^>]+)>/g, (_, url) => url)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
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

/** Slack mrkdwn → the Markdown the app renders. Code (fenced and inline) is
 *  passed through untouched; everywhere else: links keep their target,
 *  mentions become names, `*b*`/`_i_`/`~s~` become `**b**`/`*i*`/`~~s~~`, and
 *  `•` bullets become list items. Lines stay lines (the renderer is
 *  line-based, like Slack). */
export function slackToMarkdown(text: string, userName: (id: string) => string, me?: string): string {
  // Shortcodes last, so a `:name:` inside a link label still converts.
  // A person's mention links to them (`slack-user:`), so the Inbox can open
  // their DM; your own name stays plain.
  const inline = (s: string) => emojifyMarkdown(s
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => (id === me ? `**@${userName(id)}**` : `[@${userName(id).replace(/[[\]]/g, '')}](slack-user:${id})`))
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, (_, name) => `**#${name}**`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, name) => `**${name ?? '@team'}**`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_, w) => `**@${w}**`)
    .replace(/<mailto:([^|>]+)\|([^>]+)>/g, (_, _a, label) => label)
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, (_, url, label) => `[${label}](${url})`)
    .replace(/<(https?:[^>]+)>/g, (_, url) => url)
    .replace(/(^|[\s(])\*([^*\n]+?)\*(?=$|[\s).,!?:;])/g, '$1**$2**')
    .replace(/(^|[\s(])_([^_\n]+?)_(?=$|[\s).,!?:;])/g, '$1*$2*')
    .replace(/(^|[\s(])~([^~\n]+?)~(?=$|[\s).,!?:;])/g, '$1~~$2~~')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));

  const out: string[] = [];
  let inFence = false;
  for (const raw of text.split('\n')) {
    // Slack lets a fence open mid-line (```code```); give it lines of its own.
    const parts = raw.split('```');
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) { out.push('```'); inFence = !inFence; }
      const seg = parts[p]!;
      if (inFence) { if (seg) out.push(seg.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')); continue; }
      if (!seg && parts.length > 1) continue;
      // Bullets: Slack sends • and ◦ (nested), indented by spaces.
      const bullet = /^(\s*)[•◦▪]\s+(.*)$/.exec(seg);
      const line = bullet ? `${'  '.repeat(Math.min(3, Math.round(bullet[1]!.length / 4)))}- ${bullet[2]}` : seg;
      // Inline code stays verbatim; only the text around it is converted.
      out.push(line.split(/(`[^`\n]+`)/).map((chunk, i) => (i % 2 ? chunk : inline(chunk))).join('')
        // A Slack line starting with # isn't a heading.
        .replace(/^(\s*)#/, '$1\\#'));
    }
  }
  if (inFence) out.push('```');
  return out.join('\n');
}

/** Open Slack items that a message of the user's own answers: anything in
 *  the same thread (the thread's opening message included), or, in a DM,
 *  anything said before it outside a thread. */
export function itemsAnsweredBy(
  items: { id: string; source: string; context: Record<string, unknown> }[],
  mine: { channel: string; ts: string; thread_ts?: string },
): string[] {
  // DM channel ids start with D; an mpim is a C/G id, answered in threads only.
  const direct = mine.channel.startsWith('D');
  return items.filter(i => {
    if (i.source !== 'slack' || i.context.channel !== mine.channel) return false;
    const ts = String(i.context.ts ?? '');
    const thread = i.context.threadTs ? String(i.context.threadTs) : null;
    if (mine.thread_ts) return thread === mine.thread_ts || ts === mine.thread_ts;
    return direct && !thread && Number(ts) < Number(mine.ts);
  }).map(i => i.id);
}
