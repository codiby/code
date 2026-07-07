import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, Text, WrapText, Columns2, AlignJustify } from 'lucide-react';
import { Button } from '@heroui/react';
import type { ClaudeClient } from '../../lib/claude-client';
import { DiffView, diffCounts } from './DiffView';

interface Props {
  open: boolean;
  onClose: () => void;
  /** File-backed source: we fetch the HEAD blob and the working-tree file.
   *  Mutually exclusive with `textSource`. */
  client?: ClaudeClient;
  filePath?: string | null;
  /** File status hint — `untracked` skips the HEAD fetch (no original). */
  status?: 'modified' | 'staged' | 'untracked';
  /** Text-backed source: caller already has both sides (e.g. Edit tool's
   *  old_string vs new_string). Mutually exclusive with `client` + `filePath`. */
  textSource?: { original: string; current: string; title?: string };
}

/**
 * Fullscreen mobile diff viewer. Two source modes:
 *   • File-backed — fetches HEAD (via /file-original) + working-tree (via
 *     /file-content) and diffs them.
 *   • Text-backed — caller hands in the two strings directly (used for tool
 *     previews like Edit's old_string vs new_string).
 *
 * No Monaco: the rendering lives in <DiffView /> which uses a hand-rolled LCS
 * diff so the mobile bundle stays small.
 */
export function MobileDiffModal({ open, onClose, client, filePath, status, textSource }: Props) {
  const [original, setOriginal] = useState<string>('');
  const [current, setCurrent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAllContext, setShowAllContext] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [mode, setMode] = useState<'unified' | 'split'>('unified');

  const isFileSource = !textSource && !!(client && filePath);

  const load = async () => {
    if (!isFileSource || !client || !filePath) return;
    setLoading(true);
    setError(null);
    try {
      const [cur, orig] = await Promise.all([
        client.readFile(filePath).then((r) => r?.content || '').catch(() => ''),
        status === 'untracked' ? Promise.resolve('') : client.readFileOriginal(filePath).catch(() => ''),
      ]);
      setCurrent(cur);
      setOriginal(orig);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setShowAllContext(false);
    if (textSource) {
      setOriginal(textSource.original);
      setCurrent(textSource.current);
      setError(null);
      setLoading(false);
    } else {
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filePath, textSource?.original, textSource?.current]);

  const { added, removed } = useMemo(() => diffCounts(original, current), [original, current]);

  const titleLine = textSource?.title ?? filePath ?? '';
  const fileName = titleLine ? titleLine.split('/').pop() : '';
  const dirPart = titleLine && fileName ? titleLine.slice(0, titleLine.length - fileName.length).replace(/\/$/, '') : '';

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const body = (
    <div
      className="fixed inset-0 z-[100] bg-zinc-950 flex flex-col"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-border shrink-0">
        <Button
          variant="ghost"
          onPress={onClose}
          className="h-auto min-w-0 text-[13px] text-zinc-400 active:text-zinc-200 px-1 shrink-0"
        >
          Close
        </Button>
        <div className="flex-1 min-w-0 text-center">
          <div className="text-[13px] font-mono text-zinc-100 truncate" title={titleLine}>
            {fileName || '(no file)'}
          </div>
          {dirPart && <div className="text-[10px] font-mono text-zinc-600 truncate">{dirPart}</div>}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={() => setMode((m) => (m === 'unified' ? 'split' : 'unified'))}
            className={`p-1.5 min-w-0 rounded active:bg-white/10 ${mode === 'split' ? 'text-indigo-300' : 'text-zinc-500'}`}
            aria-label={mode === 'split' ? 'Split view' : 'Unified view'}
          >
            {mode === 'split' ? <Columns2 size={16} /> : <AlignJustify size={16} />}
          </Button>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={() => setWrap((v) => !v)}
            isDisabled={mode === 'split'}
            className={`p-1.5 min-w-0 rounded active:bg-white/10 disabled:opacity-30 ${wrap ? 'text-indigo-300' : 'text-zinc-500'}`}
            aria-label={mode === 'split' ? 'Wrap is always on in split view' : 'Toggle wrap'}
          >
            {wrap ? <WrapText size={16} /> : <Text size={16} />}
          </Button>
          {isFileSource && (
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              onPress={load}
              isDisabled={loading}
              className="p-1.5 min-w-0 rounded text-zinc-400 active:text-zinc-200 active:bg-white/10 disabled:opacity-40"
              aria-label="Refresh"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </Button>
          )}
        </div>
      </div>

      {/* Stats bar */}
      <div className="flex items-center gap-3 px-4 py-1.5 border-b border-border shrink-0 text-[11px] font-mono">
        <span className="text-green-400">+{added}</span>
        <span className="text-red-400">−{removed}</span>
        {!showAllContext && (added > 0 || removed > 0) && (
          <Button
            variant="ghost"
            onPress={() => setShowAllContext(true)}
            className="h-auto min-w-0 ml-auto text-zinc-500 active:text-zinc-300 px-0"
          >
            Show all context
          </Button>
        )}
      </div>

      {/* Diff body */}
      {error && <div className="p-4 text-[12px] text-red-400">{error}</div>}
      {loading && !error && (
        <div className="p-4 text-[12px] text-zinc-500 text-center">Loading…</div>
      )}
      {!loading && !error && (
        <DiffView
          className="flex-1"
          original={original}
          current={current}
          mode={mode}
          wrap={wrap}
          showAllContext={showAllContext}
        />
      )}
    </div>
  );

  return createPortal(body, document.body);
}
