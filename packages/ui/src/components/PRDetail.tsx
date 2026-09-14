import { useState, useEffect, useCallback, useMemo, memo } from 'react';
import { Button } from '@heroui/react';
import { Markdown } from './Markdown';
import { resolveServerUrl } from '../lib/claude-client';
import { highlightCode } from '../lib/highlight';
import { langForPath, parseUnifiedDiff, type DiffFile, type DiffRow } from '../lib/unified-diff';
import { mergeAvailability, type MergeMethod, type PrMergeInput } from '../lib/pr-merge';

interface PRInfo {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  state: string;
  /** Checkout the PR lives in. Set when the PR comes from a session's second
   *  repository, where the session's own cwd is the wrong place to run `gh`. */
  cwd?: string;
}

interface PRFullData extends PrMergeInput {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  state: string;
  url: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: { oid: string; messageHeadline: string; authoredDate: string; authors: { login: string }[] }[];
  reviews: { author: { login: string }; body: string; state: string; submittedAt: string }[];
  comments: { author: { login: string }; body: string; createdAt: string }[];
  labels: { name: string; color: string }[];
  author: { login: string };
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
}

/** A review thread as grouped by the server (handlers/pr.ts). */
type ReviewThread = {
  id: number;
  path: string;
  line: number | null;
  side: string | null;
  diffHunk: string;
  comments: { id: number; author: string; body: string; createdAt: string; url: string }[];
};

export type { PRInfo };

const STATE_COLORS: Record<string, string> = {
  OPEN: 'bg-green-500',
  MERGED: 'bg-violet-500',
  CLOSED: 'bg-zinc-600',
};

type TabId = 'detail' | 'files' | 'commits' | 'conversation';

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-[11px] text-zinc-600 w-20 shrink-0 pt-0.5">{label}</span>
      <div className="text-[12px] text-zinc-300 min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-2 flex items-center gap-2">
        {title}
        {count !== undefined && <span className="text-zinc-600 font-normal">({count})</span>}
      </h3>
      {children}
    </div>
  );
}

const REVIEW_STATE_COLORS: Record<string, string> = {
  APPROVED: 'text-green-400',
  CHANGES_REQUESTED: 'text-red-400',
  COMMENTED: 'text-zinc-400',
  PENDING: 'text-amber-400',
  DISMISSED: 'text-zinc-600',
};

// ---------------------------------------------------------------------------
// Comment composer — shared by the conversation tab and every review thread.
// ---------------------------------------------------------------------------

function CommentBox({ placeholder, submitLabel, onSubmit, onCancel, autoFocus }: {
  placeholder: string;
  submitLabel: string;
  onSubmit: (body: string) => Promise<string | null>;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    const err = await onSubmit(body);
    setBusy(false);
    if (err) setError(err);
    else setText('');
  };

  return (
    <div className="mt-2">
      <textarea
        autoFocus={autoFocus}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          // ⌘/Ctrl+Enter submits, matching GitHub's own comment box.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void send(); }
          if (e.key === 'Escape' && onCancel) onCancel();
        }}
        placeholder={placeholder}
        rows={3}
        className="w-full bg-surface border border-border rounded-lg px-2.5 py-2 text-[12px] text-zinc-200 placeholder:text-zinc-600 resize-y focus:outline-none focus:border-zinc-600"
      />
      {error && <p className="text-[11px] text-red-400 mt-1">{error}</p>}
      <div className="flex items-center gap-2 mt-1.5">
        <Button
          size="sm"
          className="text-[11px] h-7 px-3 bg-green-600/90 text-white data-[hover=true]:bg-green-600"
          isDisabled={!text.trim() || busy}
          onPress={() => void send()}
        >
          {busy ? 'Sending…' : submitLabel}
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" className="text-[11px] h-7 px-2 text-zinc-500" onPress={onCancel}>
            Cancel
          </Button>
        )}
        <span className="text-[10px] text-zinc-600 ml-auto">⌘↵ to send</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Merge control
// ---------------------------------------------------------------------------

const METHOD_LABEL: Record<MergeMethod, string> = {
  merge: 'Create a merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge',
};

function MergeBox({ detail, onMerge }: {
  detail: PRFullData;
  onMerge: (opts: { method: MergeMethod; deleteBranch: boolean; auto: boolean }) => Promise<string | null>;
}) {
  const availability = useMemo(() => mergeAvailability(detail), [detail]);
  const [method, setMethod] = useState<MergeMethod>(availability.methods[0] || 'squash');
  const [deleteBranch, setDeleteBranch] = useState(!!detail.repo?.deleteBranchOnMerge);
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // A PR that is already merged or closed has nothing to offer.
  if (availability.tone === 'done') return null;

  const useAuto = auto && availability.canAutoMerge;
  const enabled = (availability.canMerge || useAuto) && !busy;

  const run = async () => {
    setBusy(true);
    setError(null);
    const err = await onMerge({ method, deleteBranch, auto: useAuto });
    setBusy(false);
    setConfirming(false);
    if (err) setError(err);
  };

  const toneRing = availability.tone === 'ready' ? 'border-green-500/30 bg-green-500/[0.06]'
    : availability.tone === 'warn' ? 'border-amber-500/30 bg-amber-500/[0.06]'
    : 'border-red-500/25 bg-red-500/[0.05]';

  return (
    <div className={`mb-5 rounded-lg border p-3 ${toneRing}`}>
      <div className="flex items-start gap-2 mb-2.5">
        <span className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${
          availability.tone === 'ready' ? 'bg-green-400' : availability.tone === 'warn' ? 'bg-amber-400' : 'bg-red-400'
        }`} />
        <p className="text-[12px] text-zinc-200 leading-snug">{availability.reason}</p>
      </div>

      {availability.methods.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-2.5">
          {availability.methods.map(m => (
            <button
              key={m}
              onClick={() => setMethod(m)}
              className={`text-[11px] px-2 py-1 rounded border transition-colors ${
                method === m
                  ? 'border-zinc-500 bg-surface-light text-zinc-100'
                  : 'border-border text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {METHOD_LABEL[m]}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 mb-2.5">
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer">
          <input type="checkbox" checked={deleteBranch} onChange={e => setDeleteBranch(e.target.checked)} className="accent-green-500" />
          Delete branch
        </label>
        {/* Auto-merge is only meaningful while something is still pending —
            once it's mergeable now, queueing it would just add a round-trip. */}
        {!availability.canMerge && availability.canAutoMerge && (
          <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer">
            <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} className="accent-green-500" />
            Enable auto-merge
          </label>
        )}
      </div>

      {error && <p className="text-[11px] text-red-400 mb-2 whitespace-pre-wrap">{error}</p>}

      {confirming ? (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="text-[11px] h-7 px-3 bg-green-600 text-white data-[hover=true]:bg-green-500"
            isDisabled={busy}
            onPress={() => void run()}
          >
            {busy ? 'Merging…' : `Confirm ${method}`}
          </Button>
          <Button size="sm" variant="ghost" className="text-[11px] h-7 px-2 text-zinc-500" onPress={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          className={`text-[11px] h-7 px-3 ${enabled ? 'bg-green-600 text-white data-[hover=true]:bg-green-500' : 'bg-surface-light text-zinc-600'}`}
          isDisabled={!enabled}
          onPress={() => setConfirming(true)}
        >
          {useAuto ? 'Enable auto-merge' : `Merge pull request`}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diff rendering
// ---------------------------------------------------------------------------

const ROW_BG: Record<DiffRow['kind'], string> = {
  add: 'bg-green-500/[0.09]',
  del: 'bg-red-500/[0.09]',
  ctx: '',
  hunk: 'bg-surface-light',
};

const DiffLine = memo(function DiffLine({ row, lang }: { row: DiffRow; lang: string }) {
  if (row.kind === 'hunk') {
    return (
      <div className="flex text-[10.5px] font-mono text-zinc-500 bg-surface-light border-y border-border/60">
        <span className="w-[86px] shrink-0" />
        <span className="px-2 py-0.5 truncate">{row.text}</span>
      </div>
    );
  }
  const sigil = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ';
  return (
    <div className={`flex text-[11.5px] font-mono leading-[1.5] ${ROW_BG[row.kind]}`}>
      <span className="w-[43px] shrink-0 text-right pr-2 text-zinc-700 select-none tabular-nums">{row.oldLine ?? ''}</span>
      <span className="w-[43px] shrink-0 text-right pr-2 text-zinc-700 select-none tabular-nums">{row.newLine ?? ''}</span>
      <span className={`w-3 shrink-0 select-none ${row.kind === 'add' ? 'text-green-400' : row.kind === 'del' ? 'text-red-400' : 'text-zinc-700'}`}>{sigil}</span>
      <code
        className="flex-1 min-w-0 whitespace-pre-wrap break-words pr-3 text-zinc-300"
        dangerouslySetInnerHTML={{ __html: highlightCode(row.text, lang) }}
      />
    </div>
  );
});

function FileDiff({ file, threads, onReply }: {
  file: DiffFile;
  threads: ReviewThread[];
  onReply: (threadId: number, body: string) => Promise<string | null>;
}) {
  // Large files start collapsed — a 200-file PR should open instantly and let
  // the reader expand what they care about.
  const [open, setOpen] = useState(file.rows.length <= 400);
  const lang = useMemo(() => langForPath(file.path), [file.path]);
  // Threads anchored to a line we actually render, so a comment sits against
  // its code. Anything else falls to the bottom of the file.
  const byLine = useMemo(() => {
    const m = new Map<number, ReviewThread[]>();
    for (const t of threads) {
      if (t.line == null) continue;
      const list = m.get(t.line) || [];
      list.push(t);
      m.set(t.line, list);
    }
    return m;
  }, [threads]);
  const anchored = useMemo(() => {
    const rendered = new Set(file.rows.map(r => r.newLine).filter((n): n is number => n != null));
    return new Set(threads.filter(t => t.line != null && rendered.has(t.line)).map(t => t.id));
  }, [file.rows, threads]);
  const orphans = threads.filter(t => !anchored.has(t.id));

  return (
    <div className="border border-border rounded-lg mb-3 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-surface-light hover:bg-surface-lighter transition-colors text-left"
      >
        <span className={`text-zinc-600 text-[9px] transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        <span className="text-[11.5px] font-mono text-zinc-300 truncate flex-1 min-w-0">
          {file.status === 'renamed' ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        {threads.length > 0 && (
          <span className="text-[10px] text-blue-400 shrink-0">{threads.length} 💬</span>
        )}
        {file.status !== 'modified' && (
          <span className="text-[9.5px] uppercase tracking-wide text-zinc-600 shrink-0">{file.status}</span>
        )}
        <span className="text-[10.5px] text-green-400 shrink-0">+{file.additions}</span>
        <span className="text-[10.5px] text-red-400 shrink-0">-{file.deletions}</span>
      </button>

      {open && (
        <div className="overflow-x-auto">
          {file.binary ? (
            <p className="px-3 py-2 text-[11px] text-zinc-600">Binary file not shown.</p>
          ) : (
            file.rows.map((row, i) => (
              <div key={i}>
                <DiffLine row={row} lang={lang} />
                {row.newLine != null && byLine.get(row.newLine)?.map(t => (
                  <ThreadCard key={t.id} thread={t} onReply={onReply} />
                ))}
              </div>
            ))
          )}
          {orphans.length > 0 && (
            <div className="px-2 py-2 border-t border-border/60">
              <p className="text-[10px] text-zinc-600 mb-1.5">
                Comments on lines not in this diff (outdated by a later push):
              </p>
              {orphans.map(t => <ThreadCard key={t.id} thread={t} onReply={onReply} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ThreadCard({ thread, onReply }: {
  thread: ReviewThread;
  onReply: (threadId: number, body: string) => Promise<string | null>;
}) {
  const [replying, setReplying] = useState(false);
  return (
    <div className="mx-2 my-1.5 border border-blue-500/25 bg-blue-500/[0.04] rounded-lg p-2.5">
      {thread.comments.map(c => (
        <div key={c.id} className="mb-2 last:mb-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[11px] text-zinc-400 font-mono">@{c.author}</span>
            <span className="text-[10px] text-zinc-600 ml-auto">{timeAgo(c.createdAt)}</span>
          </div>
          <Markdown text={c.body} />
        </div>
      ))}
      {replying ? (
        <CommentBox
          autoFocus
          placeholder="Reply…"
          submitLabel="Reply"
          onCancel={() => setReplying(false)}
          onSubmit={async body => {
            const err = await onReply(thread.id, body);
            if (!err) setReplying(false);
            return err;
          }}
        />
      ) : (
        <button
          onClick={() => setReplying(true)}
          className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors mt-1"
        >
          Reply
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function PRDetail({ pr, cwd, onClose }: { pr: PRInfo; cwd?: string; onClose: () => void }) {
  const [data, setData] = useState<PRFullData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>('detail');
  const [diff, setDiff] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [banner, setBanner] = useState<string | null>(null);

  const api = useCallback(async (path: string, init?: RequestInit) => {
    const base = await resolveServerUrl();
    const res = await fetch(`${base}${path}`, init);
    const body = await res.json().catch(() => null);
    return { ok: res.ok, body } as { ok: boolean; body: any };
  }, []);

  const query = useCallback((extra: Record<string, string> = {}) => {
    const params = new URLSearchParams({ number: String(pr.number), ...extra });
    if (cwd) params.set('cwd', cwd);
    return params.toString();
  }, [pr.number, cwd]);

  const fetchPR = useCallback(() => {
    setLoading(true);
    void (async () => {
      const [detail, review] = await Promise.all([
        api(`/pr-detail?${query()}`),
        api(`/pr-review-threads?${query()}`),
      ]);
      if (detail.ok && detail.body && !detail.body.error) setData(detail.body);
      // Review threads are an enrichment: a repo that denies the REST call
      // still gets a working panel, just without inline comments.
      setThreads(review.ok && Array.isArray(review.body?.threads) ? review.body.threads : []);
      setLoading(false);
    })();
  }, [api, query]);

  useEffect(() => {
    setData(null);
    setDiff(null);
    setDiffError(null);
    setBanner(null);
    setActiveTab('detail');
    fetchPR();
  }, [fetchPR]);

  // The diff is the expensive call, so it waits until the Files tab is opened.
  useEffect(() => {
    if (activeTab !== 'files' || diff !== null || diffError) return;
    void (async () => {
      const res = await api(`/pr-diff?${query()}`);
      if (res.ok && typeof res.body?.diff === 'string') setDiff(res.body.diff);
      else setDiffError(res.body?.error || 'Could not load the diff.');
    })();
  }, [activeTab, diff, diffError, api, query]);

  const files = useMemo(() => (diff ? parseUnifiedDiff(diff) : []), [diff]);
  const threadsByPath = useMemo(() => {
    const m = new Map<string, ReviewThread[]>();
    for (const t of threads) {
      const list = m.get(t.path) || [];
      list.push(t);
      m.set(t.path, list);
    }
    return m;
  }, [threads]);

  const postComment = useCallback(async (body: string, replyTo?: number): Promise<string | null> => {
    const res = await api('/pr-comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: pr.number, cwd, body, replyTo: replyTo ?? null }),
    });
    if (!res.ok) return res.body?.error || 'Could not post the comment.';
    // Re-read so the new comment appears with the id and timestamp GitHub
    // assigned, rather than an optimistic local copy that could drift.
    fetchPR();
    return null;
  }, [api, pr.number, cwd, fetchPR]);

  const doMerge = useCallback(async (opts: { method: MergeMethod; deleteBranch: boolean; auto: boolean }): Promise<string | null> => {
    const res = await api('/pr-merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: pr.number, cwd, ...opts }),
    });
    if (!res.ok) return res.body?.error || 'Merge failed.';
    setBanner(opts.auto ? 'Auto-merge enabled — GitHub will merge once the checks pass.' : 'Merged.');
    fetchPR();
    return null;
  }, [api, pr.number, cwd, fetchPR]);

  const detail = data;
  const state = detail?.state || pr.state;

  return (
    /* `min-h-0` is what makes the body scroll: without it this flex child keeps
       its default `min-height: auto`, grows to its content, and the overflow
       container below never gets a bounded height to scroll inside. */
    <div className="flex-1 min-h-0 h-full flex flex-col min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1 border-b border-border shrink-0 bg-surface">
        <div className="flex items-center gap-2 truncate cursor-default">
          <span className={`text-[9px] font-mono font-medium px-1.5 py-0.5 rounded text-white ${STATE_COLORS[state] || 'bg-green-500'}`}>
            #{pr.number}
          </span>
          <span className="text-[12px] text-zinc-300 truncate">{detail?.title || pr.title}</span>
          {loading && <span className="w-3 h-3 border border-zinc-600 border-t-zinc-300 rounded-full animate-spin shrink-0" />}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button isIconOnly size="sm" variant="ghost" onPress={fetchPR} isDisabled={loading} aria-label="Reload">
            <svg className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-3.36-7H14" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M21 3v5h-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
          <Button isIconOnly size="sm" variant="ghost" onPress={onClose} aria-label="Close">
            <span className="text-sm">×</span>
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border px-3 shrink-0">
        {(['detail', 'files', 'commits', 'conversation'] as const).map(tab => (
          <Button
            key={tab}
            size="sm"
            variant="ghost"
            className={`text-[11px] px-3 py-1.5 h-auto rounded-none border-b-2 transition-colors capitalize ${
              activeTab === tab ? 'border-blue-500 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
            onPress={() => setActiveTab(tab)}
          >
            {tab}
            {tab === 'files' && detail ? ` (${detail.changedFiles || 0})` : ''}
            {tab === 'commits' && detail ? ` (${detail.commits?.length || 0})` : ''}
            {tab === 'conversation' && detail
              ? ` (${(detail.comments?.length || 0) + threads.length})`
              : ''}
          </Button>
        ))}
      </div>

      {banner && (
        <div className="px-3 py-1.5 text-[11px] text-green-400 bg-green-500/10 border-b border-green-500/20 shrink-0">
          {banner}
        </div>
      )}

      {/* Content — `min-h-0` again so this pane, not the page, is what scrolls. */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {!detail && !loading && (
          <p className="text-[12px] text-zinc-600">Failed to load PR details.</p>
        )}

        {detail && activeTab === 'detail' && (
          <>
            <h2 className="text-[14px] text-zinc-100 font-medium leading-snug mb-3">{detail.title}</h2>

            <div className="flex items-center gap-2 mb-4 flex-wrap">
              <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full text-white ${STATE_COLORS[detail.state] || 'bg-green-500'}`}>
                {detail.isDraft ? 'Draft' : detail.state}
              </span>
              <span className="text-[11px] font-mono text-zinc-500">{detail.headRefName}</span>
              <span className="text-[10px] text-zinc-600">→</span>
              <span className="text-[11px] font-mono text-zinc-500">{detail.baseRefName}</span>
              {detail.mergeable && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  detail.mergeable === 'MERGEABLE' ? 'bg-green-500/15 text-green-400' :
                  detail.mergeable === 'CONFLICTING' ? 'bg-red-500/15 text-red-400' : 'bg-zinc-700 text-zinc-400'
                }`}>{detail.mergeable.toLowerCase()}</span>
              )}
            </div>

            <MergeBox detail={detail} onMerge={doMerge} />

            <div className="flex items-center gap-4 mb-4 text-[11px]">
              <span className="text-green-400">+{detail.additions}</span>
              <span className="text-red-400">-{detail.deletions}</span>
              <span className="text-zinc-500">{detail.changedFiles} file{detail.changedFiles !== 1 ? 's' : ''}</span>
              <span className="text-zinc-500">{detail.commits?.length || 0} commit{(detail.commits?.length || 0) !== 1 ? 's' : ''}</span>
            </div>

            {detail.statusCheckRollup && detail.statusCheckRollup.length > 0 && (
              <Section title="Checks" count={detail.statusCheckRollup.length}>
                <div className="space-y-0.5">
                  {detail.statusCheckRollup.slice(0, 12).map((c: any, i: number) => {
                    const verdict = (c.conclusion || c.state || c.status || '').toUpperCase();
                    const color = ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(verdict) ? 'text-green-400'
                      : ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(verdict) ? 'text-red-400'
                      : 'text-amber-400';
                    return (
                      <div key={i} className="flex items-center gap-2 text-[11px] py-0.5">
                        <span className={color}>●</span>
                        <span className="text-zinc-400 truncate">{c.name || c.context || 'check'}</span>
                        <span className={`ml-auto text-[10px] ${color}`}>{verdict.toLowerCase().replace(/_/g, ' ')}</span>
                      </div>
                    );
                  })}
                </div>
              </Section>
            )}

            <div className="mb-5 border border-border rounded-lg p-3">
              <InfoRow label="Author"><span className="font-mono">@{detail.author?.login}</span></InfoRow>
              <InfoRow label="Created">{timeAgo(detail.createdAt)}</InfoRow>
              <InfoRow label="Updated">{timeAgo(detail.updatedAt)}</InfoRow>
              {detail.mergedAt && <InfoRow label="Merged">{timeAgo(detail.mergedAt)}</InfoRow>}
              {detail.labels?.length > 0 && (
                <InfoRow label="Labels">
                  <div className="flex flex-wrap gap-1">
                    {detail.labels.map(l => (
                      <span key={l.name} className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: `#${l.color}30`, color: `#${l.color}` }}>
                        {l.name}
                      </span>
                    ))}
                  </div>
                </InfoRow>
              )}
            </div>

            {detail.body && (
              <Section title="Description">
                <Markdown text={detail.body} />
              </Section>
            )}

            {detail.reviews && detail.reviews.length > 0 && (
              <Section title="Review Status">
                <div className="space-y-1">
                  {detail.reviews.map((r, i) => (
                    <div key={i} className="flex items-center gap-2 py-1">
                      <span className="text-[11px] font-mono text-zinc-300">@{r.author?.login}</span>
                      <span className={`text-[10px] font-medium ml-auto ${REVIEW_STATE_COLORS[r.state] || 'text-zinc-500'}`}>
                        {r.state.replace(/_/g, ' ').toLowerCase()}
                      </span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <a href={detail.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" /></svg>
              View on GitHub
            </a>
          </>
        )}

        {activeTab === 'files' && (
          <>
            {diffError && <p className="text-[12px] text-red-400">{diffError}</p>}
            {!diff && !diffError && <p className="text-[12px] text-zinc-600">Loading diff…</p>}
            {diff && files.length === 0 && <p className="text-[12px] text-zinc-600">No changes in this pull request.</p>}
            {files.map(f => (
              <FileDiff
                key={f.path}
                file={f}
                threads={threadsByPath.get(f.path) || []}
                onReply={(threadId, body) => postComment(body, threadId)}
              />
            ))}
          </>
        )}

        {detail && activeTab === 'commits' && (
          <div className="space-y-0">
            {(!detail.commits || detail.commits.length === 0) ? (
              <p className="text-[12px] text-zinc-600">No commits.</p>
            ) : detail.commits.map((c, i) => (
              <div key={c.oid || i} className="flex items-start gap-2.5 py-2 border-b border-border/30">
                <span className="text-[10px] font-mono text-zinc-600 shrink-0 mt-0.5">{c.oid?.slice(0, 7)}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] text-zinc-300 leading-snug">{c.messageHeadline}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    {c.authors?.[0]?.login && <span className="text-[10px] text-zinc-500 font-mono">@{c.authors[0].login}</span>}
                    <span className="text-[10px] text-zinc-600">{timeAgo(c.authoredDate)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {detail && activeTab === 'conversation' && (
          <div className="space-y-2">
            {detail.reviews?.filter(r => r.body).map((r, i) => (
              <div key={`review-${i}`} className="border border-border rounded-lg p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[11px] text-zinc-400 font-mono">@{r.author?.login}</span>
                  <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${REVIEW_STATE_COLORS[r.state] || 'text-zinc-500'} bg-zinc-800`}>
                    {r.state.replace(/_/g, ' ')}
                  </span>
                  <span className="text-[10px] text-zinc-600 ml-auto">{timeAgo(r.submittedAt)}</span>
                </div>
                <Markdown text={r.body} />
              </div>
            ))}
            {detail.comments?.map((c, i) => (
              <div key={`comment-${i}`} className="border border-border rounded-lg p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[11px] text-zinc-400 font-mono">@{c.author?.login}</span>
                  <span className="text-[10px] text-zinc-600 ml-auto">{timeAgo(c.createdAt)}</span>
                </div>
                <Markdown text={c.body} />
              </div>
            ))}

            {threads.length > 0 && (
              <Section title="Review threads" count={threads.length}>
                {threads.map(t => (
                  <div key={t.id} className="mb-2">
                    <p className="text-[10px] font-mono text-zinc-600 mb-1">
                      {t.path}{t.line != null ? `:${t.line}` : ''}
                    </p>
                    <ThreadCard thread={t} onReply={(id, body) => postComment(body, id)} />
                  </div>
                ))}
              </Section>
            )}

            <div className="pt-2 border-t border-border">
              <CommentBox
                placeholder="Leave a comment…"
                submitLabel="Comment"
                onSubmit={body => postComment(body)}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
