import { useState, useEffect, useCallback } from 'react';
import { Markdown } from './Markdown';
import { resolveServerUrl } from '../lib/claude-client';

interface PRInfo {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  state: string;
}

interface PRFullData {
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
  mergeable: string;
}

export type { PRInfo };

const STATE_COLORS: Record<string, string> = {
  OPEN: 'bg-green-500',
  MERGED: 'bg-violet-500',
  CLOSED: 'bg-zinc-600',
};

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

export function PRDetail({ pr, cwd, onClose }: { pr: PRInfo; cwd?: string; onClose: () => void }) {
  const [data, setData] = useState<PRFullData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'detail' | 'commits' | 'reviews'>('detail');

  const fetchPR = useCallback(() => {
    setLoading(true);
    resolveServerUrl().then(base => {
      const params = new URLSearchParams({ number: String(pr.number) });
      if (cwd) params.set('cwd', cwd);
      fetch(`${base}/pr-detail?${params}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d && !d.error) setData(d); })
        .catch(() => {})
        .finally(() => setLoading(false));
    });
  }, [pr.number, cwd]);

  useEffect(() => {
    setData(null);
    setActiveTab('detail');
    fetchPR();
  }, [fetchPR]);

  const detail = data;

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1 border-b border-border shrink-0 bg-surface">
        <div className="flex items-center gap-2 truncate cursor-default">
          <span className={`text-[9px] font-mono font-medium px-1.5 py-0.5 rounded text-white ${STATE_COLORS[pr.state] || 'bg-green-500'}`}>
            #{pr.number}
          </span>
          <span className="text-[12px] text-zinc-300 truncate">{pr.title}</span>
          {loading && <span className="w-3 h-3 border border-zinc-600 border-t-zinc-300 rounded-full animate-spin shrink-0" />}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button className="text-zinc-500 hover:text-zinc-200 transition-colors px-1" onClick={fetchPR} disabled={loading} title="Reload">
            <svg className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-3.36-7H14" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M21 3v5h-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button className="text-zinc-500 hover:text-zinc-200 text-sm px-1" onClick={onClose}>×</button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border px-3 shrink-0">
        {(['detail', 'commits', 'reviews'] as const).map(tab => (
          <button
            key={tab}
            className={`text-[11px] px-3 py-1.5 border-b-2 transition-colors capitalize ${
              activeTab === tab ? 'border-blue-500 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
            {tab === 'commits' && detail ? ` (${detail.commits?.length || 0})` : ''}
            {tab === 'reviews' && detail ? ` (${(detail.reviews?.length || 0) + (detail.comments?.length || 0)})` : ''}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {!detail && !loading && (
          <p className="text-[12px] text-zinc-600">Failed to load PR details.</p>
        )}

        {detail && activeTab === 'detail' && (
          <>
            {/* Title */}
            <h2 className="text-[14px] text-zinc-100 font-medium leading-snug mb-3">{detail.title}</h2>

            {/* State + stats row */}
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

            {/* Diff stats */}
            <div className="flex items-center gap-4 mb-4 text-[11px]">
              <span className="text-green-400">+{detail.additions}</span>
              <span className="text-red-400">-{detail.deletions}</span>
              <span className="text-zinc-500">{detail.changedFiles} file{detail.changedFiles !== 1 ? 's' : ''}</span>
              <span className="text-zinc-500">{detail.commits?.length || 0} commit{(detail.commits?.length || 0) !== 1 ? 's' : ''}</span>
            </div>

            {/* Metadata */}
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

            {/* Body */}
            {detail.body && (
              <Section title="Description">
                <Markdown text={detail.body} />
              </Section>
            )}

            {/* Review summary */}
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

            {/* Comments */}
            {detail.comments && detail.comments.length > 0 && (
              <Section title="Comments" count={detail.comments.length}>
                <div className="space-y-2">
                  {detail.comments.map((c, i) => (
                    <div key={i} className="border border-border rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-[11px] text-zinc-400 font-mono">@{c.author?.login}</span>
                        <span className="text-[10px] text-zinc-600 ml-auto">{timeAgo(c.createdAt)}</span>
                      </div>
                      <Markdown text={c.body} />
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Link to GitHub */}
            <a href={detail.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" /></svg>
              View on GitHub
            </a>
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

        {detail && activeTab === 'reviews' && (
          <div className="space-y-2">
            {(!detail.reviews || detail.reviews.length === 0) && (!detail.comments || detail.comments.length === 0) ? (
              <p className="text-[12px] text-zinc-600">No reviews or comments.</p>
            ) : (
              <>
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
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
