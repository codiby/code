/**
 * Agent view → Activity: approvals waiting for the owner (approve, deny,
 * always allow), then a timeline of every tool call the agent made and how
 * it was decided, filterable by category and decision.
 */

import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, ChevronRight, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_DECISIONS,
  DECISION_LABELS,
  agentPolicy,
  decidedViaText,
  shortToolName,
  toolInputView,
  type ActivityDecision,
  type ActivityItem,
  type PendingApproval,
} from '../../lib/agent/policy';
import { Button, Card, EmptyNote, ErrorNote, INPUT_BASE_CLASS, Pill, Section, Spinner, relativeTime, usePolled, type AgentSectionProps } from './ui';

type Api = AgentSectionProps['api'];
const PAGE = 50;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const DECISION_TONE: Record<ActivityDecision, 'zinc' | 'green' | 'amber' | 'red' | 'indigo'> = {
  auto_allowed: 'zinc',
  asked: 'amber',
  approved: 'green',
  denied: 'red',
  blocked: 'red',
  expired: 'zinc',
};

function categoryText(category: string): string {
  const [base, qualifier] = category.split(':');
  const label = ACTIVITY_CATEGORIES.find(c => c.value === base)?.label ?? base;
  return qualifier ? `${label} · ${qualifier.replace(/_/g, ' ')}` : label!;
}

/**
 * The `!` overrides beat the global, unlayered `pre` rule (13px, 12px
 * padding, surface background), which otherwise wins over utilities.
 */
const PRE_CLASS = '!m-0 !p-2.5 !bg-base !rounded-md !text-[11px] !leading-[1.55] font-mono text-zinc-300 border border-border whitespace-pre-wrap break-all overflow-y-auto';

function ToolInput({ raw }: { raw: string }) {
  const view = toolInputView(raw);
  if (view.kind === 'text') {
    return (
      <div>
        <pre className={`${PRE_CLASS} max-h-[260px]`}>{view.text}</pre>
        {view.truncated && <div className="text-[10.5px] text-zinc-600 mt-1">Shortened in the log.</div>}
      </div>
    );
  }
  return (
    <dl className="grid grid-cols-[minmax(80px,max-content)_1fr] gap-x-3 gap-y-1 bg-base border border-border rounded-md px-2.5 py-2 max-h-[260px] overflow-y-auto">
      {view.fields.map(([k, v], i) => (
        <div key={`${k}-${i}`} className="contents">
          <dt className="text-[11px] text-zinc-500 capitalize">{k}</dt>
          <dd className="text-[11.5px] text-zinc-300 font-mono whitespace-pre-wrap break-words min-w-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ActivitySection({ api, refreshKey, onOpenSession }: AgentSectionProps) {
  const approvals = usePolled(() => agentPolicy.approvals(api), [api, refreshKey], 4000);
  const [category, setCategory] = useState('');
  const [decision, setDecision] = useState<ActivityDecision | ''>('');
  const feed = usePolled(
    () => agentPolicy.activity(api, { limit: PAGE, category: category || undefined, decision: decision || undefined }),
    [api, refreshKey, category, decision],
    10_000,
  );
  const [older, setOlder] = useState<ActivityItem[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setOlder([]); setExhausted(false); }, [api, category, decision]);

  const items = useMemo(() => {
    const first = feed.data?.items ?? [];
    const seen = new Set(first.map(i => i.id));
    return [...first, ...older.filter(i => !seen.has(i.id))];
  }, [feed.data, older]);

  const loadMore = async () => {
    const last = items[items.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const page = await agentPolicy.activity(api, { limit: PAGE, before: last.createdAt, category: category || undefined, decision: decision || undefined });
      setOlder(prev => [...prev, ...page.items]);
      if (page.items.length < PAGE) setExhausted(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const pending = approvals.data?.approvals ?? [];
  const hasMore = !exhausted && (feed.data?.items.length ?? 0) >= PAGE;

  return (
    <>
      <Section title="Waiting for you" hint="Tool calls paused until you decide. You can also answer from your channels with the code.">
        {approvals.error && !approvals.data && <ErrorNote message={`Couldn't load approvals: ${approvals.error}`} onRetry={() => void approvals.reload()} />}
        {approvals.data && pending.length === 0 && <EmptyNote>Nothing is waiting for approval.</EmptyNote>}
        <div className="flex flex-col gap-2">
          {pending.map(a => (
            <ApprovalCard
              key={a.requestId}
              api={api}
              approval={a}
              onOpenSession={onOpenSession}
              onAnswered={async () => { await Promise.all([approvals.reload(), feed.reload()]); }}
            />
          ))}
        </div>
      </Section>

      <Section
        title="Timeline"
        hint="Every tool call the agent made, newest first. Inputs are shown with secrets redacted."
        action={
          <div className="flex items-center gap-1.5">
            <select aria-label="Filter by category" className={INPUT_BASE_CLASS} value={category} onChange={e => setCategory(e.target.value)}>
              <option value="">All categories</option>
              {ACTIVITY_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <select aria-label="Filter by decision" className={INPUT_BASE_CLASS} value={decision} onChange={e => setDecision(e.target.value as ActivityDecision | '')}>
              <option value="">All decisions</option>
              {ACTIVITY_DECISIONS.map(d => <option key={d} value={d}>{DECISION_LABELS[d]}</option>)}
            </select>
          </div>
        }
      >
        {error && <div className="mb-2"><ErrorNote message={error} /></div>}
        {feed.loading && !feed.data ? <Spinner /> : feed.error && !feed.data ? (
          <ErrorNote message={`Couldn't load activity: ${feed.error}`} onRetry={() => void feed.reload()} />
        ) : items.length === 0 ? (
          <EmptyNote>{category || decision ? 'Nothing matches these filters.' : 'No tool calls yet.'}</EmptyNote>
        ) : (
          <div className="flex flex-col gap-1">
            {items.map(item => <ActivityRow key={item.id} item={item} />)}
            {hasMore && (
              <div className="flex justify-center mt-2">
                <Button onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load older'}</Button>
              </div>
            )}
          </div>
        )}
      </Section>
    </>
  );
}

function ApprovalCard({ api, approval: a, onAnswered, onOpenSession }: {
  api: Api;
  approval: PendingApproval;
  onAnswered: () => Promise<void>;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (allow: boolean, always = false) => {
    if (always && !window.confirm(`Always allow ${shortToolName(a.toolName)} for exactly this ${a.target ? 'target' : 'tool'} from now on?`)) return;
    setBusy(true);
    setError(null);
    try {
      await agentPolicy.answer(api, a.requestId, { allow, always });
      await onAnswered();
    } catch (err) {
      setError(errorText(err));
      await onAnswered();
    } finally {
      setBusy(false);
    }
  };

  const showTarget = !!a.target && ['shell', 'destructive', 'credentials', 'write'].includes(a.category);

  return (
    <Card className="!border-amber-500/30 bg-amber-500/[0.04]">
      <div className="flex items-start gap-2.5">
        <ShieldAlert size={15} className="text-amber-300 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-semibold text-zinc-100">{a.title}</span>
            <Pill tone="amber">Code {a.code}</Pill>
            <span className="text-[11px] text-zinc-500 font-mono">{shortToolName(a.toolName)}</span>
          </div>
          <div className="text-[11px] text-zinc-500 mt-0.5">
            {a.sessionName} · asked {relativeTime(a.createdAt)}
            {a.expiresAt > 0 && <> · expires {relativeTime(a.expiresAt)}</>}
          </div>
          {showTarget ? (
            <div className="mt-2"><pre className={`${PRE_CLASS} max-h-[180px]`}>{a.target}</pre></div>
          ) : (
            <p className="mt-1.5 text-[12px] text-zinc-300 break-words">{a.summary}</p>
          )}
          {error && <div className="mt-2"><ErrorNote message={error} /></div>}
          <div className="flex items-center gap-2 mt-2.5 flex-wrap">
            <Button tone="primary" onClick={() => void answer(true)} disabled={busy}><Check size={12} /> Approve</Button>
            {a.canAlwaysAllow && (
              <Button onClick={() => void answer(true, true)} disabled={busy} title="Approve and add a rule that allows this exact call from now on">
                <ShieldCheck size={12} /> Always allow
              </Button>
            )}
            <Button tone="danger" onClick={() => void answer(false)} disabled={busy}><X size={12} /> Deny</Button>
            {onOpenSession && (
              <button type="button" onClick={() => onOpenSession(a.sessionId)} className="ml-auto text-[11.5px] text-zinc-400 hover:text-zinc-200 inline-flex items-center gap-1">
                Open chat <ArrowUpRight size={11} />
              </button>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  const via = decidedViaText(item.decidedVia);
  return (
    <div className="rounded-md border border-border bg-surface">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-surface-light/50 rounded-md">
        <Chevron size={12} className="text-zinc-600 mt-1 shrink-0" />
        <div className="w-[82px] shrink-0 pt-0.5"><Pill tone={DECISION_TONE[item.decision] ?? 'zinc'}>{DECISION_LABELS[item.decision] ?? item.decision}</Pill></div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] text-zinc-200 break-words line-clamp-2">{item.summary || shortToolName(item.toolName)}</div>
          <div className="text-[11px] text-zinc-500 mt-0.5 flex flex-wrap gap-x-2">
            <span className="font-mono">{shortToolName(item.toolName)}</span>
            <span>{categoryText(item.category)}</span>
            {via && <span>{via}</span>}
          </div>
        </div>
        <span className="text-[11px] text-zinc-500 shrink-0 pt-0.5" title={new Date(item.createdAt).toLocaleString()}>{relativeTime(item.createdAt)}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pl-[34px] text-[11.5px] text-zinc-400 space-y-1.5">
          {item.reason && <div><span className="text-zinc-600">Why: </span>{item.reason}</div>}
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-zinc-500">
            <span>Tool: <span className="font-mono text-zinc-400">{item.toolName}</span></span>
            {item.ruleId && <span>Rule: <span className="font-mono text-zinc-400">{item.ruleId}</span></span>}
            {item.decidedAt && item.decidedAt !== item.createdAt && <span>Decided {relativeTime(item.decidedAt)}</span>}
            {item.requestId && <span>Request: <span className="font-mono">{item.requestId.slice(0, 18)}</span></span>}
          </div>
          <ToolInput raw={item.input} />
        </div>
      )}
    </div>
  );
}
