import { useState, type ReactNode } from 'react';
import { ChevronRight, Pencil, Play } from 'lucide-react';
import type { TurnStats } from '../lib/turns';

function formatElapsed(ms: number | null): string | null {
  if (ms == null || ms < 1000) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The work of a finished turn, folded to one line —
 * `Worked 6m 12s · ✎ 5 files +212 −14 · ▶ 12 commands` — so the answer below
 * it reads on its own. Opening it shows the narration and steps again, on a
 * rail, in a quieter voice than the answer.
 */
export function TurnFold({ stats, stopped, children }: { stats: TurnStats; stopped?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const elapsed = formatElapsed(stats.durationMs);
  const added = stats.files.reduce((n, f) => n + f.added, 0);
  const removed = stats.files.reduce((n, f) => n + f.removed, 0);
  const label = stopped
    ? (elapsed ? `Stopped after ${elapsed}` : 'Stopped')
    : (elapsed ? `Worked ${elapsed}` : 'Worked');

  return (
    <div className="py-1">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="group flex items-center gap-2 h-7 pr-2 rounded-md text-[12.5px] text-zinc-500 hover:text-zinc-300 transition-colors select-none"
      >
        <span className="w-4 flex justify-center text-zinc-600 group-hover:text-zinc-400">
          <ChevronRight size={13} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        </span>
        <span>{label}</span>
        {stats.files.length > 0 && (
          <>
            <span className="text-zinc-700">·</span>
            <span className="flex items-center gap-1.5">
              <Pencil size={11} className="text-violet-400/80" />
              {stats.files.length} {stats.files.length === 1 ? 'file' : 'files'}
              {added > 0 && <span className="font-mono text-[11.5px] text-emerald-500">+{added}</span>}
              {removed > 0 && <span className="font-mono text-[11.5px] text-red-500">−{removed}</span>}
            </span>
          </>
        )}
        {stats.commands > 0 && (
          <>
            <span className="text-zinc-700">·</span>
            <span className="flex items-center gap-1.5">
              <Play size={9} fill="currentColor" className="text-zinc-600" />
              {stats.commands} {stats.commands === 1 ? 'command' : 'commands'}
            </span>
          </>
        )}
      </button>
      {open && (
        <div className="ml-[7px] mt-1 mb-2 pl-4 border-l-[1.5px] border-border">
          {children}
        </div>
      )}
    </div>
  );
}
