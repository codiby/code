import { useEffect, useMemo, useState } from 'react';
import { GitPullRequest, SlidersHorizontal } from 'lucide-react';
import type { ClaudeClient, OverviewStats, SessionInfo } from '../lib/claude-client';
import { dotStateOf, SessionDot } from './TabBar';

/**
 * The Overview screen: what happened in the current project scope over the
 * last day / week / month. A KPI strip, tokens per day by provider, and the
 * sessions grouped by who has to move next.
 */

type Range = 1 | 7 | 30;
const RANGES: { days: Range; label: string }[] = [
  { days: 1, label: 'Today' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
];

interface Props {
  client: ClaudeClient | null;
  /** Sessions in scope (already narrowed to the selected project). */
  sessions: SessionInfo[];
  projectName: string;
  statuses: Record<string, string>;
  streaming: Record<string, boolean>;
  hasPermission: Record<string, boolean>;
  interrupted: Record<string, boolean>;
  turnComplete: Set<string>;
  awaitingReply: Set<string>;
  lastSentAt: Record<string, number>;
  onSelectSession: (id: string) => void;
}

const PROVIDERS = ['claude', 'codex', 'opencode'] as const;
const PROVIDER_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };

/** `claude-opus-5-5` → `Opus 5.5`; `gpt-5.2-codex` → `GPT-5.2 Codex`. */
export function modelLabel(id: string | null | undefined): string {
  if (!id) return '—';
  // CLI aliases (`opus`, `sonnet[1m]`) name a family, not a version.
  const alias = /^(opus|sonnet|haiku|fable)(\[1m\])?$/i.exec(id);
  if (alias) return `${alias[1]![0]!.toUpperCase()}${alias[1]!.slice(1).toLowerCase()}${alias[2] ? ' 1M' : ''}`;
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(id);
  if (claude) return `${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  return id.replace(/^gpt/i, 'GPT').replace(/-codex$/i, ' Codex').replace(/^[a-z]/, c => c.toUpperCase());
}

function age(ts: number | undefined, now: number): string {
  if (!ts) return '—';
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const int = (n: number) => n.toLocaleString('en-US');
const compact = (n: number) => n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

function Spark({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  const pts = data.length > 1
    ? data.map((v, i) => `${(i / (data.length - 1)) * 100},${20 - (v / max) * 18}`).join(' ')
    : '0,20 100,20';
  return (
    <svg className="ov-spark" viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Delta({ now, prev, format }: { now: number; prev: number; format: 'pct' | 'abs' }) {
  if (!prev && !now) return null;
  if (format === 'abs') {
    const d = now - prev;
    return <span className={`ov-delta ${d >= 0 ? 'up' : 'down'}`}>{d >= 0 ? '+' : '−'}{int(Math.abs(d))}</span>;
  }
  if (!prev) return <span className="ov-delta up">new</span>;
  const pct = Math.round(((now - prev) / prev) * 100);
  // More spend is the bad direction, so it reads red.
  return <span className={`ov-delta ${pct > 0 ? 'down' : 'up'}`}>{pct > 0 ? '+' : '−'}{Math.abs(pct)}%</span>;
}

function UsageChart({ stats }: { stats: OverviewStats }) {
  const W = 1000, H = 150, L = 44, TOP = 10;
  const n = stats.days.length;
  const series = PROVIDERS.map(p => stats.tokensByProvider[p] ?? stats.days.map(() => 0));
  const totals = stats.days.map((_, i) => series.reduce((a, s) => a + (s[i] ?? 0), 0));
  const rawMax = Math.max(1, ...totals);
  // A round axis: 1, 2 or 5 × 10^k, in three steps.
  const step = (() => {
    const t = rawMax / 3;
    const p = 10 ** Math.floor(Math.log10(t));
    return [1, 2, 5, 10].map(m => m * p).find(v => v >= t)!;
  })();
  const max = step * 3;
  const slot = (W - L) / n;
  const bw = Math.min(56, slot * 0.6);
  const label = (key: string, i: number) => {
    if (i === n - 1) return 'Today';
    const d = new Date(`${key}T12:00:00`);
    return n > 14 ? String(d.getDate()) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  return (
    <svg viewBox={`0 0 ${W} 190`} width="100%" className="ov-chart" role="img" aria-label="Tokens per day by provider">
      {[0, 1, 2, 3].map(k => {
        const y = TOP + H - (k / 3) * H;
        return (
          <g key={k}>
            <line x1={L} x2={W} y1={y} y2={y} className={k ? 'grid' : 'grid0'} />
            <text x={L - 10} y={y + 4} textAnchor="end" className="axis">{k ? compact(step * k) : '0'}</text>
          </g>
        );
      })}
      {stats.days.map((key, i) => {
        const x = L + i * slot + (slot - bw) / 2;
        let y = TOP + H;
        const today = i === n - 1;
        return (
          <g key={key}>
            {series.map((s, j) => {
              const h = ((s[i] ?? 0) / max) * H;
              if (h <= 0) return null;
              y -= h;
              return <rect key={j} x={x} y={y + (j ? 1 : 0)} width={bw} height={Math.max(0, h - (j ? 1 : 0))} rx={2} className={`${today ? 't' : 'c'}${j + 1}`} />;
            })}
            {(n <= 14 || i % 2 === n % 2 || today) && (
              <text x={x + bw / 2} y={182} textAnchor="middle" className={today ? 'day today' : 'day'}>{label(key, i)}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function Overview(props: Props) {
  const { client, sessions, projectName, statuses, streaming, hasPermission, interrupted, turnComplete, awaitingReply, lastSentAt, onSelectSession } = props;
  const [days, setDays] = useState<Range>(7);
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const ids = useMemo(() => sessions.map(s => s.id).sort().join(','), [sessions]);
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const load = () => client.getOverview(ids ? ids.split(',') : [], days).then(r => {
      if (cancelled) return;
      setStats(r); setLoaded(true); setNow(Date.now());
    });
    void load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [client, ids, days]);

  // Who has to move next — the sidebar's status buckets, in table form.
  const groups = useMemo(() => {
    const waiting: SessionInfo[] = [], running: SessionInfo[] = [], done: SessionInfo[] = [];
    for (const s of sessions) {
      const st = dotStateOf(s.runtime_status, statuses[s.id] || 'disconnected', !!streaming[s.id],
        turnComplete.has(s.id), !!interrupted[s.id], !!hasPermission[s.id]);
      if (st === 'working' || st === 'starting') running.push(s);
      else if (st === 'waiting' || st === 'error' || awaitingReply.has(s.id)) waiting.push(s);
      else done.push(s);
    }
    const byRecent = (a: SessionInfo, b: SessionInfo) => (lastSentAt[b.id] || b.updated_at) - (lastSentAt[a.id] || a.updated_at);
    return [
      { key: 'waiting', label: 'Waiting on you', rows: waiting.sort(byRecent) },
      { key: 'running', label: 'Running', rows: running.sort(byRecent) },
      { key: 'done', label: 'Done', rows: done.sort(byRecent).slice(0, 8) },
    ].filter(g => g.rows.length);
  }, [sessions, statuses, streaming, hasPermission, interrupted, turnComplete, awaitingReply, lastSentAt]);

  const shown = groups.reduce((n, g) => n + g.rows.length, 0);
  const dateLine = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  return (
    <div className="overview flex-1 min-h-0 overflow-y-auto">
      <div className="ov-wrap">
        <div className="ov-head">
          <div>
            <h1>Overview</h1>
            <p>{dateLine} · {projectName}</p>
          </div>
          <div className="ov-seg" role="tablist">
            {RANGES.map(r => (
              <button key={r.days} type="button" role="tab" aria-selected={days === r.days}
                className={days === r.days ? 'on' : ''} onClick={() => setDays(r.days)}>
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="ov-kpis">
          <div className="ov-kpi">
            <div className="l">Sessions</div>
            <div className="v">{stats ? int(stats.sessions.active) : '—'} {stats && <Delta now={stats.sessions.active} prev={stats.sessions.previous} format="abs" />}</div>
            <Spark data={stats?.sessions.daily ?? []} />
          </div>
          <div className="ov-kpi">
            <div className="l">Spend</div>
            <div className="v">{stats ? money(stats.spend.total) : '—'} {stats && <Delta now={stats.spend.total} prev={stats.spend.previous} format="pct" />}</div>
            <Spark data={stats?.spend.daily ?? []} />
          </div>
          <div className="ov-kpi">
            <div className="l">Lines changed</div>
            <div className="v">{stats?.lines ? `+${int(stats.lines.additions)}` : '—'} {stats?.lines && <span className="ov-delta muted">−{int(stats.lines.deletions)}</span>}</div>
            <Spark data={stats?.lines?.daily ?? []} />
          </div>
          <div className="ov-kpi">
            <div className="l">PRs merged</div>
            <div className="v">{stats?.prs ? int(stats.prs.merged) : '—'} {stats?.prs && <span className="ov-delta muted">of {int(stats.prs.opened)} opened</span>}</div>
            <Spark data={stats?.prs?.daily ?? []} />
          </div>
        </div>

        <section className="ov-panel">
          <header>
            <h2>Usage</h2><span className="c">tokens per day</span>
            <div className="r">
              {PROVIDERS.map((p, j) => (
                <span key={p} className="lg"><i className={`c${j + 1}`} />{PROVIDER_LABEL[p]}</span>
              ))}
            </div>
          </header>
          <div className="ov-chart-wrap">
            {stats ? <UsageChart stats={stats} />
              : <div className="ov-empty">{loaded ? 'Usage needs a newer bridge — restart the server to load it.' : 'Loading…'}</div>}
          </div>
        </section>

        <section className="ov-panel">
          <header>
            <h2>Sessions</h2><span className="c">{shown}</span>
            <div className="r"><span>Group by status</span><SlidersHorizontal size={15} strokeWidth={1.6} /></div>
          </header>
          <table className="ov-table">
            <thead>
              <tr><th>Title</th><th>Branch</th><th>Model</th><th>Changes</th><th className="r">Updated</th></tr>
            </thead>
            <tbody>
              {groups.length === 0 && (
                <tr className="grp"><td colSpan={5}>No sessions in this project yet</td></tr>
              )}
              {groups.map(g => [
                <tr key={`g-${g.key}`} className="grp"><td colSpan={5}>{g.label} · {g.rows.length}</td></tr>,
                ...g.rows.map(s => {
                  const ps = stats?.perSession[s.id];
                  const ticket = /\b([A-Z]{2,6}-[A-Z]?\d+)\b/.exec(s.name)?.[1];
                  const title = ticket ? s.name.replace(ticket, '').trim() : s.name;
                  return (
                    <tr key={s.id} onClick={() => onSelectSession(s.id)}>
                      <td>
                        <div className="ttl">
                          <SessionDot rt={s.runtime_status} connStatus={statuses[s.id] || 'disconnected'} isStreaming={!!streaming[s.id]}
                            turnComplete={turnComplete.has(s.id)} wasInterrupted={!!interrupted[s.id]} hasPermission={!!hasPermission[s.id]} />
                          <span className="nm">{title}</span>
                          {ticket && <span className="tk">{ticket}</span>}
                          {hasPermission[s.id] && <span className="tag warn">Needs approval</span>}
                          {s.remoteName && <span className="tag">{s.remoteName}</span>}
                        </div>
                      </td>
                      <td className="br">{ps?.branch ?? (s.remoteId ? '—' : '')}</td>
                      <td className="mdl">{modelLabel(s.model || s.provider_default_model)}</td>
                      <td>
                        {ps && (ps.additions || ps.deletions)
                          ? <><span className="add">+{int(ps.additions)}</span><span className="del">−{int(ps.deletions)}</span></>
                          : <span className="muted">—</span>}
                      </td>
                      <td className="r muted">{age(lastSentAt[s.id] || s.updated_at, now)}</td>
                    </tr>
                  );
                }),
              ])}
            </tbody>
          </table>
        </section>

        {stats?.prs && stats.prs.opened > 0 && (
          <p className="ov-foot"><GitPullRequest size={13} strokeWidth={1.6} /> PRs and lines count your own work in the repos these sessions run in.</p>
        )}
      </div>
    </div>
  );
}
