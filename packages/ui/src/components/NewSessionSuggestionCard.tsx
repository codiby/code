/**
 * Card above the composer shown when the agent called `suggest_new_session`
 * — "this is new work, want it in its own session?". "Create session" opens a
 * sibling session seeded with the agent's brief; "Continue here" tells the
 * agent to go ahead in this one. Either answer retires the card.
 */
import { useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import type { ChatMessage } from '../lib/claude-client';
import {
  answerNewSessionSuggestion,
  useNewSessionSuggestion,
  type NewSessionSuggestion,
} from '../lib/new-session-suggestion';

export function NewSessionSuggestionCard({
  messages, streaming, onCreate, onContinue, className = '',
}: {
  messages: ChatMessage[];
  streaming: boolean;
  /** Resolves once the new session exists (and has focus). */
  onCreate: (s: NewSessionSuggestion) => Promise<void>;
  onContinue: (s: NewSessionSuggestion) => void;
  className?: string;
}) {
  const suggestion = useNewSessionSuggestion(messages, { streaming });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBrief, setShowBrief] = useState(false);
  if (!suggestion) return null;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await onCreate(suggestion);
      answerNewSessionSuggestion(suggestion.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the session');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`archive-pill mx-auto w-full max-w-[min(560px,calc(100%-1.5rem))] rounded-xl border border-border bg-surface px-3.5 py-3 text-[12.5px] shadow-sm ${className}`}
      role="group"
      aria-label="Suggested new session"
    >
      <div className="flex items-start gap-2.5">
        <MessageSquarePlus size={16} className="mt-0.5 shrink-0 text-emerald-400" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-zinc-100 truncate" title={suggestion.title}>
            New session · {suggestion.title}
          </div>
          {suggestion.reason && <div className="mt-0.5 text-zinc-400">{suggestion.reason}</div>}
          <button
            type="button"
            className="mt-1 text-[11.5px] text-zinc-500 hover:text-zinc-300 transition-colors"
            onClick={() => setShowBrief(v => !v)}
          >
            {showBrief ? 'Hide what it starts with' : 'What it starts with'}
          </button>
          {showBrief && (
            <div className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-lighter px-2.5 py-2 text-[12px] leading-relaxed text-zinc-300">
              {suggestion.prompt}
            </div>
          )}
          {error && <div className="mt-1.5 text-[12px] text-red-400">{error}</div>}
        </div>
      </div>
      <div className="mt-2.5 flex justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          className="rounded-lg px-3 py-1.5 text-zinc-300 hover:bg-white/5 disabled:opacity-50 transition-colors"
          onClick={() => {
            answerNewSessionSuggestion(suggestion.id);
            onContinue(suggestion);
          }}
        >
          Continue here
        </button>
        <button
          type="button"
          disabled={busy}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-500 disabled:opacity-60 transition-colors"
          onClick={create}
        >
          {busy ? 'Creating…' : 'Create session'}
        </button>
      </div>
    </div>
  );
}
