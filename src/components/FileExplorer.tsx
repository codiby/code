import { useState, useEffect, useCallback, useRef } from 'react';
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
  onFileDiff?: (path: string) => void;
  gitModified: { staged: Set<string>; unstaged: Set<string> };
  activeSessionId: string | null;
  onOpenTerminal?: (command: string) => void;
  onStartReview?: () => void;
  onRefreshGit?: () => void;
  tools?: string[];
  sessionName?: string;
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

function DirNode({ entry, client, depth, onFileOpen, gitModified }: { entry: FileEntry; client: ClaudeClient | null; depth: number; onFileOpen: (path: string) => void; gitModified: { staged: Set<string>; unstaged: Set<string> } }) {
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
              <DirNode key={child.path} entry={child} client={client} depth={depth + 1} onFileOpen={onFileOpen} gitModified={gitModified} />
            ) : (
              <FileNode key={child.path} entry={child} depth={depth + 1} onFileOpen={onFileOpen} gitModified={gitModified} />
            )
          )}
        </div>
      )}
    </div>
  );
}

function FileNode({ entry, depth, onFileOpen, gitModified }: { entry: FileEntry; depth: number; onFileOpen: (path: string) => void; gitModified: { staged: Set<string>; unstaged: Set<string> } }) {
  const isStaged = gitModified.staged.has(entry.path);
  const isUnstaged = gitModified.unstaged.has(entry.path);
  const isModified = isStaged || isUnstaged;
  const color = isModified ? (isStaged ? 'text-green-400' : 'text-amber-400') : getExtColor(entry.name);
  return (
    <div
      className={`flex items-center gap-1 py-[2px] hover:bg-surface-light/50 cursor-pointer transition-colors ${isModified ? (isStaged ? 'text-green-400/80' : 'text-amber-400/80') : 'text-zinc-500 hover:text-zinc-300'}`}
      style={{ paddingLeft: depth * 12 + 8 }}
      onClick={() => onFileOpen(entry.path)}
    >
      <span className={`text-[10px] w-3 text-center shrink-0 ${color}`}>&#9679;</span>
      <span className="truncate text-[12px]">{entry.name}</span>
    </div>
  );
}

function ChangesSection({ gitModified, rootPath, onFileDiff, onStartReview, client, onRefresh }: { gitModified: { staged: Set<string>; unstaged: Set<string> }; rootPath: string | null; onFileDiff: (path: string) => void; onStartReview?: () => void; client: ClaudeClient | null; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState(true);
  const stagedFiles = [...gitModified.staged].sort();
  const unstagedFiles = [...gitModified.unstaged].sort();
  const totalCount = new Set([...stagedFiles, ...unstagedFiles]).size;
  if (totalCount === 0) return null;

  const toggleStage = async (e: React.MouseEvent, filePath: string, isStaged: boolean) => {
    e.stopPropagation();
    if (!client || !rootPath) return;
    await client.gitStage(rootPath, [filePath], isStaged);
    onRefresh();
  };

  const stageAll = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!client || !rootPath) return;
    await client.gitStage(rootPath, unstagedFiles);
    onRefresh();
  };

  const renderFile = (filePath: string, isStaged: boolean) => {
    if (!filePath) return null;
    const rel = rootPath && filePath.startsWith(rootPath)
      ? filePath.slice(rootPath.length + 1)
      : filePath;
    const name = filePath.split('/').pop() || filePath;
    const color = isStaged ? 'text-green-400' : 'text-amber-400';
    return (
      <div
        key={`${filePath}-${isStaged ? 's' : 'u'}`}
        className={`flex items-center gap-1 py-[2px] px-2 ${color}/80 hover:bg-surface-light/50 cursor-pointer transition-colors group/file`}
        onClick={() => onFileDiff(filePath)}
      >
        <span className={`text-[10px] w-3 text-center shrink-0 ${color}`}>{isStaged ? 'S' : 'M'}</span>
        <span className="truncate text-[12px]">{name}</span>
        <span className="text-[10px] text-zinc-600 font-mono truncate ml-auto shrink-0 max-w-[45%] text-right">{rel}</span>
        <span
          className={`text-[11px] px-1 transition-colors opacity-0 group-hover/file:opacity-100 shrink-0 ${isStaged ? 'text-zinc-600 hover:text-red-400' : 'text-zinc-600 hover:text-green-400'}`}
          onClick={(e) => toggleStage(e, filePath, isStaged)}
          title={isStaged ? 'Unstage file' : 'Stage file'}
        >
          {isStaged ? '−' : '+'}
        </span>
      </div>
    );
  };

  return (
    <div className="border-b border-border/50 shrink-0">
      <button
        className="flex items-center gap-1 w-full text-left px-3 py-1.5 hover:bg-surface-light/30 transition-colors group"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="text-[11px] w-3 text-center shrink-0 text-zinc-400">{expanded ? '▾' : '▸'}</span>
        <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Changes</span>
        <span className="text-[10px] text-amber-400/70 ml-auto mr-1">{totalCount}</span>
        {unstagedFiles.length > 0 && (
          <span
            className="text-[11px] text-zinc-600 hover:text-green-400 px-1 transition-colors opacity-0 group-hover:opacity-100"
            onClick={stageAll}
            title="Stage All"
          >
            +
          </span>
        )}
        {onStartReview && (
          <span
            className="text-[11px] text-zinc-500 hover:text-green-400 px-1 transition-colors"
            onClick={(e) => { e.stopPropagation(); onStartReview(); }}
            title="Start Review"
          >
            &#x25B6;
          </span>
        )}
      </button>
      {expanded && (
        <div className="pb-1">
          {stagedFiles.length > 0 && (
            <div className="px-3 py-0.5">
              <span className="text-[10px] text-green-400/60 uppercase tracking-wider">Staged</span>
            </div>
          )}
          {stagedFiles.map(path => renderFile(path, true))}
          {unstagedFiles.length > 0 && (
            <div className="px-3 py-0.5 mt-0.5">
              <span className="text-[10px] text-amber-400/60 uppercase tracking-wider">Changes</span>
            </div>
          )}
          {unstagedFiles.map(path => renderFile(path, false))}
        </div>
      )}
    </div>
  );
}

interface ProcessInfo {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  startedAt: number;
  children: { pid: number; command: string }[];
}

function ProcessNode({ proc, onKill, onView }: { proc: ProcessInfo; onKill: (processId?: string, pid?: number) => void; onView?: (command: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = proc.children.length > 0;

  return (
    <div>
      <div className="flex items-center gap-1 py-[2px] px-2 text-zinc-400 group">
        {hasChildren ? (
          <button className="text-[10px] w-3 text-center shrink-0 text-zinc-500" onClick={() => setExpanded(e => !e)}>
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
        <span className="truncate text-[11px] font-mono flex-1 cursor-pointer hover:text-zinc-200" onClick={() => onView?.(proc.command)}>{proc.command}</span>
        <span className="text-[10px] text-zinc-600 shrink-0">{proc.pid}</span>
        {onView && (
          <button
            className="text-zinc-600 hover:text-zinc-300 text-[10px] opacity-0 group-hover:opacity-100 shrink-0 ml-0.5 transition-opacity"
            onClick={() => onView(proc.command)}
            title="Open in panel"
          >
            &#x2197;
          </button>
        )}
        <button
          className="text-zinc-600 hover:text-red-400 text-[11px] opacity-0 group-hover:opacity-100 shrink-0 ml-0.5 transition-opacity"
          onClick={() => onKill(proc.id)}
          title="Kill process"
        >
          &times;
        </button>
      </div>
      {expanded && proc.children.map(child => (
        <div key={child.pid} className="flex items-center gap-1 py-[1px] text-zinc-500 group" style={{ paddingLeft: 28 }}>
          <span className="text-[10px] text-zinc-600 shrink-0">&#x2514;</span>
          <span className="truncate text-[10px] font-mono flex-1">{child.command}</span>
          <span className="text-[9px] text-zinc-600 shrink-0">{child.pid}</span>
          <button
            className="text-zinc-600 hover:text-red-400 text-[10px] opacity-0 group-hover:opacity-100 shrink-0 ml-1 pr-2 transition-opacity"
            onClick={() => onKill(undefined, child.pid)}
            title="Kill process"
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}

function ProcessesSection({ client, sessionId, onViewTerminal }: { client: ClaudeClient | null; sessionId: string | null; onViewTerminal?: (command: string) => void }) {
  const [expanded, setExpanded] = useState(true);
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  const refresh = useCallback(async () => {
    if (!client || !sessionId) { setProcesses([]); return; }
    try {
      const procs = await client.listProcesses(sessionId);
      setProcesses(procs);
    } catch { setProcesses([]); }
  }, [client, sessionId]);

  useEffect(() => {
    refresh();
    intervalRef.current = setInterval(refresh, 3000);
    return () => clearInterval(intervalRef.current);
  }, [refresh]);

  const handleKill = async (processId?: string, pid?: number) => {
    if (!client) return;
    await client.killProcess(processId, pid);
    setTimeout(refresh, 500);
  };

  if (processes.length === 0) return null;

  return (
    <div className="border-b border-border/50 shrink-0">
      <button
        className="flex items-center gap-1 w-full text-left px-3 py-1.5 hover:bg-surface-light/30 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="text-[11px] w-3 text-center shrink-0 text-zinc-400">{expanded ? '▾' : '▸'}</span>
        <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Processes</span>
        <span className="text-[10px] text-green-400/70 ml-auto">{processes.length}</span>
      </button>
      {expanded && (
        <div className="pb-1">
          {processes.map(proc => (
            <ProcessNode key={proc.id} proc={proc} onKill={handleKill} onView={onViewTerminal} />
          ))}
        </div>
      )}
    </div>
  );
}

function FileTreeSection({ rootPath, entries, client, onFileOpen, gitModified }: { rootPath: string | null; entries: FileEntry[]; client: ClaudeClient | null; onFileOpen: (path: string) => void; gitModified: { staged: Set<string>; unstaged: Set<string> } }) {
  const [expanded, setExpanded] = useState(true);
  const label = rootPath ? rootPath.split('/').filter(Boolean).pop() || rootPath : 'Files';

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <button
        className="flex items-center gap-1 w-full text-left px-3 py-1.5 hover:bg-surface-light/30 transition-colors border-b border-border/50 shrink-0"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="text-[11px] w-3 text-center shrink-0 text-zinc-400">{expanded ? '▾' : '▸'}</span>
        <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider truncate">{label}</span>
      </button>
      {expanded && (
        <div className="flex-1 overflow-y-auto py-1">
          {!rootPath && (
            <p className="text-[11px] text-zinc-600 px-3 py-4 text-center">No session active</p>
          )}
          {entries.map(entry =>
            entry.type === 'dir' ? (
              <DirNode key={entry.path} entry={entry} client={client} depth={0} onFileOpen={onFileOpen} gitModified={gitModified} />
            ) : (
              <FileNode key={entry.path} entry={entry} depth={0} onFileOpen={onFileOpen} gitModified={gitModified} />
            )
          )}
        </div>
      )}
    </div>
  );
}

interface PRInfo {
  number: number;
  title: string;
  headRefName: string;
  state: string;
  url: string;
  isDraft: boolean;
}

const PR_STATE_COLORS: Record<string, { dot: string; text: string }> = {
  OPEN: { dot: 'bg-green-400', text: 'text-green-400' },
  MERGED: { dot: 'bg-violet-400', text: 'text-violet-400' },
  CLOSED: { dot: 'bg-zinc-500', text: 'text-zinc-500' },
};

function PRsSection({ client, rootPath, sessionName }: { client: ClaudeClient | null; rootPath: string | null; sessionName?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [prs, setPrs] = useState<PRInfo[]>([]);

  useEffect(() => {
    if (!client || !rootPath) { setPrs([]); return; }
    client.listPullRequests(rootPath, sessionName).then(setPrs).catch(() => setPrs([]));
  }, [client, rootPath, sessionName]);

  if (prs.length === 0) return null;

  return (
    <div className="border-b border-border/50 shrink-0">
      <button
        className="flex items-center gap-1 w-full text-left px-3 py-1.5 hover:bg-surface-light/30 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="text-[11px] w-3 text-center shrink-0 text-zinc-400">{expanded ? '▾' : '▸'}</span>
        <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Pull Requests</span>
        <span className="text-[10px] text-zinc-600 ml-auto">{prs.length}</span>
      </button>
      {expanded && (
        <div className="pb-1">
          {prs.map(pr => {
            const colors = pr.isDraft
              ? { dot: 'bg-amber-400', text: 'text-amber-400' }
              : PR_STATE_COLORS[pr.state] || PR_STATE_COLORS.OPEN!;
            return (
              <a
                key={pr.number}
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-1.5 py-[3px] px-2 text-zinc-400 hover:bg-surface-light/50 hover:text-zinc-200 cursor-pointer transition-colors"
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${colors.dot}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <span className={`text-[10px] shrink-0 ${colors.text}`}>#{pr.number}</span>
                    <span className="text-[11px] truncate">{pr.title}</span>
                  </div>
                  <span className="text-[10px] text-zinc-600 font-mono truncate block">{pr.headRefName}</span>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ToolsSection({ tools }: { tools: string[] }) {
  const [expanded, setExpanded] = useState(false);
  if (tools.length === 0) return null;

  return (
    <div className="border-b border-border/50 shrink-0">
      <button
        className="flex items-center gap-1 w-full text-left px-3 py-1.5 hover:bg-surface-light/30 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="text-[11px] w-3 text-center shrink-0 text-zinc-400">{expanded ? '▾' : '▸'}</span>
        <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Tools</span>
        <span className="text-[10px] text-zinc-600 ml-auto">{tools.length}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-2 flex flex-wrap gap-1">
          {tools.map(tool => (
            <span key={tool} className="text-[10px] bg-surface-light text-zinc-400 px-1.5 py-0.5 rounded font-mono">
              {tool}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function FileExplorer({ client, rootPath, collapsed, onToggle, onFileOpen, onFileDiff, gitModified, activeSessionId, onOpenTerminal, onStartReview, onRefreshGit, tools, sessionName }: Props) {
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

      {/* Processes */}
      <ProcessesSection client={client} sessionId={activeSessionId} onViewTerminal={onOpenTerminal} />

      {/* Changes */}
      <ChangesSection gitModified={gitModified} rootPath={rootPath} onFileDiff={onFileDiff || onFileOpen} onStartReview={onStartReview} client={client} onRefresh={onRefreshGit || (() => {})} />

      {/* Tools */}
      {/* Pull Requests */}
      <PRsSection client={client} rootPath={rootPath} sessionName={sessionName} />

      <ToolsSection tools={tools || []} />

      {/* File tree (collapsible) */}
      <FileTreeSection rootPath={rootPath} entries={entries} client={client} onFileOpen={onFileOpen} gitModified={gitModified} />
    </aside>
  );
}
