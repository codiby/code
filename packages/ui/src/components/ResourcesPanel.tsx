import { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutGrid, X, Trash2, FileText, Code2 } from 'lucide-react';
import type { ClaudeClient, SessionResource } from '../lib/claude-client';
import { FullscreenPreview } from './FullscreenPreview';
import { humanSize, resourceToPreviewItem, type Gallery } from '../lib/preview';

interface Props {
  open: boolean;
  onClose: () => void;
  client: ClaudeClient | null;
  sessionId: string | null;
  /** Bumped by the host on ws events (new image / mockup) to force a refetch. */
  refreshKey?: number;
}

type KindFilter = 'all' | 'image' | 'mockup' | 'file';

const FILTERS: { key: KindFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'image', label: 'Images' },
  { key: 'mockup', label: 'Mockups' },
  { key: 'file', label: 'Files' },
];

/** A resource whose kind isn't image/mockup falls under the "Files" tab. */
function inFilter(r: SessionResource, f: KindFilter): boolean {
  if (f === 'all') return true;
  if (f === 'file') return r.kind !== 'image' && r.kind !== 'mockup';
  return r.kind === f;
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Right-side drawer listing everything a session accumulated that isn't chat —
 * pasted images, generated mockups, uploaded files. Opened from the Resources
 * chip in the chat header.
 */
export function ResourcesPanel({ open, onClose, client, sessionId, refreshKey = 0 }: Props) {
  const [items, setItems] = useState<SessionResource[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<KindFilter>('all');
  // The open item is tracked by id, not by value: the gallery handed to the
  // previewer is derived from the list on show, so deleting the open resource
  // (or filtering it away) closes the previewer instead of stranding it on a
  // stale copy.
  const [previewId, setPreviewId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client || !sessionId) { setItems([]); return; }
    setLoading(true);
    const res = await client.listResources(sessionId);
    setItems(res);
    setLoading(false);
  }, [client, sessionId]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load, refreshKey]);

  // Escape closes the previewer first, then the drawer. (The previewer has its
  // own Escape handler; this one only keeps the drawer from closing under it.)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (previewId) setPreviewId(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, previewId]);

  const shown = useMemo(() => items.filter(r => inFilter(r, filter)), [items, filter]);

  const rawUrl = useCallback(
    (r: SessionResource) => (client && sessionId ? client.resourceRawUrl(sessionId, r.id) : ''),
    [client, sessionId],
  );

  // Everything currently listed becomes the previewer's filmstrip, so opening
  // one resource lets you walk the whole drawer — images, PDFs and mockups
  // alike — without coming back out.
  const gallery = useMemo<Gallery | null>(() => {
    if (!previewId) return null;
    const index = shown.findIndex(r => r.id === previewId);
    if (index < 0) return null;
    return { items: shown.map(r => resourceToPreviewItem(r, rawUrl(r))), index };
  }, [previewId, shown, rawUrl]);

  const del = useCallback(async (r: SessionResource, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!client || !sessionId) return;
    if (!window.confirm(`Delete “${r.name}”? This removes it from disk.`)) return;
    setItems(prev => prev.filter(x => x.id !== r.id));
    await client.deleteResource(sessionId, r.id);
  }, [client, sessionId]);

  if (!open) return null;

  return (
    <div className="h-full w-[440px] shrink-0 flex flex-col bg-surface border-l border-border">
      {/* Header */}
      <div className="flex items-center gap-2.5 h-12 px-3 pl-4 border-b border-border shrink-0">
        <LayoutGrid size={16} className="text-violet-300" />
        <span className="text-[13px] font-semibold text-zinc-100">Resources</span>
        <span className="text-[11px] text-zinc-600 ml-auto">{items.length} {items.length === 1 ? 'item' : 'items'}</span>
        <button
          type="button" onClick={onClose} aria-label="Close resources"
          className="w-7 h-7 rounded-md flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-surface-lighter"
        >
          <X size={15} />
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-1.5 px-4 py-3 border-b border-border shrink-0">
        {FILTERS.map(f => {
          const count = f.key === 'all' ? items.length : items.filter(r => inFilter(r, f.key)).length;
          return (
            <button
              key={f.key} type="button" onClick={() => setFilter(f.key)}
              className={`text-[11.5px] px-2.5 py-1 rounded-md border transition-colors ${
                filter === f.key ? 'bg-surface-lighter text-zinc-200 border-border-light' : 'text-zinc-500 border-transparent hover:text-zinc-300'
              }`}
            >
              {f.label}{count > 0 && <span className="ml-1.5 text-[10px] text-zinc-600">{count}</span>}
            </button>
          );
        })}
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading && <div className="text-[12px] text-zinc-600 px-1 py-2">Loading…</div>}
        {!loading && shown.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-2 text-zinc-600">
            <LayoutGrid size={26} className="opacity-40" />
            <div className="text-[12px]">No resources yet.</div>
            <div className="text-[11px] max-w-[220px] leading-snug">Images you share and mockups the agent generates show up here.</div>
          </div>
        )}
        {!loading && shown.length > 0 && (
          <div className="grid grid-cols-2 gap-3.5">
            {shown.map(r => (
              <ResourceCard key={r.id} r={r} rawUrl={rawUrl(r)} onOpen={() => setPreviewId(r.id)} onDelete={(e) => del(r, e)} />
            ))}
          </div>
        )}
      </div>

      {/* Same fullscreen previewer the chat uses for its images. */}
      <FullscreenPreview
        gallery={gallery}
        onIndexChange={(i) => setPreviewId(shown[i]?.id ?? null)}
        onClose={() => setPreviewId(null)}
      />
    </div>
  );
}

function ResourceCard({ r, rawUrl, onOpen, onDelete }: {
  r: SessionResource; rawUrl: string; onOpen: () => void; onDelete: (e: React.MouseEvent) => void;
}) {
  const isImage = r.kind === 'image';
  const isMockup = r.kind === 'mockup';
  const tagColor = isImage ? 'text-sky-300' : isMockup ? 'text-violet-300' : 'text-amber-300';

  return (
    <div
      onClick={onOpen}
      className="group relative rounded-xl overflow-hidden bg-surface-light border border-border hover:border-border-light hover:-translate-y-0.5 transition-all cursor-pointer"
    >
      <div className="h-[120px] relative flex items-center justify-center bg-base">
        {isImage ? (
          <img src={rawUrl} alt={r.name} loading="lazy" className="h-full w-full object-cover" />
        ) : isMockup ? (
          <LayoutGrid size={38} className="text-violet-400/60" strokeWidth={1.4} />
        ) : r.kind === 'snippet' ? (
          <Code2 size={36} className="text-teal-300/60" strokeWidth={1.4} />
        ) : (
          <FileText size={34} className="text-amber-300/70" strokeWidth={1.5} />
        )}
        <span className={`absolute bottom-2 left-2 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-black/55 backdrop-blur-sm ${tagColor}`}>
          {r.ext || r.kind}
        </span>
        <button
          type="button" title="Delete" onClick={onDelete}
          className="absolute top-2 right-2 w-[26px] h-[26px] rounded-md flex items-center justify-center bg-black/60 backdrop-blur-sm border border-border text-zinc-400 opacity-0 group-hover:opacity-100 hover:!text-rose-400 transition-opacity"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <div className="px-2.5 py-2.5">
        <div className="text-[12px] font-semibold text-zinc-200 truncate" title={r.name}>{r.name}</div>
        <div className="text-[10.5px] text-zinc-600 mt-0.5">{humanSize(r.size)} · {timeAgo(r.createdAt)}</div>
      </div>
    </div>
  );
}
