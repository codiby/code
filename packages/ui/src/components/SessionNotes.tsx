import { useEffect, useRef, useState } from 'react';
import type { ClaudeClient, SessionNotes as Notes } from '../lib/claude-client';

type Draft = { content: string; base: Notes };
// Keep unsaved drafts when changing sidebar tabs or sessions; isolate hosts/clients.
const drafts = new WeakMap<ClaudeClient, Map<string, Draft>>();
export function SessionNotes({ client, sessionId, sessionName, onHasNotes }: {
  client: ClaudeClient; sessionId: string; sessionName?: string | null; onHasNotes: (hasNotes: boolean) => void;
}) {
  const cache = drafts.get(client) ?? new Map<string, Draft>();
  drafts.set(client, cache);
  const [draft, setDraft] = useState<Draft | null>(() => cache.get(sessionId) ?? null);
  const draftRef = useRef(draft);
  const [latest, setLatest] = useState<Notes | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const dirty = !!draft && draft.content !== draft.base.content;
  const conflict = dirty && latest !== null && latest.revision !== draft.base.revision;
  const update = (value: Draft) => { draftRef.current = value; cache.set(sessionId, value); setDraft(value); };

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let loading = false;
    const refresh = async () => {
      if (loading || savingRef.current) return;
      loading = true;
      try {
        const notes = await client.getSessionNotes(sessionId);
        if (disposed || savingRef.current || notes.revision < (draftRef.current?.base.revision ?? 0)) return;
        setLatest(notes);
        onHasNotes(!!notes.content.trim());
        const current = draftRef.current;
        if (!current || current.content === current.base.content) update({ content: notes.content, base: notes });
        if (!current || current.content === current.base.content) setError('');
      } catch (err) { if (!disposed) setError(err instanceof Error ? err.message : String(err)); }
      finally { loading = false; }
    };
    void refresh();
    const timer = setInterval(refresh, 3000);
    const warn = (event: BeforeUnloadEvent) => {
      if ([...cache.values()].some(value => value.content !== value.base.content)) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => { disposed = true; mounted.current = false; clearInterval(timer); window.removeEventListener('beforeunload', warn); };
  }, [client, sessionId, onHasNotes]);

  const save = async () => {
    const current = draftRef.current;
    if (!current || savingRef.current) return;
    savingRef.current = true; setSaving(true); setError('');
    try {
      const notes = await client.saveSessionNotes(sessionId, current.content, current.base.revision);
      // Editing stays enabled during a save; retain any newer keystrokes.
      update({ content: draftRef.current?.content ?? notes.content, base: notes });
      setLatest(notes); if (mounted.current) onHasNotes(!!notes.content.trim());
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { savingRef.current = false; setSaving(false); }
  };
  return <section className="flex-1 min-h-0 flex flex-col select-text" aria-label="Session notes">
    <div className="mx-2.5 px-1 py-3 border-b border-[#24252b] text-[10px] font-semibold tracking-wider text-zinc-400">NOTES</div>
    <div className="px-3.5 pt-3.5 pb-3 text-[11px] text-zinc-500 truncate" title={sessionName || sessionId}>{sessionName || 'This session'}</div>
    <textarea
      aria-label="Session notes" placeholder="Notes, decisions and follow-ups…" maxLength={100000}
      disabled={!draft} value={draft?.content ?? ''}
      onChange={event => { if (draft) update({ ...draft, content: event.target.value }); }}
      onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); event.stopPropagation(); void save(); } }}
      className="flex-1 min-h-48 w-full resize-none bg-transparent border-0 outline-none px-3.5 text-[12px] leading-[1.9] text-zinc-300 placeholder:text-zinc-600"
    />
    {conflict && <div role="alert" className="m-3 text-xs text-amber-300 space-y-2">
      <p>Notes changed elsewhere. Your draft is preserved. Copy any changes you want to keep before loading the latest notes.</p>
      <button className="underline" onClick={() => { if (latest) { update({ content: latest.content, base: latest }); setError(''); } }}>Replace draft with latest notes</button>
    </div>}
    {error && <p role="alert" className="m-3 text-xs text-red-400">{error}</p>}
    <footer className="flex items-center justify-between border-t border-[#22232a] p-3 text-[10px] text-zinc-500">
      <span role="status">{saving ? 'Saving…' : !draft ? 'Loading…' : dirty ? 'Unsaved changes' : 'Saved'}</span>
      <button disabled={!dirty || saving || conflict} onClick={() => void save()} className="rounded-md px-2.5 py-1 bg-violet-500/15 text-violet-300 disabled:opacity-40 hover:bg-violet-500/25">Save</button>
    </footer>
  </section>;
}
