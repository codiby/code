/**
 * Small pill above the composer shown when the agent called `suggest_archive`
 * — "this task looks done". One click (or the Archive Session shortcut)
 * archives the session; ✕ hides it for good. It disappears on its own as soon
 * as the user types or the agent starts another turn.
 */
import { Check, X } from 'lucide-react';
import type { ChatMessage } from '../lib/claude-client';
import { dismissArchiveSuggestion, useArchiveSuggestion } from '../lib/archive-suggestion';
import { chordTokens } from '../lib/keybindings';

export function ArchiveSuggestionPill({
  messages, streaming, typing, chord, onArchive, className = '',
}: {
  messages: ChatMessage[];
  streaming: boolean;
  typing: boolean;
  /** The Archive Session binding, shown as a hint. Null when unbound. */
  chord: string | null;
  onArchive: () => void;
  className?: string;
}) {
  const suggestion = useArchiveSuggestion(messages, { streaming, typing });
  if (!suggestion) return null;
  return (
    <div
      className={`archive-pill mx-auto w-fit max-w-[calc(100%-1.5rem)] flex items-center gap-2 rounded-full border border-border bg-surface pl-3 pr-1 py-1 text-[12px] text-zinc-400 shadow-sm ${className}`}
      role="status"
    >
      <Check size={13} className="shrink-0 text-emerald-400" />
      <span className="min-w-0 truncate" title={suggestion.reason}>{suggestion.reason}</span>
      <button
        type="button"
        className="shrink-0 flex items-center gap-1.5 rounded-full bg-surface-lighter px-2.5 py-0.5 text-zinc-200 hover:bg-zinc-700/60 transition-colors"
        onClick={onArchive}
      >
        Archive
        {chord && (
          <span className="flex gap-0.5 font-mono text-[10.5px] text-zinc-500">
            {chordTokens(chord).map((t, i) => <span key={i}>{t}</span>)}
          </span>
        )}
      </button>
      <button
        type="button"
        className="shrink-0 grid place-items-center size-5 rounded-full text-zinc-500 hover:text-zinc-200 hover:bg-white/5 transition-colors"
        title="Not yet"
        aria-label="Dismiss"
        onClick={() => dismissArchiveSuggestion(suggestion.id)}
      >
        <X size={12} />
      </button>
    </div>
  );
}
