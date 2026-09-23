import { useEffect, useRef, useState } from 'react';

export type DirtyFile = { path: string; status: string; additions?: number; deletions?: number };
export type ResolveMode = 'stash' | 'commit';

const VISIBLE_FILES = 5;

const STATUS_COLOR: Record<string, string> = {
  M: 'text-amber-400',
  A: 'text-green-500',
  D: 'text-red-400',
  R: 'text-sky-400',
  '?': 'text-sky-400',
};

interface Props {
  /** The branch the user tried to switch to. */
  target: string;
  current: string;
  /** Where the changes live, since it may not be this machine. */
  host: string;
  path: string;
  files: DirtyFile[];
  busy: ResolveMode | null;
  error: string | null;
  onResolve: (mode: ResolveMode, message: string, includeUntracked: boolean) => void;
  onStay: () => void;
}

/**
 * Shown under the composer's branch row when git refuses a checkout because of
 * local changes. One message field serves both ways out — stash or commit —
 * so neither costs an extra step; staying put just closes the panel.
 */
export function BranchBlockedPanel({ target, current, host, path, files, busy, error, onResolve, onStay }: Props) {
  const [message, setMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const canAct = !!message.trim() && !busy;
  const act = (mode: ResolveMode) => { if (canAct) onResolve(mode, message.trim(), includeUntracked); };
  const shown = showAll ? files : files.slice(0, VISIBLE_FILES);

  return (
    <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.04] px-4 py-3.5 text-[13px]">
      <div className="flex items-start gap-2.5">
        <span className="mt-[7px] h-2 w-2 flex-none rounded-full bg-amber-500" />
        <div className="min-w-0">
          <div>
            Uncommitted changes block switching to{' '}
            <span className="font-mono text-[12.5px] text-amber-200">{target}</span>
          </div>
          <div className="text-xs text-zinc-500">
            On <span className="font-mono">{current}</span> · {host}:{path}
          </div>
        </div>
      </div>

      <div className="my-2.5 ml-[18px] border-l border-border pl-3 font-mono text-xs">
        {shown.map(f => (
          <div key={f.path} className="flex items-center gap-2.5 py-px text-zinc-400">
            <span className={`w-4 flex-none text-center font-semibold ${STATUS_COLOR[f.status] || 'text-zinc-400'}`}>{f.status}</span>
            <span className="min-w-0 truncate" title={f.path}>{f.path}</span>
            <span className="ml-auto flex-none text-zinc-500">
              {f.status === '?' ? 'untracked' : (
                <>
                  {!!f.additions && <span className="text-green-500">+{f.additions}</span>}
                  {!!f.additions && !!f.deletions && ' '}
                  {!!f.deletions && <span className="text-red-400">−{f.deletions}</span>}
                </>
              )}
            </span>
          </div>
        ))}
        {files.length > VISIBLE_FILES && !showAll && (
          <button type="button" className="py-px text-zinc-500 hover:text-zinc-300" onClick={() => setShowAll(true)}>
            +{files.length - VISIBLE_FILES} more
          </button>
        )}
      </div>

      <div className="ml-[18px] flex flex-col gap-2">
        <input
          ref={inputRef}
          value={message}
          onChange={e => setMessage(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') { e.preventDefault(); if (!busy) onStay(); }
            else if (e.key === 'Enter') { e.preventDefault(); act(e.metaKey || e.ctrlKey ? 'commit' : 'stash'); }
          }}
          disabled={!!busy}
          placeholder="Describe these changes — used for the stash or the commit"
          className="w-full rounded-lg border border-zinc-700 bg-black/40 px-3 py-2 text-[13px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-violet-400 disabled:opacity-60"
        />
        <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
          <button
            type="button"
            disabled={!canAct}
            onClick={() => act('stash')}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-100 bg-zinc-100 px-3 py-1.5 font-medium text-zinc-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === 'stash' ? 'Stashing…' : 'Stash & switch'} <kbd className="font-mono text-[11px] opacity-55">↵</kbd>
          </button>
          <button
            type="button"
            disabled={!canAct}
            onClick={() => act('commit')}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-white/5 px-3 py-1.5 text-zinc-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === 'commit' ? 'Committing…' : 'Commit & switch'} <kbd className="font-mono text-[11px] opacity-55">⌘↵</kbd>
          </button>
          <button
            type="button"
            disabled={!!busy}
            onClick={onStay}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
          >
            Stay on {current} <kbd className="font-mono text-[11px] opacity-55">esc</kbd>
          </button>
          <span className="flex-1" />
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-500">
            <input
              type="checkbox"
              checked={includeUntracked}
              onChange={e => setIncludeUntracked(e.target.checked)}
              disabled={!!busy}
              className="accent-violet-400"
            />
            Include untracked files
          </label>
        </div>
        <div className="text-[11.5px] text-zinc-500">
          Everything stays on {host} — a commit goes to {current} and nothing is pushed.
        </div>
        {error && <div role="alert" className="whitespace-pre-wrap font-mono text-xs text-red-400">{error}</div>}
      </div>
    </div>
  );
}
