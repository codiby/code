/**
 * Slack → Inbox, in real time.
 *
 * Socket Mode: the bridge opens an *outbound* WebSocket to Slack and Slack
 * pushes events down it — no public URL, no relay, no open port. The app is
 * the user's own, subscribed to message events "on behalf of users", so it
 * sees what the user sees. On every (re)connect a backfill catches what
 * arrived while the bridge was down; ids make both paths idempotent.
 *
 * Two tokens, kept in ~/.codiby/slack.json (0600) and never in the synced
 * preferences: the app-level token (xapp-, connections:write) opens the
 * socket; the user token (xoxp-) reads names and threads, searches, and
 * replies as the user.
 */

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CODIBY_DIR } from '../config/config';
import { addInboxItem } from './store';
import { resolveEmoji, setCustomEmoji } from './emoji';
import { plainSlackText, slackMessageToItem, slackToMarkdown, type SlackMessage } from './slack-events';

const CONFIG_FILE = join(CODIBY_DIR, 'slack.json');
const API = 'https://slack.com/api';

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

let config: SlackConfig | null = null;
let socket: WebSocket | null = null;
let status: SlackStatus = { state: 'off' };
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;
let broadcast: (msg: Record<string, unknown>) => void = () => {};

const users = new Map<string, string>();
const channels = new Map<string, string>();
/** Thread roots the user has written in, learned live and from the backfill. */
const myThreads = new Set<string>();

export function setSlackBroadcaster(fn: (msg: Record<string, unknown>) => void): void { broadcast = fn; }

function setStatus(next: SlackStatus): void {
  status = next;
  broadcast({ type: 'slack_status', status });
}

export function getSlackStatus(): SlackStatus { return status; }

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

// ── names, cached; the first sighting of an id falls back to the id ─────────

function userName(id: string): string {
  if (!users.has(id) && config) {
    users.set(id, id);
    void api<{ user: { real_name?: string; name?: string; profile?: { display_name?: string; real_name?: string } } }>('users.info', { user: id }, config.userToken)
      .then(r => users.set(id, r.user.profile?.real_name || r.user.real_name || r.user.profile?.display_name || r.user.name || id))
      .catch(() => {});
  }
  return users.get(id) ?? id;
}
async function warmUser(id: string | undefined): Promise<void> {
  if (!id || !config || (users.has(id) && users.get(id) !== id)) return;
  try {
    const r = await api<{ user: { real_name?: string; name?: string; profile?: { real_name?: string; display_name?: string } } }>('users.info', { user: id }, config.userToken);
    users.set(id, r.user.profile?.real_name || r.user.real_name || r.user.profile?.display_name || r.user.name || id);
  } catch { /* keep the id */ }
}
function channelName(id: string): string { return channels.get(id) ?? id; }
async function warmChannel(id: string): Promise<void> {
  if (!config || channels.has(id) || id.startsWith('D')) return;
  try {
    const r = await api<{ channel: { name?: string } }>('conversations.info', { channel: id }, config.userToken);
    channels.set(id, r.channel.name ?? id);
  } catch { channels.set(id, id); }
}

async function ingest(m: SlackMessage): Promise<void> {
  if (!config) return;
  if (m.user === config.userId) { myThreads.add(m.thread_ts ?? m.ts); return; }
  // Resolve the names a row shows before it lands, so it never reads as ids.
  await Promise.all([warmUser(m.user), warmChannel(m.channel), ...[...(m.text ?? '').matchAll(/<@([UW][A-Z0-9]+)/g)].map(x => warmUser(x[1]))]);
  const item = slackMessageToItem(m, {
    me: config.userId, teamUrl: config.teamUrl, userName, channelName, myThreads,
  });
  if (item) addInboxItem(item);
}

// ── Socket Mode ─────────────────────────────────────────────────────────────

async function connect(): Promise<void> {
  if (!config || stopped) return;
  setStatus({ state: 'connecting', user: config.userName, team: config.teamName, teamUrl: config.teamUrl });
  try {
    const { url } = await api<{ url: string }>('apps.connections.open', {}, config.appToken);
    const ws = new WebSocket(url);
    socket = ws;
    ws.onmessage = (ev) => {
      let msg: { type?: string; envelope_id?: string; payload?: { event?: SlackMessage & { type?: string } } };
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      // Every envelope is acked at once, or Slack redelivers it.
      if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
      if (msg.type === 'hello') {
        retry = 0;
        setStatus({ state: 'connected', user: config!.userName, team: config!.teamName, teamUrl: config!.teamUrl });
        void loadCustomEmoji();
        void backfill();
      } else if (msg.type === 'events_api' && msg.payload?.event?.type === 'message') {
        void ingest(msg.payload.event);
      } else if (msg.type === 'disconnect') {
        ws.close();
      }
    };
    ws.onclose = () => { if (socket === ws) { socket = null; scheduleReconnect(); } };
    ws.onerror = () => { /* onclose follows */ };
  } catch (e) {
    const message = (e as Error).message;
    setStatus({ state: 'error', error: message, user: config.userName, team: config.teamName });
    // Bad tokens won't fix themselves; anything else (network) is retried.
    if (!/invalid_auth|not_authed|token_revoked|account_inactive/.test(message)) scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (stopped || retryTimer) return;
  const delay = Math.min(60_000, 1000 * 2 ** retry++);
  if (status.state === 'connected') setStatus({ ...status, state: 'connecting' });
  retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, delay);
}

/** The workspace's own emoji. Needs `emoji:read`; an app created from an
 *  older manifest lacks it, and its custom emoji just stay as `:name:`. */
async function loadCustomEmoji(): Promise<void> {
  if (!config) return;
  try {
    const r = await api<{ emoji: Record<string, string> }>('emoji.list', {}, config.userToken);
    setCustomEmoji(r.emoji);
  } catch (e) {
    console.log('[slack] custom emoji unavailable:', (e as Error).message);
  }
}

// ── Backfill: what arrived while the bridge was down ──────────────────────

const BACKFILL_DAYS = 3;
async function backfill(): Promise<void> {
  if (!config) return;
  const since = Date.now() / 1000 - BACKFILL_DAYS * 86400;
  try {
    // Mentions anywhere the user can see.
    const s = await api<{ messages: { matches: (SlackMessage & { channel: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean } | string })[] } }>(
      'search.messages', { query: `<@${config.userId}>`, sort: 'timestamp', sort_dir: 'desc', count: 40 }, config.userToken);
    for (const m of s.messages.matches) {
      if (Number(m.ts) < since) continue;
      const ch: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean } =
        typeof m.channel === 'string' ? { id: m.channel } : m.channel;
      if (ch.name) channels.set(ch.id, ch.name);
      await ingest({ ...m, channel: ch.id, channel_type: ch.is_im ? 'im' : ch.is_mpim ? 'mpim' : 'channel' });
    }
    // Direct messages after the user's own last word in each conversation.
    const convs = await api<{ channels: { id: string; is_im?: boolean; is_mpim?: boolean }[] }>(
      'users.conversations', { types: 'im,mpim', exclude_archived: true, limit: 100 }, config.userToken);
    for (const c of convs.channels.slice(0, 40)) {
      const h = await api<{ messages: SlackMessage[] }>('conversations.history', { channel: c.id, oldest: since, limit: 15 }, config.userToken);
      const lastMine = h.messages.find(m => m.user === config!.userId)?.ts;
      for (const m of h.messages) {
        if (lastMine && Number(m.ts) <= Number(lastMine)) continue;
        await ingest({ ...m, channel: c.id, channel_type: c.is_mpim ? 'mpim' : 'im' });
      }
      await new Promise(r => setTimeout(r, 250));   // stay well inside tier-3 limits
    }
  } catch (e) {
    console.error('[slack] backfill failed:', (e as Error).message);
  }
}

// ── lifecycle ───────────────────────────────────────────────────────────────

function loadConfig(): SlackConfig | null {
  try {
    const c = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as SlackConfig;
    return c.appToken && c.userToken && c.userId ? c : null;
  } catch { return null; }
}

/** Start from the saved config, if any. Called once at boot. */
export function startSlack(): void {
  config = loadConfig();
  if (!config) { setStatus({ state: 'off' }); return; }
  stopped = false;
  void connect();
}

export function stopSlack(): void {
  stopped = true;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  const ws = socket; socket = null;
  try { ws?.close(); } catch { /* already closed */ }
}

/** Validate both tokens, save them, and connect. */
export async function configureSlack(appToken: string, userToken: string): Promise<SlackStatus> {
  appToken = appToken.trim(); userToken = userToken.trim();
  if (!appToken.startsWith('xapp-')) throw new Error('The app-level token starts with xapp-');
  if (!userToken.startsWith('xoxp-')) throw new Error('The user token starts with xoxp-');
  const who = await api<{ user_id: string; user: string; team: string; url: string }>('auth.test', {}, userToken);
  await api('apps.connections.open', {}, appToken);   // proves the app token and Socket Mode
  const next: SlackConfig = { appToken, userToken, userId: who.user_id, userName: who.user, teamName: who.team, teamUrl: who.url };
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { chmodSync(CONFIG_FILE, 0o600); } catch { /* best effort */ }
  stopSlack();
  config = next;
  stopped = false;
  retry = 0;
  void connect();
  return { state: 'connecting', user: next.userName, team: next.teamName, teamUrl: next.teamUrl };
}

export function disconnectSlack(): void {
  stopSlack();
  config = null;
  if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE);
  setStatus({ state: 'off' });
}

// ── what the Inbox does with a Slack item ──────────────────────────────────

export interface Reaction { name: string; count: number; mine: boolean; unicode?: string; url?: string }
export interface ThreadMessage { user: string; name: string; text: string; markdown: string; ts: string; mine: boolean; bot: boolean; reactions: Reaction[] }

/** The conversation around an item: the thread, or the last few messages of
 *  a DM. */
export async function slackThread(channel: string, ts: string, threadTs: string | null): Promise<ThreadMessage[]> {
  if (!config) throw new Error('Slack is not connected');
  const c = config;
  const msgs = threadTs
    ? (await api<{ messages: SlackMessage[] }>('conversations.replies', { channel, ts: threadTs, limit: 40 }, c.userToken)).messages
    : (await api<{ messages: SlackMessage[] }>('conversations.history', { channel, latest: ts, inclusive: true, limit: 8 }, c.userToken)).messages.reverse();
  // Authors and everyone mentioned, so no row reads as a raw user id.
  const ids = new Set<string>();
  for (const m of msgs) {
    if (m.user) ids.add(m.user);
    for (const x of (m.text ?? '').matchAll(/<@([UW][A-Z0-9]+)/g)) ids.add(x[1]!);
  }
  await Promise.all([...ids].map(id => warmUser(id)));
  return msgs.map(m => {
    const raw = m as SlackMessage & { username?: string; bot_profile?: { name?: string }; reactions?: { name: string; count: number; users?: string[] }[] };
    return {
      user: m.user ?? '',
      name: m.user ? userName(m.user) : raw.bot_profile?.name || raw.username || 'App',
      ts: m.ts, mine: m.user === c.userId, bot: !!m.bot_id,
      text: plainSlackText(m.text ?? '', userName),
      markdown: slackToMarkdown(m.text ?? '', userName),
      reactions: (raw.reactions ?? []).map(r => ({
        name: r.name, count: r.count, mine: !!r.users?.includes(c.userId),
        ...(resolveEmoji(r.name) ?? {}),
      })),
    };
  });
}

/** Reply as the user: in the thread when there is one, else in the DM. */
export async function slackReply(channel: string, threadTs: string | null, text: string): Promise<void> {
  if (!config) throw new Error('Slack is not connected');
  await api('chat.postMessage', { channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }, config.userToken);
  if (threadTs) myThreads.add(threadTs);
}

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
settings:
  event_subscriptions:
    user_events:
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
`;
