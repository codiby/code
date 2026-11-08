import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, ArrowUpRight, Bot, Check, CheckCheck, CircleCheck, Copy, ExternalLink, GitPullRequest, Hash,
  Loader2, MessageCircle, Pause, RefreshCw, Sparkles, UserX, X,
} from 'lucide-react';
import { slackConnectionOf, type ClaudeClient, type SlackStatus, type SlackThreadMessage } from '../lib/claude-client';
import { BUCKETS, initials, type InboxRow, type InboxSource, type RowStatus } from '../lib/inbox';
import type { ProjectFolder } from '../lib/project-scope';
import { SlackAvatar, SlackConversation } from './SlackConversation';

export interface HandOff { cwd: string; remoteId: string | null; prompt: string; itemId: string }

interface Props {
  client: ClaudeClient | null;
  rows: InboxRow[];
  /** Slack connections on this machine: project id (or `default`) → status. */
  slackConnections: Record<string, SlackStatus>;
  slackManifest: string;
  scopedProjectId: string | null;
  onEditProject: (projectId: string) => void;
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

/** "3 days ago", "4 months ago" — for dates that can be far back. */
function longAgo(ts: number): string {
  const d = Math.max(0, (Date.now() - ts) / 86_400_000);
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 30) return `${Math.floor(d)} days ago`;
  if (d < 365) return `${Math.floor(d / 30)} month${d < 60 ? '' : 's'} ago`;
  return `${Math.floor(d / 365)} year${d < 730 ? '' : 's'} ago`;
}

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
        : typeof row.item?.context.avatar === 'string'
          ? <img className="ib-who" src={row.item.context.avatar} alt="" />
          : row.person && <span className="ib-who" style={{ background: personColor(row.title) }}>{row.person}</span>}
    </div>
  );
}

export function Inbox({ client, rows, slackConnections, scopedProjectId, onEditProject, projects, defaultProjectId, onOpenSession, onDone, onRead, onHandToAgent }: Props) {
  const [tab, setTab] = useState<'all' | InboxSource>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);
  /** A DM opened from a person's name or photo, shown in place of the detail. */
  const [dm, setDm] = useState<{ connectionId: string; channel: string; name: string; avatar?: string } | null>(null);
  const openDm = async (connectionId: string, user: string, name: string) => {
    if (!client) return;
    try { setDm({ connectionId, ...(await client.slackOpenDm(connectionId, user)) }); }
    catch (e) { alert(`Couldn't open the DM with ${name}: ${(e as Error).message}`); }
  };

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

  // Slack connects per project. In a project, its own connection; in All
  // projects, whether any is up.
  const own = scopedProjectId ? slackConnections[scopedProjectId] : undefined;
  const anyUp = Object.values(slackConnections).some(c => c.state === 'connected' || c.state === 'connecting');
  const slackOff = scopedProjectId ? !own || own.state === 'error' : !anyUp;
  const connectSlack = () => { if (scopedProjectId) onEditProject(scopedProjectId); else setSetup(true); };

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
            <button type="button" className="ib-connect" onClick={connectSlack}>
              <Hash size={13} strokeWidth={1.8} /> {own?.state === 'error' ? 'Slack: reconnect' : 'Connect Slack'}
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
                  <div key={r.id} className={`ib-row ${r.id === selected && !dm ? 'sel' : ''}`} onClick={() => { setSelected(r.id); setSetup(false); setDm(null); }}>
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
        {dm
          ? <DmView client={client} dm={dm} onBack={() => setDm(null)} onOpenDm={(user, name) => openDm(dm.connectionId, user, name)} />
          : setup || (!current && slackOff && !scopedProjectId)
          ? <SlackByProject projects={projects} connections={slackConnections} onEditProject={onEditProject} onClose={() => setSetup(false)} />
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
                onOpenDm={(user, name) => openDm(slackConnectionOf(current.item!), user, name)}
              />
            : <div className="ib-empty">Select something on the left.</div>}
      </section>
    </div>
  );
}

// ── detail ──────────────────────────────────────────────────────────────────

function Detail({ row, client, projects, defaultProjectId, onOpenSession, onDone, onHandToAgent, onOpenDm }: {
  row: InboxRow; client: ClaudeClient | null;
  projects: Props['projects']; defaultProjectId: string | null;
  onOpenSession: (id: string) => void; onDone: () => void; onHandToAgent: (h: HandOff) => void;
  onOpenDm: (user: string, name: string) => void;
}) {
  const ctx = (row.item?.context ?? {}) as Record<string, string | number | boolean | null>;
  // The conversation as loaded, for the agent's prompt.
  const [thread, setThread] = useState<SlackThreadMessage[] | null>(null);
  // A Slack item belongs to the project whose connection it came through, and
  // its agent starts there — no choice to make. Anything else (a PR, a
  // message from the pre-projects connection) lets you pick.
  const ownerProject = row.source === 'slack' && row.item
    ? projects.find(p => p.id === slackConnectionOf(row.item!)) ?? null
    : null;
  const [projectId, setProjectId] = useState<string>(ownerProject?.id ?? defaultProjectId ?? projects[0]?.id ?? '');

  const [declining, setDeclining] = useState(false);
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
        {row.source === 'pr' && row.item?.kind === 'review_requested' && (
          <button
            type="button" className="ib-btn" disabled={declining}
            title="Remove yourself from the reviewers on GitHub"
            onClick={async () => {
              if (!client || !row.item) return;
              setDeclining(true);
              try { await client.declineReview(row.item.id); onDone(); }
              catch (e) { alert(`Couldn't decline: ${(e as Error).message}`); }
              finally { setDeclining(false); }
            }}
          >
            {declining ? <Loader2 size={14} className="animate-spin" /> : <UserX size={14} />} Decline review
          </button>
        )}
        <button type="button" className="ib-btn" onClick={onDone} title={row.source === 'pr' ? 'Remove from the Inbox — nothing changes on GitHub' : undefined}>
          {row.source === 'pr' ? <><X size={14} /> Dismiss</> : <><CircleCheck size={14} /> Done</>}
        </button>
      </div>
    </div>
  );

  const projectPicker = ownerProject ? null : projects.length > 0 && (
    <select className="ib-select" value={projectId} onChange={e => setProjectId(e.target.value)} aria-label="Project">
      {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );

  if (row.source === 'slack') {
    const threadText = (thread ?? []).map(m => `${m.name}: ${m.text}`).join('\n');
    return (
      <>
        {header}
        <SlackConversation
          client={client}
          connectionId={slackConnectionOf(row.item!)}
          channel={String(ctx.channel)}
          ts={String(ctx.ts)}
          threadTs={ctx.threadTs ? String(ctx.threadTs) : null}
          highlightTs={String(ctx.ts)}
          itemId={row.item?.id}
          isDm={row.item?.kind === 'dm'}
          onOpenDm={onOpenDm}
          onThread={setThread}
        >
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
        </SlackConversation>
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
            <div className="ib-dates">
              {typeof ctx.createdAt === 'number' && <span title={new Date(ctx.createdAt).toLocaleString()}>Opened {longAgo(ctx.createdAt)}</span>}
              <span title={new Date(Number(ctx.updatedAt ?? row.at)).toLocaleString()}>Updated {longAgo(Number(ctx.updatedAt ?? row.at))}</span>
              {Date.now() - Number(ctx.updatedAt ?? row.at) > 30 * 86_400_000 && <span className="ib-tag warn">Stale</span>}
            </div>
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

// ── a DM opened from a person ──────────────────────────────────────────────

function DmView({ client, dm, onBack, onOpenDm }: {
  client: ClaudeClient | null;
  dm: { connectionId: string; channel: string; name: string; avatar?: string };
  onBack: () => void; onOpenDm: (user: string, name: string) => void;
}) {
  // "Now", fixed when the DM opens, so the conversation reads up to the present.
  const [now] = useState(() => (Date.now() / 1000).toFixed(6));
  return (
    <>
      <div className="ib-dh">
        <button type="button" className="ib-icon" onClick={onBack} title="Back"><ArrowLeft size={15} /></button>
        <span className="ib-dkind ib-k-slack">Slack</span>
        <SlackAvatar name={dm.name} url={dm.avatar} size={22} />
        <span className="font-medium truncate">{dm.name}</span>
        <span className="ib-faint text-[12px]">direct message</span>
      </div>
      <SlackConversation client={client} connectionId={dm.connectionId} channel={dm.channel} ts={now} threadTs={null} isDm limit={40} onOpenDm={onOpenDm} />
    </>
  );
}

// ── Slack, project by project ──────────────────────────────────────────────

function SlackByProject({ projects, connections, onEditProject, onClose }: {
  projects: Props['projects']; connections: Record<string, SlackStatus>;
  onEditProject: (id: string) => void; onClose: () => void;
}) {
  const legacy = connections.default;
  return (
    <>
      <div className="ib-dh">
        <span className="ib-dkind ib-k-slack">Slack</span>
        <span className="font-medium">Connect a workspace</span>
        <button type="button" className="ib-icon ml-auto" onClick={onClose} aria-label="Close"><X size={15} /></button>
      </div>
      <div className="ib-thread ib-setup">
        <p className="ib-txt">
          Slack connects per project: each one can bring its own workspace, and its mentions, DMs and thread replies land
          in the Inbox as they happen. Open a project's settings to connect it.
        </p>
        {legacy && legacy.state !== 'off' && (
          <div className="ib-faint text-[12.5px]">
            {legacy.team} is connected without a project. Open the project it belongs to and choose “Use the {legacy.team} connection”.
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          {projects.length === 0 && <div className="ib-faint">Create a project first, from the project switcher.</div>}
          {projects.map(p => {
            const st = connections[p.id];
            return (
              <div key={p.id} className="ib-proj-row">
                <span className="font-medium">{p.name}</span>
                <span className="ib-faint text-[12px] truncate">
                  {st ? (st.state === 'connected' ? `${st.team} · ${st.user}` : st.state === 'error' ? `Error: ${st.error}` : 'Connecting…') : 'Not connected'}
                </span>
                <button type="button" className="ib-btn ml-auto" onClick={() => onEditProject(p.id)}>
                  {st ? 'Settings' : 'Connect'}
                </button>
              </div>
            );
          })}
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
