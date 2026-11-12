/**
 * Agent view → Channels: where the agent can be reached (Telegram, WhatsApp
 * via wacli, HTTP webhook, iOS Shortcut), Telegram pairing, the preferred
 * channel for proactive messages, and the inbox of messages from other
 * people (untrusted — the agent never takes orders from them).
 *
 * Telegram bot tokens are write-only. Webhook tokens are shown only when
 * the owner explicitly reveals or rotates them.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  Check, ChevronDown, ChevronRight, Copy, Eye, Globe, Inbox, KeyRound, Loader2, MessageCircle, Plus, RefreshCw, Send, Smartphone, Trash2, Webhook,
} from 'lucide-react';
import { agentCore, type AgentChannelMessage } from '../../lib/agent/api';
import {
  CHANNEL_LABELS,
  channelsApi,
  curlExample,
  lidMapToText,
  parseOwnerNumbers,
  type ChannelKind,
  type ChannelPatch,
  type ChannelView,
  type ChannelsOverview,
  type TelegramView,
  type WebhookView,
  type WhatsAppView,
} from '../../lib/agent/channels';
import { Button, Card, EmptyNote, ErrorNote, Field, INPUT_BASE_CLASS, INPUT_CLASS, LABEL_CLASS, Pill, Section, Spinner, Toggle, relativeTime, usePolled, type AgentSectionProps } from './ui';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
type Api = AgentSectionProps['api'];

const ICONS: Record<ChannelKind, ReactNode> = {
  telegram: <Send size={14} className="text-sky-300" />,
  whatsapp: <MessageCircle size={14} className="text-green-300" />,
  http_webhook: <Webhook size={14} className="text-indigo-300" />,
  ios_shortcut: <Smartphone size={14} className="text-zinc-300" />,
};

export function ChannelsSection({ api, refreshKey }: AgentSectionProps) {
  const overview = usePolled(() => channelsApi.overview(api), [api, refreshKey], 5000);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const data = overview.data;

  if (overview.loading && !data) return <Spinner />;
  if (!data) return <ErrorNote message={`Couldn't load channels: ${overview.error ?? 'unknown error'}`} onRetry={() => void overview.reload()} />;

  const replace = (next: ChannelView | null, removedId?: string) => {
    overview.setData(prev => {
      if (!prev) return prev;
      const channels = removedId
        ? prev.channels.filter(c => c.id !== removedId)
        : next
          ? (prev.channels.some(c => c.id === next.id) ? prev.channels.map(c => (c.id === next.id ? next : c)) : [...prev.channels, next])
          : prev.channels;
      return { ...prev, channels };
    });
  };

  return (
    <>
      <Section
        title="Channels"
        hint="Where you can talk to the agent. Only you (paired chats, your numbers, holders of a webhook token) can give it orders."
        action={<AddChannel api={api} onCreated={ch => { replace(ch); setExpanded(ch.id); }} onError={setError} />}
      >
        {!data.agentEnabled && (
          <div className="mb-2.5 px-3 py-2 rounded-md border border-border bg-surface-light text-[11.5px] text-zinc-400">
            The agent is off on this host. You can set channels up now; they start when you turn the agent on in Overview.
          </div>
        )}
        {error && <div className="mb-2.5"><ErrorNote message={error} /></div>}
        {data.channels.length === 0 ? (
          <EmptyNote>No channels yet. Add Telegram or WhatsApp to talk to the agent from your phone.</EmptyNote>
        ) : (
          <div className="space-y-2">
            {data.channels.map(ch => (
              <ChannelCard
                key={ch.id}
                api={api}
                ch={ch}
                baseUrls={data.baseUrls}
                open={expanded === ch.id}
                onToggleOpen={() => setExpanded(expanded === ch.id ? null : ch.id)}
                onChanged={next => replace(next)}
                onRemoved={() => replace(null, ch.id)}
                onError={setError}
              />
            ))}
          </div>
        )}
      </Section>

      <DeliverySettings api={api} data={data} onChanged={() => void overview.reload()} onError={setError} />
      <OthersInbox api={api} refreshKey={refreshKey} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

function AddChannel({ api, onCreated, onError }: { api: Api; onCreated: (ch: ChannelView) => void; onError: (m: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [telegram, setTelegram] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async (type: ChannelKind, patch: ChannelPatch = {}) => {
    setBusy(true);
    onError(null);
    try {
      onCreated(await channelsApi.create(api, type, patch));
      setOpen(false);
      setTelegram(false);
      setToken('');
    } catch (err) {
      onError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (telegram) {
    return (
      <form className="flex items-center gap-2" onSubmit={e => { e.preventDefault(); void create('telegram', { botToken: token.trim() }); }}>
        <input
          autoFocus
          type="password"
          value={token}
          onChange={e => setToken(e.target.value)}
          placeholder="Bot token from @BotFather"
          aria-label="Telegram bot token"
          className={`${INPUT_BASE_CLASS} w-[260px] font-mono`}
        />
        <Button type="submit" tone="primary" disabled={busy || !token.trim()}>{busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Add</Button>
        <Button onClick={() => setTelegram(false)}>Cancel</Button>
      </form>
    );
  }

  return (
    <div className="relative">
      <Button tone="primary" onClick={() => setOpen(v => !v)} disabled={busy}><Plus size={12} /> Add channel</Button>
      {open && (
        <div className="absolute right-0 top-[32px] z-20 w-[220px] bg-surface border border-border rounded-lg shadow-xl py-1">
          {(['telegram', 'whatsapp', 'http_webhook', 'ios_shortcut'] as ChannelKind[]).map(type => (
            <button
              key={type}
              type="button"
              disabled={busy}
              onClick={() => (type === 'telegram' ? (setTelegram(true), setOpen(false)) : void create(type))}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-zinc-300 hover:bg-surface-light text-left"
            >
              {ICONS[type]} {CHANNEL_LABELS[type]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface CardProps {
  api: Api;
  ch: ChannelView;
  baseUrls: string[];
  open: boolean;
  onToggleOpen: () => void;
  onChanged: (next: ChannelView) => void;
  onRemoved: () => void;
  onError: (m: string | null) => void;
}

function statusPill(ch: ChannelView) {
  if (!ch.enabled) return <Pill>Disabled</Pill>;
  if (ch.status.connected) return <Pill tone="green">Connected</Pill>;
  if (!ch.running) return <Pill tone="zinc">Stopped</Pill>;
  return <Pill tone={ch.status.lastError ? 'red' : 'amber'}>Offline</Pill>;
}

function ChannelCard({ api, ch, baseUrls, open, onToggleOpen, onChanged, onRemoved, onError }: CardProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    onError(null);
    setNote(null);
    try { await fn(); } catch (err) { onError(errorText(err)); } finally { setBusy(null); }
  };

  const save = (patch: ChannelPatch) => act('save', async () => { onChanged(await channelsApi.update(api, ch.id, patch)); });

  return (
    <Card>
      <div className="flex items-center gap-3">
        <button type="button" onClick={onToggleOpen} aria-label={open ? 'Collapse' : 'Expand'} className="text-zinc-500 hover:text-zinc-200">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="w-7 h-7 rounded-md bg-surface-light border border-border grid place-items-center shrink-0">{ICONS[ch.type]}</div>
        <button type="button" onClick={onToggleOpen} className="flex-1 min-w-0 text-left">
          <div className="text-[13px] font-semibold text-zinc-100 flex items-center gap-2 flex-wrap min-w-0">
            <span className="truncate max-w-full">{ch.name}</span>
            {/* Only when renamed — "Telegram TELEGRAM" just repeats itself. */}
            {ch.name.trim().toLowerCase() !== CHANNEL_LABELS[ch.type].toLowerCase() && <Pill tone="indigo">{CHANNEL_LABELS[ch.type]}</Pill>}
            {statusPill(ch)}
            {ch.type === 'telegram' && ch.telegram.pendingPairings.length > 0 && <Pill tone="amber">{ch.telegram.pendingPairings.length} pairing request{ch.telegram.pendingPairings.length === 1 ? '' : 's'}</Pill>}
          </div>
          <div className="text-[11.5px] text-zinc-500 mt-0.5 truncate">{ch.status.detail || '—'}</div>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            onClick={() => void act('test', async () => {
              const res = await channelsApi.test(api, ch.id);
              setNote(res.ok ? 'Test message sent.' : `Not delivered: ${res.error ?? 'unknown error'}`);
            })}
            disabled={!!busy || !ch.running}
            title={ch.running ? 'Send a test message to yourself on this channel' : 'The channel is not running'}
          >
            {busy === 'test' ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Test
          </Button>
          <Toggle on={ch.enabled} label={ch.enabled ? 'Disable channel' : 'Enable channel'} disabled={!!busy} onClick={() => void save({ enabled: !ch.enabled })} />
        </div>
      </div>

      {ch.status.lastError && <div className="mt-2.5"><ErrorNote message={ch.status.lastError} /></div>}
      {note && <div className="mt-2 text-[11.5px] text-zinc-400">{note}</div>}

      {open && (
        <div className="mt-3 pt-3 border-t border-border">
          <NameField ch={ch} disabled={!!busy} onSave={name => void save({ name })} />
          {ch.type === 'telegram' && <TelegramBody api={api} ch={ch} busy={!!busy} act={act} save={save} onChanged={onChanged} />}
          {ch.type === 'whatsapp' && <WhatsAppBody api={api} ch={ch} busy={!!busy} act={act} save={save} setNote={setNote} />}
          {(ch.type === 'http_webhook' || ch.type === 'ios_shortcut') && <WebhookBody api={api} ch={ch} baseUrls={baseUrls} busy={!!busy} act={act} save={save} />}
          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border">
            <Button onClick={() => void act('restart', async () => { onChanged(await channelsApi.restart(api, ch.id)); })} disabled={!!busy || !ch.enabled}>
              <RefreshCw size={12} /> Restart
            </Button>
            <div className="flex-1" />
            {confirmRemove ? (
              <>
                <span className="text-[11.5px] text-zinc-400">Remove {ch.name} and its secrets?</span>
                <Button tone="danger" disabled={!!busy} onClick={() => void act('remove', async () => { await channelsApi.remove(api, ch.id); onRemoved(); })}>Remove</Button>
                <Button onClick={() => setConfirmRemove(false)}>Cancel</Button>
              </>
            ) : (
              <Button tone="danger" onClick={() => setConfirmRemove(true)} disabled={!!busy}><Trash2 size={12} /> Remove</Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function NameField({ ch, disabled, onSave }: { ch: ChannelView; disabled: boolean; onSave: (name: string) => void }) {
  const [name, setName] = useState(ch.name);
  useEffect(() => { setName(ch.name); }, [ch.name]);
  return (
    <Field label="Name">
      <div className="flex gap-2">
        <input className={INPUT_CLASS} value={name} maxLength={80} onChange={e => setName(e.target.value)} aria-label="Channel name" />
        <Button onClick={() => onSave(name.trim())} disabled={disabled || !name.trim() || name.trim() === ch.name}>Rename</Button>
      </div>
    </Field>
  );
}

type Act = (id: string, fn: () => Promise<void>) => Promise<void>;

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

function TelegramBody({ api, ch, busy, act, save, onChanged }: {
  api: Api; ch: TelegramView; busy: boolean; act: Act; save: (p: ChannelPatch) => Promise<void>; onChanged: (c: ChannelView) => void;
}) {
  const [token, setToken] = useState('');
  const t = ch.telegram;
  const reload = async () => {
    const all = await channelsApi.overview(api);
    const next = all.channels.find(c => c.id === ch.id);
    if (next) onChanged(next);
  };

  return (
    <>
      <Field label="Bot token" hint={t.hasToken ? 'Saved and encrypted on the agent\'s host. Paste a new token to replace it.' : 'Create a bot with @BotFather and paste its token.'}>
        <div className="flex gap-2">
          <input
            type="password"
            className={`${INPUT_CLASS} font-mono`}
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder={t.hasToken ? '•••••••• (saved)' : '123456:ABC-DEF…'}
            aria-label="Bot token"
          />
          <Button onClick={() => void save({ botToken: token.trim() }).then(() => setToken(''))} disabled={busy || !token.trim()}>Save token</Button>
        </div>
      </Field>

      <div className="mb-3">
        <span className={LABEL_CLASS}>Pairing requests</span>
        <p className="text-[11px] text-zinc-500 mb-2">
          Open {t.botUsername ? <span className="text-zinc-300">@{t.botUsername}</span> : 'your bot'} in Telegram and send /start. Approve the request below if the code matches the one the bot showed you.
        </p>
        {t.pendingPairings.length === 0 ? (
          <div className="text-[11.5px] text-zinc-600">No pending requests.</div>
        ) : (
          <div className="space-y-1.5">
            {t.pendingPairings.map(p => (
              <div key={p.chatId} className="flex items-center gap-3 px-2.5 py-2 rounded-md border border-amber-500/30 bg-amber-500/5">
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-zinc-200 truncate">{p.title}{p.username ? <span className="text-zinc-500"> · @{p.username}</span> : null}</div>
                  <div className="text-[11px] text-zinc-500">Chat {p.chatId} · {relativeTime(p.requestedAt)}</div>
                </div>
                <span className="font-mono text-[14px] tracking-[0.2em] text-amber-200">{p.code}</span>
                <Button tone="primary" disabled={busy} onClick={() => void act('pair', async () => { await channelsApi.answerPairing(api, ch.id, p.chatId, true); await reload(); })}>
                  <Check size={12} /> Approve
                </Button>
                <Button disabled={busy} onClick={() => void act('pair', async () => { await channelsApi.answerPairing(api, ch.id, p.chatId, false); await reload(); })}>Reject</Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <span className={LABEL_CLASS}>Paired chats</span>
        {t.pairedChats.length === 0 ? (
          <div className="text-[11.5px] text-zinc-600">None yet — the bot answers nobody until you pair a chat.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {t.pairedChats.map(id => (
              <span key={id} className="inline-flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded-md border border-border bg-surface-light text-[11.5px] text-zinc-300 font-mono">
                {id}
                <button
                  type="button"
                  disabled={busy}
                  title="Unpair this chat"
                  aria-label={`Unpair chat ${id}`}
                  onClick={() => void act('unpair', async () => { await channelsApi.unpair(api, ch.id, id); await reload(); })}
                  className="text-zinc-500 hover:text-red-300 px-1"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

function WhatsAppBody({ api, ch, busy, act, save, setNote }: {
  api: Api; ch: WhatsAppView; busy: boolean; act: Act; save: (p: ChannelPatch) => Promise<void>; setNote: (m: string | null) => void;
}) {
  const w = ch.whatsapp;
  const [binary, setBinary] = useState(w.binary);
  const [account, setAccount] = useState(w.account);
  const [inboundBaseUrl, setInboundBaseUrl] = useState(w.inboundBaseUrl);
  const [owners, setOwners] = useState(w.ownerJids.join('\n'));
  const [lidMap, setLidMap] = useState(lidMapToText(w.lidMap));

  useEffect(() => {
    setBinary(w.binary);
    setAccount(w.account);
    setInboundBaseUrl(w.inboundBaseUrl);
    setLidMap(lidMapToText(w.lidMap));
  }, [w.binary, w.account, w.inboundBaseUrl, w.lidMap]);
  useEffect(() => { setOwners(w.ownerJids.join('\n')); }, [w.ownerJids.join('\n')]);

  const saveAll = () => act('save', async () => {
    const jids = parseOwnerNumbers(owners);
    if (jids.join('\n') !== w.ownerJids.join('\n')) {
      const cfg = await agentCore.config(api);
      await agentCore.saveConfig(api, { owner: { ...cfg.owner, whatsappJids: jids } });
    }
    await save({ binary: binary.trim(), account: account.trim(), inboundBaseUrl: inboundBaseUrl.trim(), lidMap });
  });

  return (
    <>
      <div className="grid grid-cols-2 gap-x-3">
        <Field label="wacli binary">
          <input className={`${INPUT_CLASS} font-mono`} value={binary} onChange={e => setBinary(e.target.value)} aria-label="wacli binary" />
        </Field>
        <Field label="Account" hint="wacli account (-a). Empty = wacli's default.">
          <input className={`${INPUT_CLASS} font-mono`} value={account} onChange={e => setAccount(e.target.value)} placeholder="codiby" aria-label="wacli account" />
        </Field>
      </div>
      <Field label="Your numbers" hint="Messages from these numbers, in a direct chat, are orders. One per line, with country code.">
        <textarea className={`${INPUT_CLASS} font-mono h-[54px] resize-y`} value={owners} onChange={e => setOwners(e.target.value)} placeholder="5215512345678" aria-label="Owner WhatsApp numbers" />
      </Field>
      <Field label="Inbound base URL" hint={`Where the wacli backend reaches this bridge. Empty = http://127.0.0.1:<port>. Webhook: ${w.inboundUrl}`}>
        <input className={`${INPUT_CLASS} font-mono`} value={inboundBaseUrl} onChange={e => setInboundBaseUrl(e.target.value)} placeholder="http://host.docker.internal:3111" aria-label="Inbound base URL" />
      </Field>
      <Field label="LID map" hint="Chats wacli reports as …@lid, mapped to a phone JID it can reply to. One lid=phone per line.">
        <textarea className={`${INPUT_CLASS} font-mono h-[54px] resize-y`} value={lidMap} onChange={e => setLidMap(e.target.value)} placeholder="49822258225348@lid=5215512345678@s.whatsapp.net" aria-label="LID map" />
      </Field>
      <div className="flex justify-end mb-3">
        <Button tone="primary" onClick={() => void saveAll()} disabled={busy}>Save</Button>
      </div>

      <div className="space-y-2 mb-3">
        <ToggleRow label="Keep direct messages from other people" hint="Stored as untrusted in the inbox below; the agent can summarise them but never obeys them." on={w.storeDirect} disabled={busy} onClick={() => void save({ storeDirect: !w.storeDirect })} />
        <ToggleRow label="Keep group messages" hint="Groups are noisy; off by default." on={w.storeGroups} disabled={busy} onClick={() => void save({ storeGroups: !w.storeGroups })} />
        <ToggleRow label="Tell me when someone else writes" hint="A short low-priority note on your preferred channel (at most once per person every 10 minutes)." on={ch.notifyOnOthers} disabled={busy} onClick={() => void save({ notifyOnOthers: !ch.notifyOnOthers })} />
        <ToggleRow label="Download media" hint="Images, voice notes (transcribed) and documents you send, fetched from the wacli backend." on={w.downloadMedia} disabled={busy} onClick={() => void save({ downloadMedia: !w.downloadMedia })} />
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-[12px] text-zinc-300">Read receipts</div>
            <div className="text-[11px] text-zinc-500">Blue ticks after the agent picks a message up.</div>
          </div>
          <select
            aria-label="Read receipts"
            value={w.markRead}
            disabled={busy}
            onChange={e => void save({ markRead: e.target.value as WhatsAppView['whatsapp']['markRead'] })}
            className={`${INPUT_BASE_CLASS} shrink-0 max-w-[260px]`}
          >
            <option value="owner">Only my messages</option>
            <option value="all">Everyone's</option>
            <option value="off">Never</option>
          </select>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Button onClick={() => void act('register', async () => {
          const res = await channelsApi.registerWebhook(api, ch.id);
          setNote(res.action === 'unchanged' ? 'The wacli webhook is already registered.' : `Webhook ${res.action}: ${res.url}`);
        })} disabled={busy}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Globe size={12} />} Register webhook
        </Button>
        <Button onClick={() => void act('status', async () => {
          const st = await channelsApi.whatsappStatus(api, ch.id);
          setNote(st.error && !st.state ? st.error : `wacli: ${st.state ?? 'unknown'}${st.user ? ` · ${st.user}` : ''}`);
        })} disabled={busy}>
          <RefreshCw size={12} /> Check wacli status
        </Button>
      </div>
    </>
  );
}

function ToggleRow({ label, hint, on, disabled, onClick }: { label: string; hint: string; on: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-zinc-300">{label}</div>
        <div className="text-[11px] text-zinc-500">{hint}</div>
      </div>
      <Toggle on={on} label={label} disabled={disabled} onClick={onClick} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Webhook / iOS Shortcut
// ---------------------------------------------------------------------------

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
      {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : label}
    </Button>
  );
}

function WebhookBody({ api, ch, baseUrls, busy, act, save }: {
  api: Api; ch: WebhookView; baseUrls: string[]; busy: boolean; act: Act; save: (p: ChannelPatch) => Promise<void>;
}) {
  const h = ch.webhook;
  const [base, setBase] = useState(baseUrls[0] ?? '');
  const [token, setToken] = useState<string | null>(null);
  const [signing, setSigning] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState(h.callbackUrl);
  const [timeout, setTimeoutSec] = useState(String(h.replyTimeoutSec));
  useEffect(() => { setCallbackUrl(h.callbackUrl); setTimeoutSec(String(h.replyTimeoutSec)); }, [h.callbackUrl, h.replyTimeoutSec]);

  const url = `${base.replace(/\/+$/, '')}${h.inboundPath}`;
  const shortcut = ch.type === 'ios_shortcut';

  return (
    <>
      <Field label="URL" hint="POST JSON {text, images?, sender?} here. Pick the address your caller can reach.">
        <div className="flex gap-2">
          <select aria-label="Base URL" value={base} onChange={e => setBase(e.target.value)} className={`${INPUT_BASE_CLASS} max-w-[45%] shrink-0 truncate`}>
            {baseUrls.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
          <input readOnly className={`${INPUT_CLASS} font-mono`} value={url} aria-label="Webhook URL" />
          <CopyButton text={url} />
        </div>
      </Field>

      <Field label="Token" hint="Send it as X-Codiby-Token or Authorization: Bearer. Anyone holding it can give the agent orders.">
        <div className="flex gap-2">
          <input readOnly className={`${INPUT_CLASS} font-mono`} value={token ?? '••••••••••••••••'} aria-label="Webhook token" />
          {token ? <CopyButton text={token} /> : (
            <Button disabled={busy} onClick={() => void act('reveal', async () => { setToken((await channelsApi.secret(api, ch.id, 'reveal')).secret); })}>
              <Eye size={12} /> Reveal
            </Button>
          )}
          <Button disabled={busy} title="Issue a new token; the old one stops working" onClick={() => void act('rotate', async () => { setToken((await channelsApi.secret(api, ch.id, 'rotate')).secret); })}>
            <KeyRound size={12} /> Rotate
          </Button>
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-x-3">
        <Field label="Replies">
          <select
            aria-label="Reply mode"
            value={h.reply}
            disabled={busy}
            onChange={e => void save({ reply: e.target.value as WebhookView['webhook']['reply'] })}
            className={INPUT_CLASS}
          >
            <option value="native">In the HTTP response (wait for the answer)</option>
            <option value="callback">POST to a callback URL</option>
            <option value="none">No replies</option>
          </select>
        </Field>
        <Field label="Wait up to (seconds)" hint="Then 202 {queued} and a poll URL.">
          <div className="flex gap-2">
            <input className={INPUT_CLASS} type="number" min={5} max={120} value={timeout} onChange={e => setTimeoutSec(e.target.value)} aria-label="Reply timeout" disabled={h.reply !== 'native'} />
            <Button disabled={busy || h.reply !== 'native' || Number(timeout) === h.replyTimeoutSec} onClick={() => void save({ replyTimeoutSec: Math.round(Number(timeout)) })}>Save</Button>
          </div>
        </Field>
      </div>

      <Field label="Callback URL" hint="Replies that miss the open request, proactive messages, and (in callback mode) every reply. Signed: X-Codiby-Signature = sha256=HMAC(secret, timestamp + '.' + body).">
        <div className="flex gap-2">
          <input className={`${INPUT_CLASS} font-mono`} value={callbackUrl} onChange={e => setCallbackUrl(e.target.value)} placeholder="https://example.com/codiby" aria-label="Callback URL" />
          <Button disabled={busy || callbackUrl.trim() === h.callbackUrl} onClick={() => void save({ callbackUrl: callbackUrl.trim() })}>Save</Button>
        </div>
      </Field>
      {(h.callbackUrl || h.reply === 'callback') && (
        <Field label="Signing secret">
          <div className="flex gap-2">
            <input readOnly className={`${INPUT_CLASS} font-mono`} value={signing ?? '••••••••••••••••'} aria-label="Signing secret" />
            {signing ? <CopyButton text={signing} /> : (
              <Button disabled={busy} onClick={() => void act('reveal', async () => { setSigning((await channelsApi.secret(api, ch.id, 'reveal', 'signing')).secret); })}>
                <Eye size={12} /> Reveal
              </Button>
            )}
          </div>
        </Field>
      )}

      <div className="mb-1">
        <span className={LABEL_CLASS}>Try it</span>
        {/* `!` beats the global unlayered `pre` rule (13px, 12px padding, surface background). */}
        <pre className="!m-0 !px-3 !py-2 !bg-base !rounded-md !text-[11px] !leading-[1.6] font-mono text-zinc-300 border border-border overflow-x-auto whitespace-pre">{curlExample(url, token ?? '<token>', shortcut)}</pre>
      </div>

      {shortcut && (
        <div className="mt-3">
          <span className={LABEL_CLASS}>Set up the Shortcut</span>
          <ol className="list-decimal pl-5 text-[11.5px] text-zinc-400 space-y-1">
            <li>In Shortcuts, create a shortcut and add <span className="text-zinc-200">Dictate Text</span> (or <span className="text-zinc-200">Ask for Input</span>).</li>
            <li>Add <span className="text-zinc-200">Get Contents of URL</span> with the URL above plus <span className="font-mono text-zinc-300">?format=text</span>, method POST.</li>
            <li>Headers: <span className="font-mono text-zinc-300">X-Codiby-Token</span> = your token. Request body JSON: <span className="font-mono text-zinc-300">text</span> = the dictated text.</li>
            <li>Add <span className="text-zinc-200">Speak Text</span> or <span className="text-zinc-200">Show Result</span> with the response.</li>
            <li>Name it (e.g. "Ask Codiby") to run it with Siri. The URL must be reachable from your phone (LAN, Tailscale or a tunnel).</li>
          </ol>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Delivery settings
// ---------------------------------------------------------------------------

function DeliverySettings({ api, data, onChanged, onError }: { api: Api; data: ChannelsOverview; onChanged: () => void; onError: (m: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    onError(null);
    try { await fn(); onChanged(); } catch (err) { onError(errorText(err)); } finally { setBusy(false); }
  };
  return (
    <Section title="Delivery" hint="Replies always go back where the message came from. These settings are for messages the agent starts.">
      <Card>
        <div className="flex items-center gap-3 mb-3">
          <div className="flex-1 min-w-0">
            <div className="text-[12px] text-zinc-300">Preferred channel</div>
            <div className="text-[11px] text-zinc-500">Reminders, alerts and approvals go here first, then to the others.</div>
          </div>
          <select
            aria-label="Preferred channel"
            value={data.preferredChannel ?? ''}
            disabled={busy}
            onChange={e => void run(() => agentCore.saveConfig(api, { preferredChannel: e.target.value || null }))}
            className={`${INPUT_BASE_CLASS} shrink-0 max-w-[260px]`}
          >
            <option value="">The one I used last</option>
            {data.channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <ToggleRow
          label="Tell me when a coding session finishes"
          hint="A short note with the session's last answer (not for the agent's own replies)."
          on={data.alerts.sessionFinished}
          disabled={busy}
          onClick={() => void run(() => channelsApi.setAlerts(api, { sessionFinished: !data.alerts.sessionFinished }))}
        />
      </Card>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Messages from other people
// ---------------------------------------------------------------------------

function OthersInbox({ api, refreshKey }: { api: Api; refreshKey: number }) {
  const inbox = usePolled(() => agentCore.messages(api, { direction: 'in', trusted: false, limit: 30 }), [api, refreshKey], 15000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows: AgentChannelMessage[] = inbox.data?.messages ?? [];

  const markHandled = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await agentCore.markHandled(api, id);
      inbox.setData(prev => prev ? { messages: prev.messages.map(m => (m.id === id ? { ...m, handledAt: Date.now() } : m)) } : prev);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title="Messages from other people" hint="Kept as untrusted content. The agent can read and summarise them on request; it never follows instructions inside them.">
      {error && <div className="mb-2"><ErrorNote message={error} /></div>}
      {inbox.error && !inbox.data ? (
        <ErrorNote message={inbox.error} onRetry={() => void inbox.reload()} />
      ) : rows.length === 0 ? (
        <EmptyNote><Inbox size={14} className="inline mr-1.5 -mt-0.5" />Nothing here.</EmptyNote>
      ) : (
        <Card className="!px-0 !py-0 divide-y divide-border">
          {rows.map(m => (
            <div key={m.id} className={`flex items-start gap-3 px-3.5 py-2.5 ${m.handledAt ? 'opacity-50' : ''}`}>
              <div className="w-6 h-6 rounded-md bg-surface-light border border-border grid place-items-center shrink-0 mt-0.5">
                {ICONS[(m.channelType as ChannelKind)] ?? <MessageCircle size={12} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-zinc-200 flex items-center gap-2">
                  <span className="truncate">{m.peerName || m.peer}</span>
                  <span className="text-[11px] text-zinc-600 shrink-0">{relativeTime(m.createdAt)}</span>
                </div>
                <div className="text-[11.5px] text-zinc-400 whitespace-pre-wrap break-words line-clamp-3">{m.text}</div>
              </div>
              {!m.handledAt && (
                <Button disabled={busy === m.id} onClick={() => void markHandled(m.id)}>
                  {busy === m.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Mark read
                </Button>
              )}
            </div>
          ))}
        </Card>
      )}
    </Section>
  );
}
