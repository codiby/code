import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Loader2, Smile, SmilePlus } from 'lucide-react';
import type { ClaudeClient, EmojiMatch, SlackLiveMessage, SlackLiveReaction, SlackReaction, SlackThreadMessage } from '../lib/claude-client';
import { initials } from '../lib/inbox';
import { Markdown } from './Markdown';

/** A person's colour, stable per name — the avatar while the photo loads,
 *  or when there is none. */
export function personColor(name: string): string {
  const palette = ['#c2410c', '#059669', '#2563eb', '#7c3aed', '#db2777', '#0891b2', '#ca8a04'];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length]!;
}

export function SlackAvatar({ name, url, size = 32 }: { name: string; url?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  return url && !broken
    ? <img className="ib-av" src={url} alt="" width={size} height={size} style={{ width: size, height: size }} onError={() => setBroken(true)} />
    : <span className="ib-av" style={{ background: personColor(name), width: size, height: size }}>{initials(name)}</span>;
}

/** A small emoji picker: search by name, standard and workspace emoji. */
export function EmojiPicker({ client, onPick, onClose }: { client: ClaudeClient | null; onPick: (e: EmojiMatch) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<EmojiMatch[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!client) return;
    let live = true;
    const t = setTimeout(() => { void client.searchEmoji(q).then(r => { if (live) setList(r); }).catch(() => {}); }, q ? 120 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [client, q]);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [onClose]);
  return (
    <div ref={ref} className="ib-picker" onMouseDown={e => e.stopPropagation()}>
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search emoji" spellCheck={false}
        onKeyDown={e => { if (e.key === 'Enter' && list[0]) { e.preventDefault(); onPick(list[0]); } }} />
      <div className="ib-picker-grid">
        {list.map(e => (
          <button key={e.name} type="button" title={`:${e.name}:`} onClick={() => onPick(e)}>
            {e.unicode ?? (e.url ? <img src={e.url} alt={`:${e.name}:`} /> : `:${e.name}:`)}
          </button>
        ))}
        {!list.length && <span className="ib-faint text-[12px] px-1 py-2">No emoji</span>}
      </div>
    </div>
  );
}

interface Props {
  client: ClaudeClient | null;
  connectionId: string;
  channel: string;
  /** The message the view is about (or "now", for a DM opened from a name). */
  ts: string;
  threadTs: string | null;
  /** Message to highlight — the one that put the item in the Inbox. */
  highlightTs?: string;
  /** How far back a DM reads. */
  limit?: number;
  /** Close this Inbox item when the reply goes out. */
  itemId?: string;
  isDm: boolean;
  onOpenDm: (user: string, name: string) => void;
  /** Rendered after the messages, before the reply box (the agent block). */
  children?: ReactNode;
  /** The conversation as loaded (for an agent's prompt). */
  onThread?: (t: SlackThreadMessage[]) => void;
}

/**
 * A Slack conversation as the Inbox shows it: the thread (or the DM), live —
 * new messages and reactions arrive as they happen — with photos, reactions
 * you can add or take back, a reply box with emoji, and a click on a person
 * to open your DM with them.
 */
export function SlackConversation({ client, connectionId, channel, ts, threadTs, highlightTs, limit, itemId, isDm, onOpenDm, children, onThread }: Props) {
  const [thread, setThread] = useState<SlackThreadMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [picker, setPicker] = useState<string | null>(null);   // message ts, or 'reply'
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!client) return;
    let live = true;
    setThread(null); setError(null);
    client.slackThread(connectionId, channel, ts, threadTs, limit)
      .then(t => { if (live) setThread(t); })
      .catch(e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [client, connectionId, channel, ts, threadTs, limit]);

  useEffect(() => { if (thread) onThread?.(thread); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [thread]);

  // A DM opens at its latest message.
  useEffect(() => { if (isDm && thread) endRef.current?.scrollIntoView({ block: 'end' }); }, [isDm, thread?.length]);

  // Live: new messages in this conversation, and reactions on its messages.
  useEffect(() => {
    const onMsg = (e: Event) => {
      const ev = (e as CustomEvent<SlackLiveMessage>).detail;
      if (ev.channel !== channel || (ev.connectionId ?? 'default') !== connectionId) return;
      setThread(prev => {
        if (!prev) return prev;
        // A channel message with no replies yet roots its thread-to-be.
        const rootTs = prev[0]?.root ? prev[0].ts : threadTs ?? (isDm ? null : prev[0]?.ts ?? null);
        const belongs = rootTs ? ev.threadTs === rootTs : isDm && !ev.threadTs;
        if (!belongs || prev.some(m => m.ts === ev.message.ts)) return prev;
        const next = [...prev, ev.message];
        if (rootTs && next[0]?.ts === rootTs && !next[0].root) next[0] = { ...next[0], root: true };
        return next;
      });
    };
    const onReaction = (e: Event) => {
      const ev = (e as CustomEvent<SlackLiveReaction>).detail;
      if (ev.channel !== channel || ev.connectionId !== connectionId) return;
      setThread(prev => prev && prev.map(m => (m.ts === ev.ts ? { ...m, reactions: applyReaction(m.reactions ?? [], ev) } : m)));
    };
    window.addEventListener('codiby:slack-message', onMsg);
    window.addEventListener('codiby:slack-reaction', onReaction);
    return () => {
      window.removeEventListener('codiby:slack-message', onMsg);
      window.removeEventListener('codiby:slack-reaction', onReaction);
    };
  }, [channel, connectionId, threadTs, isDm]);

  const react = async (m: SlackThreadMessage, e: { name: string; unicode?: string; url?: string }) => {
    if (!client) return;
    const already = m.reactions?.find(r => r.name === e.name)?.mine ?? false;
    // Optimistic; the live event that follows is a no-op for our own change.
    setThread(prev => prev && prev.map(x => (x.ts === m.ts
      ? { ...x, reactions: applyReaction(x.reactions ?? [], { ...e, added: !already, mine: true }) } : x)));
    try { await client.slackReact(connectionId, channel, m.ts, e.name, already); }
    catch (err) {
      alert(`Couldn't ${already ? 'remove' : 'add'} the reaction: ${(err as Error).message}`);
      setThread(prev => prev && prev.map(x => (x.ts === m.ts
        ? { ...x, reactions: applyReaction(x.reactions ?? [], { ...e, added: already, mine: true }) } : x)));
    }
  };

  const insertEmoji = (e: EmojiMatch) => {
    const text = e.unicode ?? `:${e.name}:`;
    const el = replyRef.current;
    const at = el?.selectionStart ?? reply.length;
    setReply(reply.slice(0, at) + text + reply.slice(el?.selectionEnd ?? at));
    setPicker(null);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + text.length, at + text.length); });
  };

  const send = async () => {
    if (!client || !reply.trim()) return;
    setSending(true);
    try {
      // A thread is answered in the thread; a channel message opens one; a DM
      // is answered in the conversation itself.
      const target = threadTs ?? (isDm ? null : (thread?.[0]?.root ? thread[0].ts : ts));
      await client.slackReply(connectionId, channel, target, reply, itemId);
      setReply('');
    } catch (e) { alert(`Couldn't send: ${(e as Error).message}`); }
    finally { setSending(false); }
  };

  return (
    <>
      <div className="ib-thread ib-conv">
        {!thread && !error && <div className="ib-faint flex items-center gap-2"><Loader2 size={13} className="animate-spin" /> Loading conversation…</div>}
        {error && <div className="ib-faint">Couldn't load the conversation: {error}</div>}
        {(thread ?? []).map((m, i, all) => {
          // Like Slack: messages from the same person a few minutes apart read
          // as one block — photo and name once, the time on hover.
          const prev = all[i - 1];
          const cont = !!prev && !(prev.root && i === 1) && prev.user === m.user && !!m.user
            && Number(m.ts) - Number(prev.ts) < 5 * 60;
          const time = new Date(Number(m.ts) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          return (
          <Fragment key={m.ts}>
            <div className={`ib-msg ${cont ? 'cont' : ''} ${m.ts === highlightTs ? 'hl' : ''}`}>
              {cont
                ? <span className="ib-gutter-time">{time}</span>
                : (
                  <button type="button" className="ib-person" disabled={!m.user || m.mine} title={m.user && !m.mine ? `Message ${m.name}` : undefined}
                    onClick={() => m.user && !m.mine && onOpenDm(m.user, m.name)}>
                    <SlackAvatar name={m.name} url={m.avatar} />
                  </button>
                )}
              <div className="min-w-0">
                {!cont && (
                  <div className="ib-who-line">
                    <button type="button" className="ib-person-name" disabled={!m.user || m.mine} onClick={() => m.user && !m.mine && onOpenDm(m.user, m.name)}>
                      {m.mine ? 'You' : m.name}
                    </button>
                    <span>{time}</span>
                  </div>
                )}
                {m.markdown ? <Markdown text={m.markdown} className="ib-md" /> : <div className="ib-txt">{m.text}</div>}
                {!!m.reactions?.length && (
                  <div className="ib-reactions">
                    {m.reactions.map(r => (
                      <button key={r.name} type="button" className={`ib-reaction ${r.mine ? 'mine' : ''}`} title={`:${r.name}:${r.mine ? ' — click to remove yours' : ''}`}
                        onClick={() => react(m, r)}>
                        {r.unicode ?? (r.url ? <img src={r.url} alt={`:${r.name}:`} /> : `:${r.name}:`)}
                        <span>{r.count}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* Hover toolbar, as in Slack: reacting doesn't need a row of its own. */}
              <div className={`ib-msg-tools ${picker === m.ts ? 'open' : ''}`}>
                <button type="button" title="Add a reaction" onClick={() => setPicker(picker === m.ts ? null : m.ts)}>
                  <SmilePlus size={15} strokeWidth={1.6} />
                </button>
                {picker === m.ts && <EmojiPicker client={client} onClose={() => setPicker(null)} onPick={e => { setPicker(null); void react(m, e); }} />}
              </div>
            </div>
            {/* Like Slack's thread pane: the opening message, then its replies. */}
            {m.root && i === 0 && all.length > 1 && (
              <div className="ib-sep">{all.length - 1} {all.length === 2 ? 'reply' : 'replies'}</div>
            )}
          </Fragment>
          );
        })}
        {children}
        <div ref={endRef} />
      </div>
      <div className="ib-reply">
        <textarea
          ref={replyRef}
          value={reply}
          onChange={e => setReply(e.target.value)}
          placeholder={isDm ? 'Message…' : 'Reply in thread…'}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
        />
        <div className="ib-rb">
          <span className="ib-faint text-[11.5px]">Sends as you · ⌘↩</span>
          <div className="flex items-center gap-1 relative">
            <button type="button" className="ib-icon" title="Emoji" onClick={() => setPicker(picker === 'reply' ? null : 'reply')}>
              <Smile size={16} strokeWidth={1.6} />
            </button>
            {picker === 'reply' && <EmojiPicker client={client} onClose={() => setPicker(null)} onPick={insertEmoji} />}
            <button type="button" className="ib-send" disabled={!reply.trim() || sending || !client} onClick={() => void send()}>
              {sending ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={15} />}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/** Apply one reaction change to a message's chips. */
function applyReaction(list: SlackReaction[], ev: { name: string; added: boolean; mine: boolean; unicode?: string; url?: string }): SlackReaction[] {
  const cur = list.find(r => r.name === ev.name);
  // Our own change already applied optimistically: the echo is a no-op.
  if (ev.mine && cur && cur.mine === ev.added) return list;
  if (ev.added) {
    if (cur) return list.map(r => (r === cur ? { ...r, count: r.count + 1, mine: r.mine || ev.mine } : r));
    return [...list, { name: ev.name, count: 1, mine: ev.mine, unicode: ev.unicode, url: ev.url }];
  }
  if (!cur) return list;
  return cur.count <= 1
    ? list.filter(r => r !== cur)
    : list.map(r => (r === cur ? { ...r, count: r.count - 1, mine: ev.mine ? false : r.mine } : r));
}
