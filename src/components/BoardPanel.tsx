import { useState, useEffect, useCallback } from 'react';
import { resolveServerUrl } from '../lib/claude-client';

interface BoardItem {
  id: string;
  humanId: string;
  title: string;
  column: string;
  columnEnteredAt: string;
  engineerUsername: string;
  priority: string | null;
  sizing: string;
  progress: number;
  boardName: string;
  labels: string[];
  ticketSlug: string | null;
  dueDate: string | null;
  assignments: { column: string; githubUsername: string; avatarUrl: string }[];
  createdAt: string;
  updatedAt: string;
}

export type { BoardItem };

const COLUMN_ORDER = ['todo', 'in_progress', 'code_review', 'qa_testing', 'uat', 'done'];
const COLUMN_LABELS: Record<string, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  code_review: 'Code Review',
  qa_testing: 'QA Testing',
  uat: 'UAT',
  done: 'Done',
};
const COLUMN_COLORS: Record<string, string> = {
  todo: 'text-zinc-500',
  in_progress: 'text-blue-400',
  code_review: 'text-violet-400',
  qa_testing: 'text-amber-400',
  uat: 'text-orange-400',
  done: 'text-green-400',
};
const COLUMN_DOTS: Record<string, string> = {
  todo: 'bg-zinc-500',
  in_progress: 'bg-blue-400',
  code_review: 'bg-violet-400',
  qa_testing: 'bg-amber-400',
  uat: 'bg-orange-400',
  done: 'bg-green-400',
};

export function BoardPanel({ onClose, onOpenTicket, onNewSession }: {
  onClose: () => void;
  onOpenTicket: (item: BoardItem) => void;
  onNewSession: (linkedTicket?: BoardItem) => void;
}) {
  const [items, setItems] = useState<BoardItem[]>([]);
  const [username, setUsername] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [collapsedColumns, setCollapsedColumns] = useState<Set<string>>(new Set(['done']));
  const [menuItemId, setMenuItemId] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<'engineer' | 'code_review' | 'qa_testing' | 'uat' | 'all'>('engineer');

  useEffect(() => { resolveServerUrl().then(setServerUrl); }, []);

  // Close menu on outside click
  useEffect(() => {
    if (!menuItemId) return;
    const handler = () => setMenuItemId(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [menuItemId]);

  const [refreshing, setRefreshing] = useState(false);

  const fetchItems = useCallback(async (showLoading = false) => {
    if (!serverUrl) return;
    if (showLoading) setLoading(true);
    setRefreshing(true);
    try {
      const res = await fetch(`${serverUrl}/architect/my-items`);
      if (!res.ok) throw new Error('Not logged in');
      const data = await res.json();
      setItems(data.items);
      setUsername(data.username);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [serverUrl]);

  useEffect(() => { fetchItems(true); }, [fetchItems]);

  // Auto-refresh every 60s
  useEffect(() => {
    if (!serverUrl) return;
    const id = setInterval(() => fetchItems(), 60_000);
    return () => clearInterval(id);
  }, [serverUrl, fetchItems]);

  const toggleColumn = (col: string) => {
    setCollapsedColumns(prev => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  };

  // Filter items by role
  const filtered = items.filter(item => {
    if (roleFilter === 'all') return true;
    if (roleFilter === 'engineer') return item.engineerUsername === username;
    return item.assignments?.some(a => a.column === roleFilter && a.githubUsername === username);
  });

  // Group items by column
  const grouped = COLUMN_ORDER.reduce((acc, col) => {
    acc[col] = filtered.filter(i => i.column === col);
    return acc;
  }, {} as Record<string, BoardItem[]>);

  return (
    <div className="h-full flex flex-col bg-surface border-r border-border" style={{ width: 280 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-9 border-b border-border shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">My Board</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => fetchItems()}
            disabled={refreshing}
            className="text-zinc-600 hover:text-zinc-300 transition-colors disabled:opacity-50"
            title="Refresh"
          >
            <svg className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-3.36-7H14" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M21 3v5h-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300 text-sm">×</button>
        </div>
      </div>

      {/* Role filter */}
      {!loading && !error && items.length > 0 && (
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border shrink-0 overflow-x-auto">
          {([
            ['engineer', 'Engineer'],
            ['code_review', 'Review'],
            ['qa_testing', 'QA'],
            ['uat', 'UAT'],
            ['all', 'All'],
          ] as const).map(([value, label]) => {
            const count = value === 'all'
              ? items.length
              : value === 'engineer'
                ? items.filter(i => i.engineerUsername === username).length
                : items.filter(i => i.assignments?.some(a => a.column === value && a.githubUsername === username)).length;
            return (
              <button
                key={value}
                className={`relative text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap transition-colors ${
                  roleFilter === value
                    ? 'bg-zinc-700 text-zinc-200'
                    : 'text-zinc-600 hover:text-zinc-400 hover:bg-surface-light'
                }`}
                onClick={() => setRoleFilter(value)}
              >
                {label}
                {count > 0 && (
                  <span className={`absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] flex items-center justify-center rounded-full text-[8px] font-bold leading-none px-0.5 ${
                    roleFilter === value ? 'bg-zinc-500 text-zinc-100' : 'bg-zinc-700 text-zinc-400'
                  }`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-3 text-[12px] text-zinc-600">Loading...</div>
        ) : error ? (
          <div className="p-3 text-[12px] text-zinc-500">Sign in to The Architect in Settings to view your board.</div>
        ) : filtered.length === 0 ? (
          <div className="p-3 text-[12px] text-zinc-500">{items.length === 0 ? 'No items assigned to you.' : 'No items for this role.'}</div>
        ) : (
          <div className="py-1">
            {COLUMN_ORDER.map(col => {
              const colItems = grouped[col];
              if (!colItems || colItems.length === 0) return null;
              const collapsed = collapsedColumns.has(col);

              return (
                <div key={col}>
                  <button
                    className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-surface-light/50 transition-colors"
                    onClick={() => toggleColumn(col)}
                  >
                    <span className="text-[10px] text-zinc-600">{collapsed ? '▸' : '▾'}</span>
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${COLUMN_DOTS[col] || 'bg-zinc-500'}`} />
                    <span className={`text-[11px] font-medium uppercase tracking-wider ${COLUMN_COLORS[col] || 'text-zinc-500'}`}>
                      {COLUMN_LABELS[col] || col}
                    </span>
                    <span className="text-[10px] text-zinc-600 ml-auto">{colItems.length}</span>
                  </button>
                  {!collapsed && (
                    <div className="px-2 pb-2 pt-1 space-y-1.5">
                      {colItems.map(item => (
                        <button
                          key={item.id}
                          className="w-full text-left p-2.5 rounded-lg bg-surface-light/60 border border-border hover:border-border-light hover:bg-surface-light transition-colors group"
                          onClick={() => onOpenTicket(item)}
                        >
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <span className={`text-[9px] font-mono font-medium px-1.5 py-0.5 rounded ${COLUMN_DOTS[col]?.replace('bg-', 'bg-') || 'bg-zinc-700'} text-white/90`}>
                              {item.humanId}
                            </span>
                            {item.sizing && (
                              <span className="text-[9px] text-zinc-600 font-medium uppercase ml-auto">{item.sizing}</span>
                            )}
                            <span className="relative ml-auto shrink-0">
                              <span
                                className="text-zinc-700 group-hover:text-zinc-500 hover:!text-zinc-300 transition-colors cursor-pointer"
                                onClick={(e) => { e.stopPropagation(); setMenuItemId(menuItemId === item.id ? null : item.id); }}
                              >
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
                              </span>
                              {menuItemId === item.id && (
                                <div className="absolute right-0 top-5 z-50 w-44 py-1 bg-[#2a2a2a] border border-border-light rounded-lg shadow-xl" onClick={(e) => e.stopPropagation()}>
                                  <button
                                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-zinc-300 hover:bg-surface-light transition-colors text-left"
                                    onClick={() => { setMenuItemId(null); onNewSession(item); }}
                                  >
                                    <svg className="w-3.5 h-3.5 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 5v14M5 12h14" strokeLinecap="round" /></svg>
                                    New session
                                  </button>
                                </div>
                              )}
                            </span>
                          </div>
                          <div className="text-[12px] text-zinc-300 group-hover:text-zinc-100 leading-snug line-clamp-2">
                            {item.title}
                          </div>
                          {item.progress > 0 && (
                            <div className="mt-2 flex items-center gap-2">
                              <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${item.progress === 100 ? 'bg-green-400' : 'bg-blue-400'}`} style={{ width: `${item.progress}%` }} />
                              </div>
                              <span className="text-[9px] text-zinc-600">{item.progress}%</span>
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {username && (
        <div className="px-3 py-2 border-t border-border text-[10px] text-zinc-600">
          @{username}
        </div>
      )}
    </div>
  );
}
