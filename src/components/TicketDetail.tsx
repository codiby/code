import { useState, useEffect } from 'react';
import type { BoardItem } from './BoardPanel';
import { Markdown } from './Markdown';

const COLUMN_LABELS: Record<string, string> = {
  blocked: 'Blocked', product_review: 'Product Review',
  todo: 'To Do', in_progress: 'In Progress', code_review: 'Code Review',
  qa_testing: 'QA Testing', uat: 'UAT', ready_to_release: 'Ready to Release', done: 'Deployed',
};
const COLUMN_COLORS: Record<string, string> = {
  blocked: 'bg-red-500', product_review: 'bg-pink-500',
  todo: 'bg-zinc-600', in_progress: 'bg-blue-500', code_review: 'bg-violet-500',
  qa_testing: 'bg-amber-500', uat: 'bg-orange-500', ready_to_release: 'bg-teal-500', done: 'bg-green-500',
};
const PIPELINE_ORDER = ['product_review', 'blocked', 'todo', 'in_progress', 'code_review', 'qa_testing', 'uat', 'ready_to_release', 'done'];
const SIZING_LABELS: Record<string, string> = { xs: 'XS', s: 'S', m: 'M', l: 'L', xl: 'XL' };

interface ChecklistItem {
  id: string;
  label: string;
  completed: boolean;
  completedBy: string | null;
  completedAt: string | null;
  sortOrder: number;
}

interface Comment {
  id: string;
  body: string;
  authorUsername: string;
  authorAvatarUrl?: string;
  createdAt: string;
}

interface Activity {
  id: string;
  type: string;
  data: Record<string, any>;
  createdAt: string;
}

interface FullItemData {
  item: BoardItem & {
    problemStatement?: string;
    intent?: string;
    description?: string;
    activeTimeMs?: number;
    approvalStatus?: string;
    approvalReviewers?: { username: string; status: string }[];
    chain?: any[];
  };
  comments: Comment[];
  checklist: ChecklistItem[];
  activity: Activity[];
}

async function resolveServerUrl(): Promise<string> {
  if ((window as any).__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import(/* @vite-ignore */ '@tauri-apps/api/core');
      const port = await invoke<number>('get_bridge_port');
      return `http://localhost:${port}`;
    } catch {}
  }
  return (import.meta as any).env?.PUBLIC_CLAUDE_SERVER_URL || 'http://localhost:3100';
}

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

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
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

export function TicketDetail({ item, onClose, onItemUpdated }: { item: BoardItem; onClose: () => void; onItemUpdated?: (item: BoardItem) => void }) {
  const [fullData, setFullData] = useState<FullItemData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'detail' | 'activity'>('detail');
  const [updating, setUpdating] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setFullData(null);
    setActiveTab('detail');
    resolveServerUrl().then(base =>
      fetch(`${base}/architect/items/${item.id}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data) setFullData(data); })
        .catch(() => {})
        .finally(() => setLoading(false))
    );
  }, [item.id]);

  const detail = fullData?.item || item;
  const checklist = fullData?.checklist || [];
  const comments = fullData?.comments || [];
  const activity = fullData?.activity || [];
  const completedCount = checklist.filter(c => c.completed).length;

  const handleStatusChange = async (newColumn: string) => {
    if (newColumn === detail.column || updating) return;
    setUpdating(true);
    setStatusError(null);
    try {
      const base = await resolveServerUrl();
      const res = await fetch(`${base}/architect/items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column: newColumn }),
      });
      const data = await res.json();
      if (res.ok) {
        if (fullData) {
          setFullData({ ...fullData, item: { ...fullData.item, column: newColumn, ...data } });
        }
        if (onItemUpdated) onItemUpdated({ ...detail, column: newColumn } as BoardItem);
      } else {
        setStatusError(data.error || 'Failed to update status');
      }
    } catch (e) {
      setStatusError(String(e));
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1 border-b border-border shrink-0 bg-surface">
        <div className="flex items-center gap-2 truncate cursor-default">
          <span className="text-[9px] font-mono font-medium px-1.5 py-0.5 rounded bg-blue-500 text-white">{item.humanId}</span>
          <span className="text-[12px] text-zinc-300 truncate">{item.title}</span>
          {loading && <span className="w-3 h-3 border border-zinc-600 border-t-zinc-300 rounded-full animate-spin shrink-0" />}
        </div>
        <button className="text-zinc-500 hover:text-zinc-200 text-sm px-1" onClick={onClose}>×</button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border px-3 shrink-0">
        {(['detail', 'activity'] as const).map(tab => (
          <button
            key={tab}
            className={`text-[11px] px-3 py-1.5 border-b-2 transition-colors capitalize ${
              activeTab === tab ? 'border-blue-500 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}{tab === 'activity' && activity.length > 0 ? ` (${activity.length})` : ''}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'detail' ? (
          <>
            {/* Title */}
            <h2 className="text-[14px] text-zinc-100 font-medium leading-snug mb-3">{detail.title}</h2>

            {/* Status pipeline */}
            <div className="flex items-center gap-0.5 mb-4 overflow-x-auto">
              {PIPELINE_ORDER.map(col => {
                const isCurrent = detail.column === col;
                const currentIdx = PIPELINE_ORDER.indexOf(detail.column);
                const colIdx = PIPELINE_ORDER.indexOf(col);
                const isPast = colIdx < currentIdx;
                return (
                  <button
                    key={col}
                    disabled={updating || isCurrent}
                    onClick={() => handleStatusChange(col)}
                    className={`text-[8px] px-1.5 py-0.5 rounded-sm whitespace-nowrap font-medium transition-colors ${
                      isCurrent ? `${COLUMN_COLORS[col] || 'bg-zinc-600'} text-white ring-1 ring-white/20` :
                      isPast ? 'bg-zinc-700/50 text-zinc-500 hover:bg-zinc-600/50 hover:text-zinc-300 cursor-pointer' :
                      'bg-zinc-800/50 text-zinc-700 hover:bg-zinc-700/50 hover:text-zinc-400 cursor-pointer'
                    } disabled:cursor-default`}
                    title={isCurrent ? `Current: ${COLUMN_LABELS[col]}` : `Move to ${COLUMN_LABELS[col]}`}
                  >
                    {COLUMN_LABELS[col]?.replace(/ /g, '\u00A0') || col}
                  </button>
                );
              })}
              {updating && <span className="w-3 h-3 border border-zinc-600 border-t-zinc-300 rounded-full animate-spin shrink-0 ml-1" />}
            </div>
            {statusError && (
              <div className="mb-3 text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-2.5 py-1.5 flex items-start gap-2">
                <svg className="w-3.5 h-3.5 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 9v4M12 17h.01" strokeLinecap="round" /><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
                <span>{statusError}</span>
              </div>
            )}

            {/* Progress + metadata row */}
            <div className="flex items-center gap-3 mb-4 flex-wrap">
              <div className="flex items-center gap-2 flex-1 min-w-[120px]">
                <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${detail.progress === 100 ? 'bg-green-400' : 'bg-blue-400'}`} style={{ width: `${Math.max(detail.progress, 2)}%` }} />
                </div>
                <span className="text-[10px] text-zinc-500">{detail.progress}%</span>
              </div>
              {detail.sizing && <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-medium">{SIZING_LABELS[detail.sizing] || detail.sizing}</span>}
              {(detail as any).activeTimeMs > 0 && <span className="text-[10px] text-zinc-600">{formatDuration((detail as any).activeTimeMs)}</span>}
            </div>

            {/* Metadata */}
            <div className="mb-5 border border-border rounded-lg p-3">
              <InfoRow label="Board">{detail.boardName}</InfoRow>
              <InfoRow label="Engineer">
                <div className="flex items-center gap-1.5">
                  {(detail as any).engineerAvatarUrl && <img src={(detail as any).engineerAvatarUrl} className="w-4 h-4 rounded-full" />}
                  <span className="font-mono">@{detail.engineerUsername}</span>
                </div>
              </InfoRow>
              {detail.priority && (
                <InfoRow label="Priority">
                  <span className={detail.priority === 'high' ? 'text-red-400' : detail.priority === 'medium' ? 'text-amber-400' : 'text-zinc-400'}>
                    {detail.priority.charAt(0).toUpperCase() + detail.priority.slice(1)}
                  </span>
                </InfoRow>
              )}
              {detail.dueDate && <InfoRow label="Due">{new Date(detail.dueDate).toLocaleDateString()}</InfoRow>}
              <InfoRow label="Updated">{timeAgo(detail.updatedAt)}</InfoRow>
              <InfoRow label="Created">{new Date(detail.createdAt).toLocaleDateString()}</InfoRow>
            </div>

            {/* Problem Statement */}
            {(detail as any).problemStatement && (
              <Section title="Problem">
                <Markdown text={(detail as any).problemStatement} />
              </Section>
            )}

            {/* Intent */}
            {(detail as any).intent && (
              <Section title="Intent">
                <Markdown text={(detail as any).intent} />
              </Section>
            )}

            {/* Description */}
            {(detail as any).description && (
              <Section title="Description">
                <Markdown text={(detail as any).description} />
              </Section>
            )}

            {/* Checklist */}
            {checklist.length > 0 && (
              <Section title="Acceptance Criteria" count={checklist.length}>
                <div className="flex items-center gap-2 mb-2">
                  <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${completedCount === checklist.length ? 'bg-green-400' : 'bg-blue-400'}`} style={{ width: `${(completedCount / checklist.length) * 100}%` }} />
                  </div>
                  <span className="text-[10px] text-zinc-500">{completedCount}/{checklist.length}</span>
                </div>
                <div className="space-y-1">
                  {checklist.sort((a, b) => a.sortOrder - b.sortOrder).map(c => (
                    <div key={c.id} className="flex items-start gap-2 py-1">
                      <span className={`mt-0.5 shrink-0 ${c.completed ? 'text-green-400' : 'text-zinc-700'}`}>
                        {c.completed ? (
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        ) : (
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /></svg>
                        )}
                      </span>
                      <span className={`text-[12px] leading-snug ${c.completed ? 'text-zinc-500 line-through' : 'text-zinc-300'}`}>{c.label}</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Assignments pipeline */}
            {detail.assignments.length > 0 && (
              <Section title="Assignments">
                <div className="space-y-1">
                  {detail.assignments.map((a, i) => (
                    <div key={i} className="flex items-center gap-2.5 py-1">
                      <img src={a.avatarUrl} alt="" className="w-5 h-5 rounded-full" />
                      <span className="text-[12px] text-zinc-300 font-mono">@{a.githubUsername}</span>
                      <span className={`text-[9px] ml-auto px-1.5 py-0.5 rounded ${COLUMN_COLORS[a.column] || 'bg-zinc-700'} text-white/80`}>
                        {COLUMN_LABELS[a.column] || a.column}
                      </span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Comments */}
            {comments.length > 0 && (
              <Section title="Comments" count={comments.length}>
                <div className="space-y-2">
                  {comments.map(c => (
                    <div key={c.id} className="border border-border rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-2">
                        {c.authorAvatarUrl ? <img src={c.authorAvatarUrl} className="w-4 h-4 rounded-full" /> : <div className="w-4 h-4 rounded-full bg-zinc-700" />}
                        <span className="text-[11px] text-zinc-400 font-mono">@{c.authorUsername}</span>
                        <span className="text-[10px] text-zinc-600 ml-auto">{timeAgo(c.createdAt)}</span>
                      </div>
                      <Markdown text={c.body} />
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Ticket slug link */}
            {detail.ticketSlug && (
              <Section title="Source Ticket">
                <span className="text-[11px] text-zinc-400 font-mono break-all">{detail.ticketSlug}</span>
              </Section>
            )}
          </>
        ) : (
          /* Activity tab */
          <div className="space-y-0">
            {activity.length === 0 ? (
              <p className="text-[12px] text-zinc-600">No activity yet.</p>
            ) : activity.map(a => (
              <div key={a.id} className="flex items-start gap-2.5 py-2 border-b border-border/30">
                {a.data?.actorAvatar ? (
                  <img src={a.data.actorAvatar} className="w-5 h-5 rounded-full mt-0.5 shrink-0" />
                ) : (
                  <div className="w-5 h-5 rounded-full bg-zinc-700 mt-0.5 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] text-zinc-300 leading-snug">
                    <span className="font-mono text-zinc-400">{a.data?.actor || 'System'}</span>
                    {' '}
                    {a.type === 'assignment' && (
                      <>assigned <span className="font-mono text-zinc-200">{a.data.githubUsername}</span> to <span className={`text-[10px] px-1 py-0.5 rounded ${COLUMN_COLORS[a.data.column] || 'bg-zinc-700'} text-white/80`}>{COLUMN_LABELS[a.data.column] || a.data.column}</span></>
                    )}
                    {a.type === 'status_change' && (
                      <>moved to <span className={`text-[10px] px-1 py-0.5 rounded ${COLUMN_COLORS[a.data.column] || 'bg-zinc-700'} text-white/80`}>{COLUMN_LABELS[a.data.column] || a.data.column}</span></>
                    )}
                    {a.type === 'approval_requested' && (
                      <>requested review from <span className="font-mono text-zinc-200">{a.data.reviewers?.join(', ')}</span></>
                    )}
                    {a.type === 'comment' && 'commented'}
                    {!['assignment', 'status_change', 'approval_requested', 'comment'].includes(a.type) && (
                      <span className="text-zinc-500">{a.type.replace(/_/g, ' ')}</span>
                    )}
                  </p>
                  <p className="text-[10px] text-zinc-600 mt-0.5">{timeAgo(a.createdAt)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
