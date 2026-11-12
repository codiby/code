/**
 * Agent view → Overview: on/off, the agent session, channel health and the
 * latest channel traffic (with untrusted messages flagged).
 */

import { useState } from 'react';
import { ArrowUpRight, ShieldAlert } from 'lucide-react';
import { agentCore, type AgentChannelMessage } from '../../lib/agent/api';
import { CHANNEL_LABELS, type ChannelKind } from '../../lib/agent/channels';
import { Button, Card, EmptyNote, ErrorNote, Pill, Section, Spinner, Stat, Toggle, relativeTime, usePolled, type AgentSectionProps } from './ui';

const PAIRED_TYPES = new Set(['telegram', 'whatsapp']);

/** "http_webhook" → "Webhook"; unknown types pass through. */
const channelLabel = (type: string) => CHANNEL_LABELS[type as ChannelKind] ?? type;

// A stopped session isn't a fault: it starts with the next message.
const SESSION_STATE: Record<string, string> = {
  stopped: 'chat idle',
  starting: 'chat starting',
  running: 'chat running',
};

export function OverviewSection({ api, refreshKey, onOpenSession }: AgentSectionProps) {
  const status = usePolled(() => agentCore.status(api), [api, refreshKey], 10_000);
  const traffic = usePolled(() => agentCore.messages(api, { limit: 30 }), [api, refreshKey], 15_000);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status.loading && !status.data) return <Spinner />;
  if (status.error && !status.data) return <ErrorNote message={`Couldn't reach the agent on this host: ${status.error}`} onRetry={() => void status.reload()} />;
  const s = status.data!;

  const toggle = async () => {
    setSaving(true);
    setError(null);
    try {
      await agentCore.saveConfig(api, { enabled: !s.enabled });
      await status.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const connected = s.channels.filter(c => c.status.connected).length;
  const messages = traffic.data?.messages ?? [];
  const untrusted = messages.filter(m => m.direction === 'in' && !m.trusted && !m.handledAt).length;

  return (
    <>
      {error && <div className="mb-3"><ErrorNote message={error} /></div>}
      <Card className="mb-[18px] flex items-center gap-4">
        <div className="text-[28px] leading-none">{s.persona.emoji || '🤖'}</div>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-semibold text-zinc-100 flex items-center gap-2 min-w-0">
            <span className="truncate">{s.persona.name}</span>
            {s.enabled ? <Pill tone="green">On</Pill> : <Pill>Off</Pill>}
            {s.session?.isStreaming && <Pill tone="indigo">Working</Pill>}
            {s.session?.pendingApproval && <Pill tone="amber">Waiting for approval</Pill>}
          </div>
          <div className="text-[11.5px] text-zinc-500 mt-0.5 truncate">
            Runs on {s.host} · {s.persona.timezone}
            {s.session ? ` · ${SESSION_STATE[s.session.runtimeStatus] ?? `chat ${s.session.runtimeStatus}`}` : ''}
          </div>
        </div>
        {s.session && onOpenSession && (
          <Button onClick={() => onOpenSession(s.session!.id)}>
            Open chat <ArrowUpRight size={12} />
          </Button>
        )}
        <Toggle on={s.enabled} onClick={() => void toggle()} disabled={saving} label={s.enabled ? 'Turn the agent off on this host' : 'Turn the agent on on this host'} />
      </Card>

      {!s.enabled && (
        <div className="mb-[18px]">
          <EmptyNote>
            The agent is off on this host. Turn it on only on the machine that should run it around the clock — every
            host with the agent on runs its own channels.
          </EmptyNote>
        </div>
      )}

      <div className="flex gap-2.5 mb-[18px]">
        <Stat value={`${connected}/${s.channels.length}`} label="Channels connected" tone={s.channels.length && connected === s.channels.length ? 'text-green-400' : undefined} />
        <Stat value={s.session?.messageCount ?? 0} label="Messages in the agent's chat" />
        <Stat value={untrusted} label="Unread from others" tone={untrusted ? 'text-amber-300' : undefined} />
      </div>

      <Section title="Channels">
        {s.channels.length === 0 ? (
          <EmptyNote>No channels yet. Add Telegram or WhatsApp in the Channels tab.</EmptyNote>
        ) : (
          <div className="flex flex-col gap-1.5">
            {s.channels.map(ch => {
              const detail = ch.status.lastError || ch.status.detail || (ch.status.connected ? 'Connected' : 'Disconnected');
              return (
                <Card key={ch.id} className="flex items-center gap-3 py-2">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${ch.status.connected ? 'bg-green-400' : ch.status.lastError ? 'bg-red-400' : 'bg-zinc-600'}`}
                    aria-label={ch.status.connected ? 'Connected' : ch.status.lastError ? 'Error' : 'Disconnected'}
                  />
                  <span className="text-[12.5px] text-zinc-200 flex-1 min-w-0 truncate">{ch.name}</span>
                  {/* Webhooks authenticate with a token; only chat apps pair with the owner. */}
                  {!ch.ownerPaired && PAIRED_TYPES.has(ch.type) && <Pill tone="amber">Not paired</Pill>}
                  <span className={`text-[11px] truncate max-w-[45%] ${ch.status.lastError ? 'text-red-300' : 'text-zinc-500'}`} title={detail}>{detail}</span>
                </Card>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Recent channel traffic" hint="What arrived and what the agent sent. Messages from other people are never treated as instructions.">
        {traffic.error && !traffic.data ? (
          <ErrorNote message={`Couldn't load channel traffic: ${traffic.error}`} onRetry={() => void traffic.reload()} />
        ) : traffic.loading && !traffic.data ? (
          <Spinner />
        ) : messages.length === 0 ? (
          <EmptyNote>Nothing yet. Messages you exchange with the agent on any channel show up here.</EmptyNote>
        ) : (
          <div className="flex flex-col gap-1">
            {messages.map(m => (
              <TrafficRow
                key={m.id}
                m={m}
                onHandled={async () => {
                  setError(null);
                  try {
                    await agentCore.markHandled(api, m.id);
                    await traffic.reload();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  }
                }}
              />
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function TrafficRow({ m, onHandled }: { m: AgentChannelMessage; onHandled: () => Promise<void> }) {
  const foreign = m.direction === 'in' && !m.trusted;
  return (
    <div className={`flex items-start gap-2.5 px-3 py-2 rounded-md border ${foreign && !m.handledAt ? 'border-amber-500/30 bg-amber-500/5' : 'border-border bg-surface'}`}>
      <span className={`text-[10px] font-semibold uppercase mt-0.5 w-7 shrink-0 ${m.direction === 'in' ? 'text-sky-300' : 'text-indigo-300'}`}>{m.direction === 'in' ? 'In' : 'Out'}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-zinc-500 flex items-center gap-1.5 flex-wrap">
          <span>{channelLabel(m.channelType)}</span>·<span className="truncate max-w-[220px]">{m.peerName || m.peer}</span>·<span title={new Date(m.createdAt).toLocaleString()}>{relativeTime(m.createdAt)}</span>
          {foreign && <span className="inline-flex items-center gap-1 text-amber-300"><ShieldAlert size={11} /> from someone else</span>}
          {m.status === 'failed' && <Pill tone="red">Failed</Pill>}
          {/* The channel timed out after the send left: it may have arrived, so it was not retried. */}
          {m.status === 'unconfirmed' && <span title="The channel didn't confirm this message arrived. It wasn't retried, so it is never sent twice."><Pill tone="amber">Unconfirmed</Pill></span>}
        </div>
        <div className="text-[12px] text-zinc-300 whitespace-pre-wrap break-words line-clamp-3">{m.text || <span className="text-zinc-600">(no text)</span>}</div>
        {m.error && <div className="text-[11px] text-red-300 mt-0.5 break-words">{m.error}</div>}
      </div>
      {foreign && !m.handledAt && <Button onClick={() => void onHandled()}>Mark read</Button>}
    </div>
  );
}
