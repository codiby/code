import { useState, useEffect, useCallback } from 'react';
import type { ClaudeClient } from '../lib/claude-client';

interface FileEntry {
  name: string;
  type: 'file' | 'dir';
  path: string;
}

interface Props {
  client: ClaudeClient | null;
  rootPath: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onFileOpen: (path: string) => void;
}

const EXT_COLORS: Record<string, string> = {
  ts: 'text-blue-400', tsx: 'text-blue-400', js: 'text-yellow-400', jsx: 'text-yellow-400',
  json: 'text-yellow-600', md: 'text-zinc-400', css: 'text-purple-400', html: 'text-orange-400',
  py: 'text-green-400', rs: 'text-orange-500', go: 'text-cyan-400',
  yaml: 'text-red-400', yml: 'text-red-400', toml: 'text-red-400',
  svg: 'text-amber-400', png: 'text-emerald-400', jpg: 'text-emerald-400',
  sh: 'text-green-500', bash: 'text-green-500', zsh: 'text-green-500',
};

function getExtColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return EXT_COLORS[ext] || 'text-zinc-600';
}

function DirNode({ entry, client, depth, onFileOpen }: { entry: FileEntry; client: ClaudeClient | null; depth: number; onFileOpen: (path: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (!client) return;
    setLoading(true);
    try {
      const items = await client.listFiles(entry.path);
      setChildren(items);
    } catch {
      setChildren([]);
    }
    setLoading(false);
    setExpanded(true);
  }, [expanded, client, entry.path]);

  return (
    <div>
      <button
        className="flex items-center gap-1 w-full text-left py-[2px] hover:bg-surface-light/50 text-zinc-400 hover:text-zinc-200 transition-colors"
        style={{ paddingLeft: depth * 12 + 8 }}
        onClick={toggle}
      >
        <span className="text-base w-4 text-center shrink-0 text-zinc-300">
          {expanded ? '▾' : '▸'}
        </span>
        <span className="truncate text-[12px]">{entry.name}</span>
      </button>
      {expanded && (
        <div>
          {loading && (
            <span className="text-[11px] text-zinc-600 block" style={{ paddingLeft: (depth + 1) * 12 + 20 }}>...</span>
          )}
          {children.map(child =>
            child.type === 'dir' ? (
              <DirNode key={child.path} entry={child} client={client} depth={depth + 1} onFileOpen={onFileOpen} />
            ) : (
              <FileNode key={child.path} entry={child} depth={depth + 1} onFileOpen={onFileOpen} />
            )
          )}
        </div>
      )}
    </div>
  );
}

function FileNode({ entry, depth, onFileOpen }: { entry: FileEntry; depth: number; onFileOpen: (path: string) => void }) {
  const color = getExtColor(entry.name);
  return (
    <div
      className="flex items-center gap-1 py-[2px] text-zinc-500 hover:text-zinc-300 hover:bg-surface-light/50 cursor-pointer transition-colors"
      style={{ paddingLeft: depth * 12 + 8 }}
      onClick={() => onFileOpen(entry.path)}
    >
      <span className={`text-[10px] w-3 text-center shrink-0 ${color}`}>&#9679;</span>
      <span className="truncate text-[12px]">{entry.name}</span>
    </div>
  );
}

export function FileExplorer({ client, rootPath, collapsed, onToggle, onFileOpen }: Props) {
  const [entries, setEntries] = useState<FileEntry[]>([]);

  useEffect(() => {
    if (!client || !rootPath) return;
    client.listFiles(rootPath).then(setEntries).catch(() => setEntries([]));
  }, [client, rootPath]);

  return (
    <aside className={`border-r border-border bg-[#161616] flex flex-col shrink-0 transition-all ${collapsed ? 'w-0 overflow-hidden' : 'w-60'}`}>
      {/* Header */}
      <div className="px-3 py-2 flex items-center justify-between border-b border-border shrink-0">
        <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Explorer</span>
        <button
          className="text-zinc-600 hover:text-zinc-300 text-sm"
          onClick={onToggle}
          title="Toggle file explorer"
        >
          &#x2715;
        </button>
      </div>

      {/* Root label */}
      {rootPath && (
        <div className="px-3 py-1.5 text-[11px] text-zinc-500 font-mono truncate border-b border-border/50">
          {rootPath.split('/').filter(Boolean).pop() || rootPath}
        </div>
      )}

      {/* File tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {!rootPath && (
          <p className="text-[11px] text-zinc-600 px-3 py-4 text-center">No session active</p>
        )}
        {entries.map(entry =>
          entry.type === 'dir' ? (
            <DirNode key={entry.path} entry={entry} client={client} depth={0} onFileOpen={onFileOpen} />
          ) : (
            <FileNode key={entry.path} entry={entry} depth={0} onFileOpen={onFileOpen} />
          )
        )}
      </div>
    </aside>
  );
}
