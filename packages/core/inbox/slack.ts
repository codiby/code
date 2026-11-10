/**
 * Slack → Inbox, in real time, one connection per project.
 *
 * Socket Mode: the bridge opens an *outbound* WebSocket to the user's own
 * Slack app and Slack pushes events down it — no public URL, no relay, no
 * open port. The app is subscribed to message events "on behalf of users",
 * so it sees what the user sees. On every (re)connect a backfill catches
 * what arrived while the bridge was down; ids make both paths idempotent.
 *
 * Each project can have its own connection (its own workspace and app). The
 * tokens live in ~/.codiby/slack/<project>.json (0600) on this machine only —
 * never in the synced preferences. A connection made before projects had
 * their own lives on as `default` (the old ~/.codiby/slack.json) until it is
 * moved into a project. Two connections can't share one Slack app: Slack
 * would split the events between them.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CODIBY_DIR } from '../config/config';
import { addInboxItem, getInboxItem, listOpenInbox, markInboxDone, retagConnection, rewriteOpenBodies, type InboxItem } from './store';
import { emojifyPlain, resolveEmoji, setCustomEmoji } from './emoji';
import { itemsAnsweredBy, plainSlackText, slackMessageToItem, slackToMarkdown, type SlackMessage } from './slack-events';

const DIR = join(CODIBY_DIR, 'slack');
const LEGACY_FILE = join(CODIBY_DIR, 'slack.json');
export const DEFAULT_CONNECTION = 'default';
const API = 'https://slack.com/api';
const BACKFILL_DAYS = 3;

interface SlackConfig {
  appToken: string;
  userToken: string;
  userId: string;
  userName: string;
  teamName: string;
  teamUrl: string;
}

export type SlackState = 'off' | 'connecting' | 'connected' | 'error';
export interface SlackStatus {
  state: SlackState;
  error?: string;
  user?: string;
  team?: string;
  teamUrl?: string;
}

let broadcast: (msg: Record<string, unknown>) => void = () => {};
export function setSlackBroadcaster(fn: (msg: Record<string, unknown>) => void): void { broadcast = fn; }

async function api<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, token: string): Promise<T & { ok: boolean; error?: string }> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.set(k, String(v));
  const resp = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (resp.status === 429) {
    const wait = Number(resp.headers.get('retry-after') || 5);
    await new Promise(r => setTimeout(r, wait * 1000));
    return api(method, params, token);
  }
  const data = await resp.json() as T & { ok: boolean; error?: string };
  if (!data.ok) throw new Error(`${method}: ${data.error ?? 'failed'}`);
  return data;
}

export interface Reaction { name: string; count: number; mine: boolean; unicode?: string; url?: string }
export interface ThreadMessage {
  user: string; name: string; text: string; markdown: string; ts: string; mine: boolean; bot: boolean;
  /** Profile picture (or a bot's icon), when Slack has one. */
  avatar?: string;
  reactions: Reaction[];
  /** The message that opened the thread. */
  root: boolean;
}

const fileOf = (id: string) => (id === DEFAULT_CONNECTION ? LEGACY_FILE : join(DIR, `${id.replace(/[^\w-]/g, '_')}.json`));
const connectionOfItem = (i: { context: Record<string, unknown> }) => String(i.context.connectionId ?? DEFAULT_CONNECTION);

/** No frame from Slack for this long and the socket is presumed dead. */
const SILENCE_MS = 20 * 60_000;

class SlackConnection {
  private socket: WebSocket | null = null;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  /** Last frame from Slack, and the watchdog's last tick (a gap means the
   *  machine slept). */
  private lastFrame = 0;
  private lastTick = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  status: SlackStatus = { state: 'off' };
  private users = new Map<string, string>();
  private avatars = new Map<string, string>();
  private channels = new Map<string, string>();
  /** Thread roots the user has written in, learned live and from the backfill. */
  private myThreads = new Set<string>();

  constructor(readonly id: string, public config: SlackConfig) {}

  private setStatus(next: SlackStatus): void {
    this.status = next;
    broadcast({ type: 'slack_status', id: this.id, status: next });
  }
  private who(): Pick<SlackStatus, 'user' | 'team' | 'teamUrl'> {
    return { user: this.config.userName, team: this.config.teamName, teamUrl: this.config.teamUrl };
  }

  // ── names, cached; the first sighting of an id falls back to the id ───────
  userName = (id: string): string => {
    if (!this.users.has(id)) { this.users.set(id, id); void this.warmUser(id); }
    return this.users.get(id) ?? id;
  };
  private async warmUser(id: string | undefined): Promise<void> {
    if (!id || (this.users.has(id) && this.users.get(id) !== id)) return;
    try {
      const r = await api<{ user: { real_name?: string; name?: string; profile?: { real_name?: string; display_name?: string; image_72?: string; image_48?: string } } }>('users.info', { user: id }, this.config.userToken);
      this.users.set(id, r.user.profile?.real_name || r.user.real_name || r.user.profile?.display_name || r.user.name || id);
      const pic = r.user.profile?.image_72 || r.user.profile?.image_48;
      if (pic) this.avatars.set(id, pic);
    } catch { /* keep the id */ }
  }
  private channelName = (id: string): string => this.channels.get(id) ?? id;
  private async warmChannel(id: string): Promise<void> {
    if (this.channels.has(id) || id.startsWith('D')) return;
    try {
      const r = await api<{ channel: { name?: string } }>('conversations.info', { channel: id }, this.config.userToken);
      this.channels.set(id, r.channel.name ?? id);
    } catch { this.channels.set(id, id); }
  }
  private async warmMentions(msgs: SlackMessage[]): Promise<void> {
    const ids = new Set<string>();
    for (const m of msgs) {
      if (m.user) ids.add(m.user);
      for (const x of (m.text ?? '').matchAll(/<@([UW][A-Z0-9]+)/g)) ids.add(x[1]!);
    }
    await Promise.all([...ids].map(id => this.warmUser(id)));
  }

  private async ingest(m: SlackMessage): Promise<void> {
    if (m.user === this.config.userId) { this.myThreads.add(m.thread_ts ?? m.ts); return; }
    // Resolve the names a row shows before it lands, so it never reads as ids.
    await Promise.all([this.warmMentions([m]), this.warmChannel(m.channel)]);
    const item = slackMessageToItem(m, {
      me: this.config.userId, teamUrl: this.config.teamUrl,
      userName: this.userName, channelName: this.channelName, myThreads: this.myThreads,
    });
    if (!item) return;
    // The original connection keeps its ids, so its items stay deduplicated.
    if (this.id !== DEFAULT_CONNECTION) {
      // An item from before projects, moved onto this connection, keeps its
      // old id: it is this same message, not a new one.
      const legacy = getInboxItem(item.id);
      if (legacy && String(legacy.context.connectionId ?? DEFAULT_CONNECTION) === this.id) return;
      item.id = `slack:${this.id}:${m.channel}:${m.ts}`;
    }
    item.context = { ...item.context, connectionId: this.id, ...(m.user && this.avatars.get(m.user) ? { avatar: this.avatars.get(m.user) } : {}) };
    addInboxItem(item);
  }

  /** A message as it happens: windows showing that conversation append it,
   *  and one of the user's own closes the items it answers (they replied from
   *  Slack itself). */
  private async live(m: SlackMessage): Promise<void> {
    if (m.subtype && m.subtype !== 'thread_broadcast' && m.subtype !== 'file_share' && m.subtype !== 'bot_message') return;
    await this.warmMentions([m]);
    broadcast({ type: 'slack_message', connectionId: this.id, channel: m.channel, threadTs: m.thread_ts ?? null, message: this.toThreadMessage(m) });
    if (m.user === this.config.userId) {
      const mine = listOpenInbox(1000).filter(i => connectionOfItem(i) === this.id);
      for (const id of itemsAnsweredBy(mine, m)) markInboxDone(id);
    }
  }

  toThreadMessage(m: SlackMessage): ThreadMessage {
    const raw = m as SlackMessage & {
      username?: string;
      bot_profile?: { name?: string; icons?: { image_72?: string; image_48?: string } };
      icons?: { image_72?: string; image_48?: string };
      reactions?: { name: string; count: number; users?: string[] }[];
    };
    const me = this.config.userId;
    const avatar = m.user ? this.avatars.get(m.user)
      : raw.bot_profile?.icons?.image_72 || raw.bot_profile?.icons?.image_48 || raw.icons?.image_72 || raw.icons?.image_48;
    return {
      ...(avatar ? { avatar } : {}),
      user: m.user ?? '',
      name: m.user ? this.userName(m.user) : raw.bot_profile?.name || raw.username || 'App',
      ts: m.ts, mine: m.user === me, bot: !!m.bot_id,
      root: !!m.thread_ts && m.thread_ts === m.ts,
      text: plainSlackText(m.text ?? '', this.userName),
      markdown: slackToMarkdown(m.text ?? '', this.userName, me),
      reactions: (raw.reactions ?? []).map(r => ({
        name: r.name, count: r.count, mine: !!r.users?.includes(me),
        ...(resolveEmoji(r.name) ?? {}),
      })),
    };
  }

  // ── Socket Mode ───────────────────────────────────────────────────────────
  start(): void {
    this.stopped = false; this.retry = 0;
    this.dropDuplicates();
    void this.connect();
    // A socket can die without a close — the Mac slept, the network changed —
    // and keep reading as connected while nothing arrives. Reconnect after a
    // sleep or a long silence; the fresh `hello` backfills the gap.
    this.lastTick = Date.now();
    this.watchdog ??= setInterval(() => {
      const now = Date.now();
      const slept = now - this.lastTick > 90_000;
      this.lastTick = now;
      if (this.stopped || !this.socket) return;
      if (slept || now - this.lastFrame > SILENCE_MS) this.recycle(slept ? 'woke from sleep' : 'silent');
    }, 30_000);
  }

  /** Drop the socket and open a new one at once. */
  private recycle(why: string): void {
    console.log(`[slack:${this.id}] reconnecting (${why})`);
    const ws = this.socket; this.socket = null;
    try { ws?.close(); } catch { /* already gone */ }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.retry = 0;
    void this.connect();
  }

  /** Items stored twice — under the pre-projects id and again under this
   *  connection's — keep the old one (it carries read state and agents). */
  private dropDuplicates(): void {
    if (this.id === DEFAULT_CONNECTION) return;
    const prefix = `slack:${this.id}:`;
    for (const item of listOpenInbox(1000)) {
      if (!item.id.startsWith(prefix)) continue;
      const legacy = getInboxItem(`slack:${item.id.slice(prefix.length)}`);
      if (legacy && String(legacy.context.connectionId ?? DEFAULT_CONNECTION) === this.id) markInboxDone(item.id);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const ws = this.socket; this.socket = null;
    try { ws?.close(); } catch { /* already closed */ }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setStatus({ state: 'connecting', ...this.who() });
    try {
      const { url } = await api<{ url: string }>('apps.connections.open', {}, this.config.appToken);
      const ws = new WebSocket(url);
      this.socket = ws;
      this.lastFrame = Date.now();
      ws.onmessage = (ev) => {
        if (this.socket !== ws) return;
        this.lastFrame = Date.now();
        let msg: { type?: string; envelope_id?: string; payload?: { event?: SlackMessage & { type?: string } } };
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        // Every envelope is acked at once, or Slack redelivers it.
        if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
        if (msg.type === 'hello') {
          this.retry = 0;
          this.setStatus({ state: 'connected', ...this.who() });
          void this.loadCustomEmoji().then(() => rewriteOpenBodies('slack', emojifyPlain));
          void this.backfill();
        } else if (msg.type === 'events_api' && msg.payload?.event?.type === 'message') {
          void this.ingest(msg.payload.event);
          void this.live(msg.payload.event);
        } else if (msg.type === 'events_api' && /^reaction_(added|removed)$/.test(String(msg.payload?.event?.type))) {
          const ev = msg.payload!.event as unknown as { type: string; user: string; reaction: string; item?: { channel?: string; ts?: string } };
          if (ev.item?.channel && ev.item.ts) {
            broadcast({
              type: 'slack_reaction', connectionId: this.id, channel: ev.item.channel, ts: ev.item.ts,
              name: ev.reaction, added: ev.type === 'reaction_added', mine: ev.user === this.config.userId,
              ...(resolveEmoji(ev.reaction) ?? {}),
            });
          }
        } else if (msg.type === 'disconnect') {
          ws.close();
        }
      };
      ws.onclose = () => { if (this.socket === ws) { this.socket = null; this.scheduleReconnect(); } };
      ws.onerror = () => { /* onclose follows */ };
    } catch (e) {
      const message = (e as Error).message;
      this.setStatus({ state: 'error', error: message, ...this.who() });
      // Bad tokens won't fix themselves; anything else (network) is retried.
      if (!/invalid_auth|not_authed|token_revoked|account_inactive/.test(message)) this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = Math.min(60_000, 1000 * 2 ** this.retry++);
    if (this.status.state === 'connected') this.setStatus({ ...this.status, state: 'connecting' });
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.connect(); }, delay);
  }

  /** The workspace's own emoji. Needs `emoji:read`; an app created from an
   *  older manifest lacks it, and its custom emoji just stay as `:name:`. */
  private async loadCustomEmoji(): Promise<void> {
    try {
      const r = await api<{ emoji: Record<string, string> }>('emoji.list', {}, this.config.userToken);
      setCustomEmoji(r.emoji, this.config.teamUrl || this.id);
    } catch (e) {
      console.log(`[slack:${this.id}] custom emoji unavailable:`, (e as Error).message);
    }
  }

  // ── Backfill: what arrived while the bridge was down ────────────────────
  private async backfill(): Promise<void> {
    const c = this.config;
    const since = Date.now() / 1000 - BACKFILL_DAYS * 86400;
    try {
      // Mentions anywhere the user can see.
      const s = await api<{ messages: { matches: (SlackMessage & { permalink?: string; channel: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean } | string })[] } }>(
        'search.messages', { query: `<@${c.userId}>`, sort: 'timestamp', sort_dir: 'desc', count: 40 }, c.userToken);
      for (const m of s.messages.matches) {
        if (Number(m.ts) < since) continue;
        const ch: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean } =
          typeof m.channel === 'string' ? { id: m.channel } : m.channel;
        if (ch.name) this.channels.set(ch.id, ch.name);
        // Search results omit thread_ts; their permalink still carries it.
        const threadTs = m.thread_ts ?? (m.permalink ? new URL(m.permalink).searchParams.get('thread_ts') ?? undefined : undefined);
        await this.ingest({ ...m, thread_ts: threadTs, channel: ch.id, channel_type: ch.is_im ? 'im' : ch.is_mpim ? 'mpim' : 'channel' });
      }
      // Direct messages after the user's own last word in each conversation.
      const convs = await api<{ channels: { id: string; is_im?: boolean; is_mpim?: boolean }[] }>(
        'users.conversations', { types: 'im,mpim', exclude_archived: true, limit: 100 }, c.userToken);
      for (const conv of convs.channels.slice(0, 40)) {
        const h = await api<{ messages: SlackMessage[] }>('conversations.history', { channel: conv.id, oldest: since, limit: 15 }, c.userToken);
        const lastMine = h.messages.find(m => m.user === c.userId)?.ts;
        for (const m of h.messages) {
          if (lastMine && Number(m.ts) <= Number(lastMine)) continue;
          await this.ingest({ ...m, channel: conv.id, channel_type: conv.is_mpim ? 'mpim' : 'im' });
        }
        await new Promise(r => setTimeout(r, 250));   // stay well inside tier-3 limits
      }
    } catch (e) {
      console.error(`[slack:${this.id}] backfill failed:`, (e as Error).message);
    }
  }

  // ── what the Inbox does with an item ────────────────────────────────────
  /** The conversation around an item: its thread in a channel (the way Slack
   *  opens it), the last few messages in a DM. */
  async thread(channel: string, ts: string, threadTs: string | null, limit = 8): Promise<ThreadMessage[]> {
    const token = this.config.userToken;
    const replies = async (root: string) =>
      (await api<{ messages: SlackMessage[] }>('conversations.replies', { channel, ts: root, limit: 40 }, token)).messages;
    let msgs: SlackMessage[];
    if (channel.startsWith('D') && !threadTs) {
      msgs = (await api<{ messages: SlackMessage[] }>('conversations.history', { channel, latest: ts, inclusive: true, limit }, token)).messages.reverse();
    } else {
      // An item stored without its thread_ts finds it from the message itself.
      msgs = await replies(threadTs ?? ts);
      const root = msgs[0]?.thread_ts;
      if (!threadTs && root && root !== ts) msgs = await replies(root);
    }
    // Authors and everyone mentioned, so no row reads as a raw user id.
    await this.warmMentions(msgs);
    return msgs.map(m => this.toThreadMessage(m));
  }

  /** Add or take back the user's reaction on a message. */
  async react(channel: string, ts: string, name: string, remove: boolean): Promise<void> {
    await api(remove ? 'reactions.remove' : 'reactions.add', { channel, timestamp: ts, name }, this.config.userToken);
  }

  /** The DM with a user (opened if there was none yet). */
  async openDm(user: string): Promise<{ channel: string; name: string; avatar?: string }> {
    const r = await api<{ channel: { id: string } }>('conversations.open', { users: user }, this.config.userToken);
    await this.warmUser(user);
    return { channel: r.channel.id, name: this.userName(user), ...(this.avatars.get(user) ? { avatar: this.avatars.get(user) } : {}) };
  }

  /** Reply as the user: in the thread when there is one, else in the DM. */
  async reply(channel: string, threadTs: string | null, text: string): Promise<void> {
    await api('chat.postMessage', { channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }, this.config.userToken);
    if (threadTs) this.myThreads.add(threadTs);
  }
}

// ── registry ────────────────────────────────────────────────────────────────

const connections = new Map<string, SlackConnection>();

function readConfig(file: string): SlackConfig | null {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as SlackConfig;
    return c.appToken && c.userToken && c.userId ? c : null;
  } catch { return null; }
}
function writeConfig(id: string, c: SlackConfig): void {
  const file = fileOf(id);
  if (id !== DEFAULT_CONNECTION) mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
}

/** Start every saved connection. Called once at boot. */
export function startSlack(): void {
  const legacy = readConfig(LEGACY_FILE);
  if (legacy) connections.set(DEFAULT_CONNECTION, new SlackConnection(DEFAULT_CONNECTION, legacy));
  if (existsSync(DIR)) {
    for (const f of readdirSync(DIR)) {
      if (!f.endsWith('.json')) continue;
      const c = readConfig(join(DIR, f));
      if (c) { const id = f.slice(0, -5); connections.set(id, new SlackConnection(id, c)); }
    }
  }
  for (const c of connections.values()) c.start();
}

/** Every connection's status, keyed by project id (or `default`). */
export function slackStatuses(): Record<string, SlackStatus> {
  return Object.fromEntries([...connections].map(([id, c]) => [id, c.status]));
}

function conn(id: string): SlackConnection {
  const c = connections.get(id);
  if (!c) throw new Error('Slack is not connected for this project');
  return c;
}

/** Validate both tokens, save them for `id`, and connect. */
export async function configureSlack(id: string, appToken: string, userToken: string): Promise<SlackStatus> {
  appToken = appToken.trim(); userToken = userToken.trim();
  if (!appToken.startsWith('xapp-')) throw new Error('The app-level token starts with xapp-');
  if (!userToken.startsWith('xoxp-')) throw new Error('The user token starts with xoxp-');
  for (const [other, c] of connections) {
    if (other !== id && c.config.appToken === appToken) {
      throw new Error('That Slack app is already connected to another project. Create a separate app for this one — Slack splits events between connections that share an app.');
    }
  }
  const who = await api<{ user_id: string; user: string; team: string; url: string }>('auth.test', {}, userToken);
  await api('apps.connections.open', {}, appToken);   // proves the app token and Socket Mode
  const next: SlackConfig = { appToken, userToken, userId: who.user_id, userName: who.user, teamName: who.team, teamUrl: who.url };
  writeConfig(id, next);
  connections.get(id)?.stop();
  const c = new SlackConnection(id, next);
  connections.set(id, c);
  c.start();
  return c.status;
}

export function disconnectSlack(id: string): void {
  connections.get(id)?.stop();
  connections.delete(id);
  const file = fileOf(id);
  if (existsSync(file)) rmSync(file);
  broadcast({ type: 'slack_status', id, status: { state: 'off' } });
}

/** Move a connection to another id — the pre-projects `default` connection
 *  into a project. Its open items follow it. */
export function moveSlackConnection(from: string, to: string): SlackStatus {
  const c = conn(from);
  if (connections.has(to)) throw new Error('That project already has a Slack connection');
  c.stop();
  const file = fileOf(from);
  if (to !== DEFAULT_CONNECTION) mkdirSync(DIR, { recursive: true, mode: 0o700 });
  renameSync(file, fileOf(to));
  connections.delete(from);
  broadcast({ type: 'slack_status', id: from, status: { state: 'off' } });
  retagConnection(from, to, DEFAULT_CONNECTION);
  const moved = new SlackConnection(to, c.config);
  connections.set(to, moved);
  moved.start();
  return moved.status;
}

export function slackThread(id: string, channel: string, ts: string, threadTs: string | null, limit?: number): Promise<ThreadMessage[]> {
  return conn(id).thread(channel, ts, threadTs, limit);
}
export function slackReact(id: string, channel: string, ts: string, name: string, remove: boolean): Promise<void> {
  return conn(id).react(channel, ts, name, remove);
}
export function slackOpenDm(id: string, user: string) { return conn(id).openDm(user); }
export function slackReply(id: string, channel: string, threadTs: string | null, text: string): Promise<void> {
  return conn(id).reply(channel, threadTs, text);
}
export function connectionOf(item: InboxItem): string { return connectionOfItem(item); }

/** The Slack app to create, as a manifest the user pastes at api.slack.com. */
export const SLACK_MANIFEST = `display_information:
  name: Codiby Inbox
  description: Mentions, DMs and thread replies in your Codiby Inbox
features:
  bot_user:
    display_name: Codiby Inbox
oauth_config:
  scopes:
    bot:
      - users:read
    user:
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - channels:read
      - groups:read
      - im:read
      - mpim:read
      - users:read
      - search:read
      - chat:write
      - emoji:read
      - reactions:read
      - reactions:write
      - im:write
settings:
  event_subscriptions:
    user_events:
      - message.channels
      - message.groups
      - message.im
      - message.mpim
      - reaction_added
      - reaction_removed
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
`;
