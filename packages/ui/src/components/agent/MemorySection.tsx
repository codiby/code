/**
 * Agent view → Memory: what the agent remembers (search, filter, pin, edit,
 * forget, add), the people directory, and fresh threads (the daily rotation
 * and "Start a fresh thread now").
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Loader2, Pencil, Pin, PinOff, Plus, RefreshCw, Search, Trash2, UserRound } from 'lucide-react';
import {
  HANDLE_CHANNELS,
  HANDLE_LABELS,
  KIND_LABELS,
  MEMORY_KINDS,
  agentMemory,
  isValidEmail,
  normalizeWhatsAppInput,
  type ConsolidationOutcome,
  type HandleChannel,
  type MemoryItem,
  type MemoryKind,
  type MemoryStatus,
  type Person,
  type PersonInput,
} from '../../lib/agent/memory';
import { ListInput } from './PersonaSection';
import {
  Button,
  Card,
  EmptyNote,
  ErrorNote,
  Field,
  INPUT_BASE_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  Pill,
  Section,
  Spinner,
  Toggle,
  relativeTime,
  usePolled,
  type AgentSectionProps,
} from './ui';

type Pane = 'memories' | 'people' | 'threads';

const PANES: { id: Pane; label: string }[] = [
  { id: 'memories', label: 'Memories' },
  { id: 'people', label: 'People' },
  { id: 'threads', label: 'Fresh threads' },
];

const PAGE = 50;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Debounced copy of `value`, so typing in a search box doesn't fire a request per key. */
function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function MemorySection(props: AgentSectionProps) {
  const [pane, setPane] = useState<Pane>('memories');
  return (
    <>
      <div className="flex gap-1 mb-[18px]" role="tablist" aria-label="Memory sections">
        {PANES.map(p => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={pane === p.id}
            onClick={() => setPane(p.id)}
            className={`h-[26px] px-3 rounded-md text-[12px] transition-colors ${
              pane === p.id ? 'bg-indigo-400/15 text-indigo-200 border border-indigo-400/30' : 'text-zinc-400 border border-transparent hover:bg-surface-light'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {pane === 'memories' && <MemoriesPane {...props} />}
      {pane === 'people' && <PeoplePane {...props} />}
      {pane === 'threads' && <ThreadsPane {...props} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

const KIND_TONES: Record<MemoryKind, 'zinc' | 'green' | 'amber' | 'red' | 'indigo'> = {
  profile: 'indigo',
  preference: 'green',
  person: 'amber',
  fact: 'zinc',
  note: 'zinc',
  task: 'red',
};

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative flex-1 min-w-0">
      <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600 pointer-events-none" />
      <input
        type="search"
        aria-label={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${INPUT_CLASS} pl-8`}
      />
    </div>
  );
}

function MemoriesPane({ api, refreshKey }: AgentSectionProps) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<MemoryKind | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const debounced = useDebounced(query);
  const list = usePolled(() => agentMemory.list(api, { query: debounced, kind, limit }), [api, refreshKey, debounced, kind, limit]);

  useEffect(() => { setLimit(PAGE); }, [debounced, kind]);

  const counts = list.data?.counts;
  const items = list.data?.items ?? [];
  const searching = !!debounced.trim();

  return (
    <Section
      title="Memories"
      hint="What the agent knows about you. Profile facts, pinned memories and recent preferences are part of its instructions; it searches the rest with recall."
      action={!adding && <Button onClick={() => { setAdding(true); setNotice(null); }}><Plus size={12} /> Add memory</Button>}
    >
      <div className="flex items-center gap-2 mb-2">
        <SearchBox value={query} onChange={setQuery} placeholder="Search memories" />
        {list.loading && list.data && <Loader2 size={13} className="animate-spin text-zinc-600 shrink-0" />}
      </div>

      <div className="flex flex-wrap gap-1 mb-3" role="group" aria-label="Filter by kind">
        <KindChip label="All" count={counts?.total} active={kind === null} onClick={() => setKind(null)} />
        {MEMORY_KINDS.map(k => (
          <KindChip key={k} label={KIND_LABELS[k]} count={counts?.[k]} active={kind === k} onClick={() => setKind(kind === k ? null : k)} />
        ))}
      </div>

      {adding && (
        <div className="mb-3">
          <MemoryEditor
            initial={{ content: '', kind: kind ?? 'fact', tags: [], pinned: false }}
            submitLabel="Save memory"
            onCancel={() => setAdding(false)}
            onSubmit={async draft => {
              const res = await agentMemory.create(api, draft);
              setAdding(false);
              setNotice(res.created ? null : 'The agent already knew that — merged with the existing memory.');
              await list.reload();
            }}
          />
        </div>
      )}
      {notice && <div className="mb-2 text-[11.5px] text-zinc-400">{notice}</div>}
      {list.error && <div className="mb-2"><ErrorNote message={list.error} onRetry={() => void list.reload()} /></div>}

      {!list.data && list.loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyNote>
          {searching ? 'Nothing matches that search.' : kind ? `No ${KIND_LABELS[kind].toLowerCase()} memories yet.` : 'Nothing saved yet. The agent saves what you tell it about yourself — or add something here.'}
        </EmptyNote>
      ) : (
        <div className="flex flex-col gap-1.5">
          {items.map(item => (
            <MemoryRow
              key={item.id}
              item={item}
              onChange={async patch => { await agentMemory.update(api, item.id, patch); await list.reload(); }}
              onDelete={async () => { await agentMemory.remove(api, item.id); await list.reload(); }}
            />
          ))}
          {!searching && list.data && items.length < list.data.total && (
            <div className="pt-1">
              <Button onClick={() => setLimit(l => l + PAGE)}>Show more ({list.data.total - items.length})</Button>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function KindChip({ label, count, active, onClick }: { label: string; count?: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`h-[24px] px-2.5 rounded-full text-[11.5px] border transition-colors ${
        active ? 'bg-indigo-400/15 border-indigo-400/40 text-indigo-200' : 'border-border text-zinc-400 hover:bg-surface-light'
      }`}
    >
      {label}
      {count !== undefined && <span className={`ml-1.5 ${active ? 'text-indigo-300/80' : 'text-zinc-600'}`}>{count}</span>}
    </button>
  );
}

interface MemoryDraft {
  content: string;
  kind: MemoryKind;
  tags: string[];
  pinned: boolean;
}

function MemoryEditor({ initial, submitLabel, onSubmit, onCancel }: {
  initial: MemoryDraft;
  submitLabel: string;
  onSubmit: (draft: MemoryDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [content, setContent] = useState(initial.content);
  const [kind, setKind] = useState<MemoryKind>(initial.kind);
  const [tags, setTags] = useState(initial.tags.join(', '));
  const [pinned, setPinned] = useState(initial.pinned);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ content: content.trim(), kind, tags: tags.split(/[\s,]+/).filter(Boolean), pinned });
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };

  return (
    <Card className="border-indigo-400/30">
      <Field label="Memory">
        <textarea
          autoFocus
          className={`${INPUT_CLASS} min-h-[60px] resize-y`}
          value={content}
          maxLength={2000}
          onChange={e => setContent(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && content.trim()) void submit(); }}
          placeholder="One short fact, e.g. “Prefers window seats on flights”"
        />
      </Field>
      <div className="grid grid-cols-[160px_1fr] gap-3">
        <Field label="Kind">
          <select className={INPUT_CLASS} value={kind} onChange={e => setKind(e.target.value as MemoryKind)}>
            {MEMORY_KINDS.map(k => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
          </select>
        </Field>
        <Field label="Tags" hint="Optional keywords, separated by commas.">
          <input className={INPUT_CLASS} value={tags} onChange={e => setTags(e.target.value)} placeholder="travel, flights" />
        </Field>
      </div>
      <div className="flex items-center gap-2 text-[12px] text-zinc-300 mb-3">
        <Toggle on={pinned} onClick={() => setPinned(p => !p)} label="Pinned" />
        <span>Pinned — always part of the agent's instructions</span>
      </div>
      {error && <div className="mb-2"><ErrorNote message={error} /></div>}
      <div className="flex gap-2">
        <Button tone="primary" onClick={() => void submit()} disabled={busy || !content.trim()}>{busy ? 'Saving…' : submitLabel}</Button>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </Card>
  );
}

function MemoryRow({ item, onChange, onDelete }: {
  item: MemoryItem;
  onChange: (patch: Partial<MemoryDraft>) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { setError(message(err)); } finally { setBusy(false); }
  };

  if (editing) {
    return (
      <MemoryEditor
        initial={item}
        submitLabel="Save changes"
        onCancel={() => setEditing(false)}
        onSubmit={async draft => { await onChange(draft); setEditing(false); }}
      />
    );
  }

  return (
    <div className={`flex items-start gap-3 px-3 py-2.5 rounded-md border bg-surface ${item.pinned ? 'border-indigo-400/30' : 'border-border'}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-1 flex-wrap">
          <Pill tone={KIND_TONES[item.kind]}>{KIND_LABELS[item.kind]}</Pill>
          {item.pinned && <Pill tone="indigo">Pinned</Pill>}
          {item.tags.map(t => <span key={t} className="text-[11px] text-zinc-500">#{t}</span>)}
        </div>
        <div className="text-[12.5px] text-zinc-200 whitespace-pre-wrap break-words">{item.content}</div>
        <div className="text-[11px] text-zinc-600 mt-1">
          Saved {relativeTime(item.createdAt)}{item.source === 'agent' ? ' by the agent' : item.source === 'owner' ? ' by you' : ''}
          {item.updatedAt - item.createdAt > 60_000 && ` · edited ${relativeTime(item.updatedAt)}`}
          {item.lastUsedAt && ` · recalled ${relativeTime(item.lastUsedAt)}`}
        </div>
        {error && <div className="mt-1.5"><ErrorNote message={error} /></div>}
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        {confirming ? (
          <>
            <Button tone="danger" disabled={busy} onClick={() => void run(onDelete)}>Forget</Button>
            <Button disabled={busy} onClick={() => setConfirming(false)}>Keep</Button>
          </>
        ) : (
          <>
            <IconButton label={item.pinned ? 'Unpin' : 'Pin'} disabled={busy} onClick={() => void run(() => onChange({ pinned: !item.pinned }))}>
              {item.pinned ? <PinOff size={13} /> : <Pin size={13} />}
            </IconButton>
            <IconButton label="Edit" disabled={busy} onClick={() => setEditing(true)}><Pencil size={13} /></IconButton>
            <IconButton label="Forget" disabled={busy} onClick={() => setConfirming(true)}><Trash2 size={13} /></IconButton>
          </>
        )}
      </div>
    </div>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="w-7 h-7 grid place-items-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-surface-light transition-colors disabled:opacity-50"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

const TELEGRAM_HANDLE = /^(-?\d{3,20}|@?[A-Za-z][A-Za-z0-9_]{3,31})$/;
const PHONE = /^\+?[\d\s().-]{7,20}$/;

/** Client-side check per channel; the server stores the canonical form (E.164, JIDs, lowercase). */
const HANDLE_NORMALIZERS: Record<HandleChannel, (s: string) => string | null> = {
  whatsapp: normalizeWhatsAppInput,
  telegram: s => (TELEGRAM_HANDLE.test(s.trim()) ? s.trim() : null),
  email: s => (isValidEmail(s) ? s.trim().toLowerCase() : null),
  phone: s => (PHONE.test(s.trim()) && s.replace(/\D/g, '').length >= 8 ? s.trim() : null),
};

const HANDLE_HINTS: Record<HandleChannel, { placeholder: string; invalid: string }> = {
  whatsapp: { placeholder: 'Phone number or JID', invalid: 'Not a phone number or WhatsApp JID' },
  telegram: { placeholder: 'Chat id or @username', invalid: 'Not a Telegram chat id or @username' },
  email: { placeholder: 'name@example.com', invalid: 'Not an email address' },
  phone: { placeholder: '667 780 5604', invalid: 'Not a phone number' },
};

function PeoplePane({ api, refreshKey }: AgentSectionProps) {
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const debounced = useDebounced(query);
  const people = usePolled(() => agentMemory.people(api, debounced), [api, refreshKey, debounced]);
  const list = people.data?.people ?? [];

  return (
    <Section
      title="People"
      hint="Who you talk about and how to reach them. The agent sees names, relations and nicknames; it looks up numbers and addresses only when it needs them."
      action={!adding && <Button onClick={() => setAdding(true)}><Plus size={12} /> Add person</Button>}
    >
      <div className="flex items-center gap-2 mb-3">
        <SearchBox value={query} onChange={setQuery} placeholder="Search by name, nickname, relation or number" />
        {people.loading && people.data && <Loader2 size={13} className="animate-spin text-zinc-600 shrink-0" />}
      </div>
      {adding && (
        <div className="mb-3">
          <PersonEditor
            submitLabel="Add person"
            onCancel={() => setAdding(false)}
            onSubmit={async input => { await agentMemory.createPerson(api, input); setAdding(false); await people.reload(); }}
          />
        </div>
      )}
      {people.error && <div className="mb-2"><ErrorNote message={people.error} onRetry={() => void people.reload()} /></div>}
      {!people.data && people.loading ? (
        <Spinner />
      ) : list.length === 0 ? (
        <EmptyNote>{debounced.trim() ? 'Nobody matches that search.' : 'No people yet. The agent adds them as you mention them — or add someone here.'}</EmptyNote>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {list.map(p => (
            <PersonCard
              key={p.id}
              person={p}
              onSave={async input => { await agentMemory.updatePerson(api, p.id, input); await people.reload(); }}
              onDelete={async () => { await agentMemory.removePerson(api, p.id); await people.reload(); }}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

function PersonCard({ person, onSave, onDelete }: {
  person: Person;
  onSave: (input: PersonInput) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (editing) {
    return (
      <div className="md:col-span-2">
        <PersonEditor
          person={person}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={async input => { await onSave(input); setEditing(false); }}
        />
      </div>
    );
  }

  const channels = HANDLE_CHANNELS.filter(ch => person.handles[ch]?.length);
  return (
    <Card className="flex flex-col gap-1.5">
      <div className="flex items-start gap-2">
        <UserRound size={15} className="text-zinc-500 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-zinc-100 flex items-center gap-1.5 flex-wrap">
            <span className="truncate">{person.name}</span>
            {person.relation && <Pill>{person.relation}</Pill>}
          </div>
          {person.aliases.length > 0 && <div className="text-[11.5px] text-zinc-500 truncate">aka {person.aliases.join(', ')}</div>}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {confirming ? (
            <>
              <Button
                tone="danger"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  onDelete().catch(err => { setError(message(err)); setBusy(false); });
                }}
              >
                Delete
              </Button>
              <Button disabled={busy} onClick={() => setConfirming(false)}>Keep</Button>
            </>
          ) : (
            <>
              <IconButton label="Edit" onClick={() => setEditing(true)}><Pencil size={13} /></IconButton>
              <IconButton label="Delete" onClick={() => setConfirming(true)}><Trash2 size={13} /></IconButton>
            </>
          )}
        </div>
      </div>
      {channels.length > 0 && (
        <div className="flex flex-col gap-0.5 pl-[23px]">
          {channels.map(ch => (
            <div key={ch} className="text-[11.5px] flex gap-2 min-w-0">
              <span className="text-zinc-600 w-[62px] shrink-0">{HANDLE_LABELS[ch]}</span>
              <span className="text-zinc-300 truncate font-mono text-[11px]" title={person.handles[ch]!.join('\n')}>{person.handles[ch]!.join(', ')}</span>
            </div>
          ))}
        </div>
      )}
      {person.notes && <div className="text-[11.5px] text-zinc-400 whitespace-pre-wrap break-words line-clamp-3 pl-[23px]">{person.notes}</div>}
      {error && <ErrorNote message={error} />}
    </Card>
  );
}

function PersonEditor({ person, submitLabel, onSubmit, onCancel }: {
  person?: Person;
  submitLabel: string;
  onSubmit: (input: PersonInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(person?.name ?? '');
  const [relation, setRelation] = useState(person?.relation ?? '');
  const [aliases, setAliases] = useState((person?.aliases ?? []).join(', '));
  const [handles, setHandles] = useState<Record<HandleChannel, string[]>>(() => ({
    whatsapp: person?.handles.whatsapp ?? [],
    telegram: person?.handles.telegram ?? [],
    email: person?.handles.email ?? [],
    phone: person?.handles.phone ?? [],
  }));
  const [notes, setNotes] = useState(person?.notes ?? '');
  const [pending, setPending] = useState<Partial<Record<HandleChannel, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stable per channel, so ListInput's "pending text" effect doesn't re-run on every render.
  const pendingSetters = useMemo(
    () => Object.fromEntries(HANDLE_CHANNELS.map(ch => [ch, (p: boolean) => setPending(s => (s[ch] === p ? s : { ...s, [ch]: p }))])) as Record<HandleChannel, (p: boolean) => void>,
    [],
  );

  const hasPending = Object.values(pending).some(Boolean);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        relation: relation.trim(),
        aliases: aliases.split(',').map(a => a.trim()).filter(Boolean),
        handles,
        notes: notes.trim(),
      });
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };

  return (
    <Card className="border-indigo-400/30">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <input autoFocus className={INPUT_CLASS} value={name} maxLength={120} onChange={e => setName(e.target.value)} placeholder="Ana López" />
        </Field>
        <Field label="Relation">
          <input className={INPUT_CLASS} value={relation} maxLength={80} onChange={e => setRelation(e.target.value)} placeholder="wife, brother, dentist…" />
        </Field>
      </div>
      <Field label="Nicknames" hint="What you call them, separated by commas — the agent recognises these when you write.">
        <input className={INPUT_CLASS} value={aliases} onChange={e => setAliases(e.target.value)} placeholder="esposita, Anita" />
      </Field>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-3">
        {HANDLE_CHANNELS.map(ch => (
          <div key={ch} className="mb-3">
            <span className={LABEL_CLASS}>{HANDLE_LABELS[ch]}</span>
            <ListInput
              label={`Add a ${HANDLE_LABELS[ch]} handle`}
              values={handles[ch]}
              onChange={v => setHandles(h => ({ ...h, [ch]: v }))}
              normalize={HANDLE_NORMALIZERS[ch]}
              invalidMessage={HANDLE_HINTS[ch].invalid}
              placeholder={HANDLE_HINTS[ch].placeholder}
              onPendingChange={pendingSetters[ch]}
            />
          </div>
        ))}
      </div>
      <Field label="Notes" hint="Durable details: birthday, kids' names, how they like to be contacted. Never passwords.">
        <textarea className={`${INPUT_CLASS} min-h-[56px] resize-y`} value={notes} maxLength={2000} onChange={e => setNotes(e.target.value)} />
      </Field>
      {error && <div className="mb-2"><ErrorNote message={error} /></div>}
      <div className="flex items-center gap-2">
        <Button tone="primary" onClick={() => void submit()} disabled={busy || !name.trim() || hasPending}>{busy ? 'Saving…' : submitLabel}</Button>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        {hasPending && <span className="text-[11px] text-zinc-500">Press Enter to add the handle you're typing.</span>}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Fresh threads
// ---------------------------------------------------------------------------

const OUTCOME_TEXT: Record<ConsolidationOutcome, string> = {
  done: 'The agent reviewed the conversation',
  timeout: 'The agent took too long — the fresh thread started anyway',
  failed: "Couldn't reach the agent — the fresh thread started anyway",
  nothing_new: 'Nothing new since the previous thread',
  disabled: 'Skipped (turned off below)',
  unavailable: 'Skipped (the agent was not running)',
};

function formatIn(ts: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleString();
  }
}

function ThreadsPane({ api, refreshKey }: AgentSectionProps) {
  const [fast, setFast] = useState(false);
  const status = usePolled(() => agentMemory.status(api), [api, refreshKey, fast], fast ? 2_000 : 15_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);

  const rotating = !!status.data?.state.rotating;
  useEffect(() => { if (fast && status.data && !status.data.state.rotating) setFast(false); }, [fast, status.data]);
  useEffect(() => { if (status.data) setTime(status.data.settings.dailyRotation.time); }, [status.data?.settings.dailyRotation.time]); // eslint-disable-line react-hooks/exhaustive-deps

  if (status.loading && !status.data) return <Spinner />;
  if (status.error && !status.data) return <ErrorNote message={status.error} onRetry={() => void status.reload()} />;
  const s = status.data!;

  const save = async (patch: Parameters<typeof agentMemory.saveSettings>[1]) => {
    setBusy(true);
    setError(null);
    try {
      status.setData(await agentMemory.saveSettings(api, patch));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res: MemoryStatus = await agentMemory.rotateNow(api);
      status.setData(res);
      setFast(true);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const last = s.state.lastConsolidation;
  const daily = s.settings.dailyRotation;

  return (
    <>
      <Section
        title="Fresh threads"
        hint="A long conversation gets compacted again and again and the agent starts to drift. A fresh thread starts from an empty context — memory carries over."
      >
        <Card className="mb-2.5">
          {/* Toggle last, like every other setting row in the Agent view. */}
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] text-zinc-200">Start a fresh thread every day</div>
              <div className="text-[11px] text-zinc-500">
                At this time in {s.state.timezone}, once you've been quiet for at least 2 hours — if you're still chatting, it waits. Skipped when nothing new happened.
              </div>
            </div>
            <input
              type="time"
              aria-label="Daily fresh thread time"
              step={60}
              value={time ?? daily.time}
              disabled={busy || !daily.enabled}
              onChange={e => setTime(e.target.value)}
              onBlur={() => { if (time && time !== daily.time && /^\d{2}:\d{2}$/.test(time)) void save({ dailyRotation: { time } }); }}
              className={`${INPUT_BASE_CLASS} w-[128px] shrink-0 [color-scheme:dark]`}
            />
            <Toggle on={daily.enabled} disabled={busy} onClick={() => void save({ dailyRotation: { enabled: !daily.enabled } })} label="Start a fresh thread every day" />
          </div>
          {daily.enabled && (
            <div className="text-[11px] text-zinc-500 mt-2">
              {s.state.waitingForQuiet
                ? "Today's fresh thread is due — waiting for 2 quiet hours."
                : s.state.nextAt ? `Next: ${formatIn(s.state.nextAt, s.state.timezone)} (${relativeTime(s.state.nextAt)}).` : null}
            </div>
          )}
        </Card>

        <Card className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] text-zinc-200">Save what it learned first</div>
            <div className="text-[11px] text-zinc-500">Before every fresh thread — daily, /new, or the button below — the agent gets one turn (up to 2 minutes) to save lasting facts with its memory tools.</div>
          </div>
          <Toggle on={s.settings.consolidateOnRotate} disabled={busy} onClick={() => void save({ consolidateOnRotate: !s.settings.consolidateOnRotate })} label="Save what it learned first" />
        </Card>
      </Section>

      <Section title="Now">
        <Card>
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0 text-[12px] text-zinc-300">
              <div>Last fresh thread: <span className="text-zinc-200">{s.state.lastRotatedAt ? relativeTime(s.state.lastRotatedAt) : 'never'}</span></div>
              {last && (
                <div className="text-[11.5px] text-zinc-500 mt-0.5">
                  {OUTCOME_TEXT[last.outcome]}
                  {last.outcome === 'done' || last.outcome === 'timeout' ? ` · ${last.saved ? `${last.saved} memor${last.saved === 1 ? 'y' : 'ies'} saved or updated` : 'nothing new to save'}` : ''}
                  {` · ${last.reason} · ${relativeTime(last.at)}`}
                </div>
              )}
            </div>
            <Button tone="primary" disabled={busy || rotating} onClick={() => void rotate()}>
              {rotating ? <><Loader2 size={12} className="animate-spin" /> Saving what it learned…</> : <><RefreshCw size={12} /> Start a fresh thread now</>}
            </Button>
          </div>
        </Card>
      </Section>
      {error && <ErrorNote message={error} />}
    </>
  );
}
