import { useEffect, useMemo, useState } from 'react';
import {
  ArrowUp, ArrowUpRight, Bot, Check, CheckCheck, CircleCheck, Copy, ExternalLink, GitPullRequest, Hash,
  Loader2, MessageCircle, Pause, RefreshCw, Sparkles, X,
} from 'lucide-react';
import type { ClaudeClient, SlackStatus, SlackThreadMessage } from '../lib/claude-client';
import { BUCKETS, initials, type InboxRow, type InboxSource, type RowStatus } from '../lib/inbox';
import type { ProjectFolder } from '../lib/project-scope';
import { Markdown } from './Markdown';

export interface HandOff { cwd: string; remoteId: string | null; prompt: string; itemId: string }

interface Props {
  client: ClaudeClient | null;
  rows: InboxRow[];
  slack: SlackStatus;
  /** Projects to start an agent in, first folder each. */
  projects: { id: string; name: string; folders: ProjectFolder[] }[];
  defaultProjectId: string | null;
  onOpenSession: (sessionId: string) => void;
  onDone: (row: InboxRow) => void;
  onRead: (row: InboxRow) => void;
  onHandToAgent: (h: HandOff) => void;
}

const SOURCE_LABEL: Record<InboxSource, string> = { session: 'Session', slack: 'Slack', pr: 'Pull request' };
const TABS: { key: 'all' | InboxSource; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'session', label: 'Sessions' },
  { key: 'slack', label: 'Slack' },
  { key: 'pr', label: 'Pull requests' },
];
const open = (url: string | null | undefined) => { if (url) window.open(url, '_blank', 'noopener'); };

function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** A person's colour, stable per name. */
function personColor(name: string): string {
  const palette = ['#c2410c', '#059669', '#2563eb', '#7c3aed', '#db2777', '#0891b2', '#ca8a04'];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length]!;
}

function SourceTile({ row }: { row: InboxRow }) {
  const Icon = row.source === 'session' ? Bot
    : row.source === 'pr' ? GitPullRequest
    : row.item?.kind === 'dm' ? MessageCircle : Hash;
  const st: Record<Exclude<RowStatus, null>, { bg: string; icon: typeof Check }> = {
    wait: { bg: 'var(--ib-warn)', icon: Pause }, err: { bg: 'var(--ib-err)', icon: X }, ok: { bg: 'var(--ib-ok)', icon: Check },
  };
  const s = row.status ? st[row.status] : null;
  return (
    <div className={`ib-tile ib-k-${row.source}`}>
      <Icon size={17} strokeWidth={1.8} />
      {s
        ? <span className="ib-st" style={{ background: s.bg }}><s.icon size={10} strokeWidth={2.6} /></span>
        : row.person && <span className="ib-who" style={{ background: personColor(row.title) }}>{row.person}</span>}
    </div>
  );
}

export function Inbox({ client, rows, slack, projects, defaultProjectId, onOpenSession, onDone, onRead, onHandToAgent }: Props) {
  const [tab, setTab] = useState<'all' | InboxSource>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);

  const visible = useMemo(() => rows.filter(r => tab === 'all' || r.source === tab), [rows, tab]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length };
    for (const r of rows) c[r.source] = (c[r.source] ?? 0) + 1;
    return c;
  }, [rows]);
  const current = rows.find(r => r.id === selected) ?? null;

  // Keep a selection while there is something to select.
  useEffect(() => {
    if (!current && visible.length) setSelected(visible[0]!.id);
  }, [current, visible]);
  useEffect(() => { if (current?.unread && current.item) onRead(current); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [current?.id]);

  const slackOff = slack.state === 'off' || slack.state === 'error';

  return (
    <div className="inbox flex-1 min-h-0 grid grid-cols-[minmax(420px,1fr)_1fr]">
      <section className="ib-list">
        <div className="ib-head">
          <h1>Inbox</h1>
          <span className="ib-faint">{rows.length ? `${rows.length} waiting on you` : 'All clear'}</span>
          <div className="ml-auto flex gap-1">
            {client && (
              <button type="button" className="ib-icon" title="Refresh pull requests" onClick={() => { void client.refreshInbox(); }}>
                <RefreshCw size={15} strokeWidth={1.6} />
              </button>
            )}
            <button
              type="button" className="ib-icon" title="Mark all done"
              onClick={() => { for (const r of visible) if (r.item || r.source === 'session') onDone(r); }}
            >
              <CheckCheck size={15} strokeWidth={1.6} />
            </button>
          </div>
        </div>
        <div className="ib-tabs">
          {TABS.map(t => (
            <button key={t.key} type="button" className={`ib-tab ${tab === t.key ? 'on' : ''}`} onClick={() => setTab(t.key)}>
              {t.key !== 'all' && <i className={`ib-kd ib-k-${t.key}`} />}
              {t.label}
              {!!counts[t.key] && <span className="ib-faint">{counts[t.key]}</span>}
            </button>
          ))}
          {slackOff && (
            <button type="button" className="ib-connect" onClick={() => setSetup(true)}>
              <Hash size={13} strokeWidth={1.8} /> {slack.state === 'error' ? 'Slack: reconnect' : 'Connect Slack'}
            </button>
          )}
        </div>
        <div className="ib-rows">
          {visible.length === 0 && (
            <div className="ib-empty">Nothing waiting on you{tab !== 'all' ? ` in ${TABS.find(t => t.key === tab)!.label}` : ''}.</div>
          )}
          {BUCKETS.map(b => {
            const list = visible.filter(r => r.bucket === b.key);
            if (!list.length) return null;
            return (
              <div key={b.key}>
                <div className="ib-grp">{b.label}</div>
                {list.map(r => (
                  <div key={r.id} className={`ib-row ${r.id === selected ? 'sel' : ''}`} onClick={() => { setSelected(r.id); setSetup(false); }}>
                    <SourceTile row={r} />
                    <div className="min-w-0">
                      <div className={`ib-kind ib-k-${r.source}`}>{SOURCE_LABEL[r.source]} <span className="ib-where">· {r.where}</span></div>
                      <div className="ib-title">
                        <span className="truncate">{r.title}</span>
                        {r.tag && <span className={`ib-tag ${r.tag.tone ?? ''}`}>{r.tag.label}</span>}
                      </div>
                      {r.body && <div className="ib-body">{r.body}</div>}
                    </div>
                    <div className="ib-meta">
                      {ago(r.at)}
                      {r.unread && <span className="ib-unread" />}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </section>

      <section className="ib-detail">
        {setup || (!current && slackOff)
          ? <SlackSetup client={client} slack={slack} onClose={() => setSetup(false)} />
          : current
            ? <Detail
                key={current.id}
                row={current}
                client={client}
                projects={projects}
                defaultProjectId={defaultProjectId}
                onOpenSession={onOpenSession}
                onDone={() => onDone(current)}
                onHandToAgent={onHandToAgent}
              />
            : <div className="ib-empty">Select something on the left.</div>}
      </section>
    </div>
  );
}

// ── detail ──────────────────────────────────────────────────────────────────

function Detail({ row, client, projects, defaultProjectId, onOpenSession, onDone, onHandToAgent }: {
  row: InboxRow; client: ClaudeClient | null;
  projects: Props['projects']; defaultProjectId: string | null;
  onOpenSession: (id: string) => void; onDone: () => void; onHandToAgent: (h: HandOff) => void;
}) {
  const ctx = (row.item?.context ?? {}) as Record<string, string | number | boolean | null>;
  const [thread, setThread] = useState<SlackThreadMessage[] | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [projectId, setProjectId] = useState<string>(defaultProjectId ?? projects[0]?.id ?? '');

  useEffect(() => {
    if (row.source !== 'slack' || !client) return;
    let live = true;
    client.slackThread(String(ctx.channel), String(ctx.ts), ctx.threadTs ? String(ctx.threadTs) : null)
      .then(t => { if (live) setThread(t); })
      .catch(e => { if (live) setThreadError((e as Error).message); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id]);

  const project = projects.find(p => p.id === projectId);
  const handOff = (prompt: string) => {
    const f = project?.folders[0];
    if (!f) return;
    onHandToAgent({ cwd: f.path, remoteId: f.remoteId, prompt, itemId: row.item?.id ?? row.id });
  };

  const header = (
    <div className="ib-dh">
      <span className={`ib-dkind ib-k-${row.source}`}>{SOURCE_LABEL[row.source]}</span>
      <span className="font-medium truncate">{row.source === 'slack' ? String(ctx.where ?? '') : row.title}</span>
      <div className="ml-auto flex gap-1.5 shrink-0">
        {row.source === 'session' && row.sessionId && (
          <button type="button" className="ib-btn" onClick={() => onOpenSession(row.sessionId!)}><ArrowUpRight size={14} /> Open session</button>
        )}
        {row.item?.url && (
          <button type="button" className="ib-btn" onClick={() => open(row.item!.url)}>
            <ExternalLink size={14} /> {row.source === 'slack' ? 'Open in Slack' : 'Open on GitHub'}
          </button>
        )}
        <button type="button" className="ib-btn" onClick={onDone}><CircleCheck size={14} /> Done</button>
      </div>
    </div>
  );

  const projectPicker = projects.length > 0 && (
    <select className="ib-select" value={projectId} onChange={e => setProjectId(e.target.value)} aria-label="Project">
      {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );

  if (row.source === 'slack') {
    const threadText = (thread ?? []).map(m => `${m.name}: ${m.text}`).join('\n');
    return (
      <>
        {header}
        <div className="ib-thread">
          {!thread && !threadError && <div className="ib-faint flex items-center gap-2"><Loader2 size={13} className="animate-spin" /> Loading conversation…</div>}
          {threadError && <div className="ib-faint">Couldn't load the conversation: {threadError}</div>}
          {(thread ?? []).map(m => (
            <div key={m.ts} className={`ib-msg ${m.ts === ctx.ts ? 'hl' : ''}`}>
              <span className="ib-av" style={{ background: personColor(m.name) }}>{initials(m.name)}</span>
              <div className="min-w-0">
                <div className="ib-who-line"><b>{m.mine ? 'You' : m.name}</b><span>{new Date(Number(m.ts) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
                {/* Slack's mrkdwn, converted by the bridge; older bridges send only text. */}
                {m.markdown
                  ? <Markdown text={m.markdown} className="ib-md" />
                  : <div className="ib-txt">{m.text}</div>}
                {!!m.reactions?.length && (
                  <div className="ib-reactions">
                    {m.reactions.map(r => (
                      <span key={r.name} className={`ib-reaction ${r.mine ? 'mine' : ''}`} title={`:${r.name}:`}>
                        {r.unicode ?? (r.url ? <img src={r.url} alt={`:${r.name}:`} /> : `:${r.name}:`)}
                        <span>{r.count}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {row.agent ? <AgentCard row={row} onOpenSession={onOpenSession} onDone={onDone} /> : <div className="ib-agent">
            <Bot size={16} />
            <div className="min-w-0 flex-1">
              <b>Hand this to an agent</b>
              <p>Starts a session in {project ? <code>{project.name}</code> : 'a project'} with this conversation as context, to look into it and draft a reply for you to approve. Nothing is posted to Slack.</p>
              <div className="flex gap-1.5 mt-2.5 flex-wrap">
                <button
                  type="button" className="ib-btn acc" disabled={!project || !thread}
                  onClick={() => handOff(
                    `Someone is waiting on me in Slack (${String(ctx.where)}). The conversation so far:\n\n${threadText}\n\n` +
                    `The message for me is from ${row.title}: "${row.body}".\n\n` +
                    `Work out what they need using this repository, do the investigation or the change if it is small and clear, ` +
                    `and end with a short reply I can send back. Do not post anything to Slack.`,
                  )}
                >
                  <Sparkles size={14} /> Ask an agent
                </button>
                {projectPicker}
              </div>
            </div>
          </div>}
        </div>
        <div className="ib-reply">
          <textarea
            value={reply}
            onChange={e => setReply(e.target.value)}
            placeholder={ctx.inThread || ctx.threadTs ? 'Reply in thread…' : 'Reply…'}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.currentTarget.form ?? e.currentTarget.parentElement)?.querySelector<HTMLButtonElement>('.ib-send')?.click(); }}
          />
          <div className="ib-rb">
            <span className="ib-faint text-[11.5px]">Sends as you · ⌘↩</span>
            <button
              type="button" className="ib-send" disabled={!reply.trim() || sending || !client}
              onClick={async () => {
                if (!client) return;
                setSending(true);
                try {
                  // A thread is answered in the thread; a channel mention opens one on
                  // the message; a DM is answered in the conversation itself.
                  const threadTs = ctx.threadTs ? String(ctx.threadTs) : row.item?.kind === 'dm' ? null : String(ctx.ts);
                  await client.slackReply(String(ctx.channel), threadTs, reply, row.item?.id);
                  setReply('');
                } catch (e) { alert(`Couldn't send: ${(e as Error).message}`); }
                finally { setSending(false); }
              }}
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={15} />}
            </button>
          </div>
        </div>
      </>
    );
  }

  if (row.source === 'pr') {
    const failing = row.item?.kind === 'checks_failing';
    return (
      <>
        {header}
        <div className="ib-thread">
          <div className="ib-pr">
            <div className="ib-faint text-[12px]">{String(ctx.repo)} #{String(ctx.number)}</div>
            <div className="text-[15px] font-semibold mt-1">{row.title}</div>
            <div className="ib-txt mt-1.5">{row.body}</div>
          </div>
          {row.agent ? <AgentCard row={row} onOpenSession={onOpenSession} onDone={onDone} /> : <div className="ib-agent">
            <Bot size={16} />
            <div className="min-w-0 flex-1">
              <b>{failing ? 'Fix it with an agent' : 'Review it with an agent'}</b>
              <p>{failing
                ? 'Starts a session that reads the failing checks with gh, fixes them on the PR branch and reports what changed.'
                : 'Starts a session that reads the diff with gh and writes up a review for you to post.'}</p>
              <div className="flex gap-1.5 mt-2.5 flex-wrap">
                <button
                  type="button" className="ib-btn acc" disabled={!project}
                  onClick={() => handOff(failing
                    ? `The checks are failing on my pull request ${row.item?.url}. Use \`gh pr checks\` and the job logs to find out why, fix it on the PR's branch (in a worktree if needed), and tell me what you changed.`
                    : `${String(ctx.author ?? 'A teammate')} asked me to review ${row.item?.url} ("${row.title}"). Read it with \`gh pr view\` / \`gh pr diff\`, check it against this codebase, and write a review I can post: what's wrong, what's risky, what's fine. Don't post it yourself.`)}
                >
                  <Sparkles size={14} /> {failing ? 'Fix checks' : 'Review PR'}
                </button>
                {projectPicker}
              </div>
            </div>
          </div>}
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="ib-thread">
        <div className="ib-faint text-[12px]">{row.where}</div>
        <div className="text-[15px] font-semibold">{row.title}</div>
        {row.body && <div className="ib-txt whitespace-pre-wrap">{row.body}</div>}
        <div>
          <button type="button" className="ib-btn acc" onClick={() => onOpenSession(row.sessionId!)}>
            <ArrowUpRight size={14} /> {row.status === 'wait' ? 'Review and decide' : row.status === 'err' ? 'Open to resume' : 'Open session'}
          </button>
        </div>
      </div>
    </>
  );
}

// ── Slack setup ─────────────────────────────────────────────────────────────

function SlackSetup({ client, slack, onClose }: { client: ClaudeClient | null; slack: SlackStatus; onClose: () => void }) {
  const [appToken, setAppToken] = useState('');
  const [userToken, setUserToken] = useState('');
  const [manifest, setManifest] = useState(slack.manifest ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (manifest || !client) return;
    void client.getSlack().then(s => setManifest(s.manifest ?? '')).catch(() => {});
  }, [client, manifest]);

  return (
    <>
      <div className="ib-dh">
        <span className="ib-dkind ib-k-slack">Slack</span>
        <span className="font-medium">Connect your workspace</span>
        <button type="button" className="ib-icon ml-auto" onClick={onClose} aria-label="Close"><X size={15} /></button>
      </div>
      <div className="ib-thread ib-setup">
        <p className="ib-txt">
          Mentions, DMs and replies in your threads land here the moment they're sent. Codiby uses a Slack app of your own in
          Socket Mode: your computer opens the connection to Slack, so nothing needs a public URL. Tokens stay in
          <code> ~/.codiby/slack.json</code> on this machine.
        </p>
        {slack.state === 'error' && slack.error && <div className="ib-error">Last error: {slack.error}</div>}
        <ol>
          <li>
            <b>Create the app from this manifest.</b> In <a onClick={() => open('https://api.slack.com/apps?new_app=1')}>api.slack.com/apps</a>, choose
            “From a manifest”, pick your workspace and paste:
            <div className="ib-manifest">
              <pre>{manifest || '…'}</pre>
              <button type="button" className="ib-btn" onClick={() => { void navigator.clipboard.writeText(manifest); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </li>
          <li><b>App-level token.</b> Basic Information → App-Level Tokens → Generate, with the <code>connections:write</code> scope. It starts with <code>xapp-</code>.</li>
          <li><b>User token.</b> Install App → Install to Workspace, then copy the <i>User OAuth Token</i>. It starts with <code>xoxp-</code>.</li>
        </ol>
        <label className="ib-field"><span>App-level token</span><input value={appToken} onChange={e => setAppToken(e.target.value)} placeholder="xapp-…" spellCheck={false} /></label>
        <label className="ib-field"><span>User OAuth token</span><input value={userToken} onChange={e => setUserToken(e.target.value)} placeholder="xoxp-…" spellCheck={false} /></label>
        {error && <div className="ib-error">{error}</div>}
        <div>
          <button
            type="button" className="ib-btn acc" disabled={busy || !appToken || !userToken || !client}
            onClick={async () => {
              if (!client) return;
              setBusy(true); setError(null);
              try { await client.connectSlack(appToken, userToken); onClose(); }
              catch (e) { setError((e as Error).message); }
              finally { setBusy(false); }
            }}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Hash size={14} />} Connect
          </button>
        </div>
      </div>
    </>
  );
}

/** Where a handed-off item stands: the agent session's live state and its
 *  latest words, in place of the "hand it off" block. */
function AgentCard({ row, onOpenSession, onDone }: { row: InboxRow; onOpenSession: (id: string) => void; onDone: () => void }) {
  const a = row.agent!;
  const label = {
    working: 'Working on it…',
    waiting: 'Needs your decision to continue',
    finished: 'Finished — read what it found',
    idle: 'Idle',
    gone: 'The session was closed',
  }[a.state];
  return (
    <div className={`ib-agent-card ib-agent-${a.state}`}>
      <div className="flex items-center gap-2.5">
        <span className="ib-agent-dot" />
        <div className="min-w-0 flex-1">
          <div className="ib-faint text-[11.5px] uppercase tracking-[0.04em] font-semibold">Agent session</div>
          <div className="font-medium truncate">{a.name}</div>
        </div>
        {a.state !== 'gone' && (
          <button type="button" className="ib-btn" onClick={() => onOpenSession(a.sessionId)}><ArrowUpRight size={14} /> Open session</button>
        )}
      </div>
      <div className="ib-agent-state">{label}</div>
      {a.preview && <div className="ib-agent-preview">{a.preview}</div>}
      {a.state === 'finished' && (
        <div className="flex gap-1.5 mt-3">
          <button type="button" className="ib-btn acc" onClick={() => onOpenSession(a.sessionId)}><ArrowUpRight size={14} /> Review the result</button>
          <button type="button" className="ib-btn" onClick={onDone}><CircleCheck size={14} /> Done</button>
        </div>
      )}
    </div>
  );
}
