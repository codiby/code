import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowUp, ChevronRight } from 'lucide-react';
import { Button } from '@heroui/react';
import { BottomSheet } from './BottomSheet';
import type { ClaudeClient } from '../../lib/claude-client';

interface Props {
  open: boolean;
  onClose: () => void;
  client: ClaudeClient;
  /** The active session's working directory — used as the initial cwd. */
  initialCwd: string;
}

interface FileEntry {
  name: string;
  path: string;
  type: string; // 'directory' | 'file' | other
}

export function MobileFilesSheet({ open, onClose, client, initialCwd }: Props) {
  const [cwd, setCwd] = useState(initialCwd || '/');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<{ path: string; content: string } | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  // Reset to initial cwd whenever the sheet is reopened
  useEffect(() => {
    if (open) {
      setCwd(initialCwd || '/');
      setOpenFile(null);
    }
  }, [open, initialCwd]);

  useEffect(() => {
    if (!open || openFile) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    client.listFiles(cwd).then((res) => {
      if (cancelled) return;
      // Sort: dirs first (alpha), then files (alpha)
      const sorted = [...res].sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'directory' ? -1 : 1;
      });
      setEntries(sorted);
    }).catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client, cwd, open, openFile]);

  const goUp = () => {
    if (cwd === '/' || cwd === '') return;
    const parts = cwd.split('/').filter(Boolean);
    parts.pop();
    setCwd('/' + parts.join('/'));
  };

  const onEntryClick = async (e: FileEntry) => {
    if (e.type === 'directory') {
      setCwd(e.path);
    } else {
      setFileLoading(true);
      try {
        const res = await client.readFile(e.path);
        if (res) setOpenFile({ path: e.path, content: res.content || '' });
        else setError('Could not read file');
      } catch (err) {
        setError(String(err));
      } finally {
        setFileLoading(false);
      }
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={openFile ? openFile.path.split('/').slice(-1)[0] : 'Files'}
    >
      {openFile ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onPress={() => setOpenFile(null)}
              className="h-auto min-w-0 flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-zinc-200 active:bg-white/10"
            >
              <ArrowLeft size={14} />
              Back
            </Button>
            <span className="text-[11px] font-mono text-zinc-500 truncate">{openFile.path}</span>
          </div>
          <pre className="text-[12px] text-zinc-200 whitespace-pre-wrap break-all bg-black/40 rounded-lg p-3 max-h-[60vh] overflow-auto m-0 font-mono leading-relaxed">
            {openFile.content || '(empty file)'}
          </pre>
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Button
              variant="ghost"
              onPress={goUp}
              isDisabled={cwd === '/' || cwd === ''}
              className="h-auto min-w-0 flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-zinc-200 active:bg-white/10 disabled:opacity-40"
            >
              <ArrowUp size={14} />
              Up
            </Button>
            <span className="text-[11px] font-mono text-zinc-500 truncate flex-1">{cwd}</span>
          </div>

          {loading && <div className="text-sm text-zinc-500 px-1 py-2">Loading…</div>}
          {fileLoading && <div className="text-sm text-zinc-500 px-1 py-2">Reading file…</div>}
          {error && (
            <div className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-2">
              {error}
            </div>
          )}

          <ul className="divide-y divide-white/5">
            {entries.map((e) => (
              <li key={e.path}>
                <Button
                  variant="ghost"
                  onPress={() => onEntryClick(e)}
                  className="w-full h-auto min-w-0 justify-start text-left flex items-center gap-3 py-2.5 active:bg-white/5 rounded-lg px-2"
                >
                  <span className="text-base">
                    {e.type === 'directory' ? '📁' : '📄'}
                  </span>
                  <span className="text-sm text-zinc-200 truncate flex-1">{e.name}</span>
                  {e.type === 'directory' && (
                    <ChevronRight size={14} className="text-zinc-600" />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </BottomSheet>
  );
}
