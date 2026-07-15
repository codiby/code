import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, Search, Plus, Trash2, X } from 'lucide-react';
import type {
  ClaudeClient,
  SkillSummary,
  SkillScope,
  SkillSource,
} from '../lib/claude-client';

interface Props {
  open: boolean;
  onClose: () => void;
  client: ClaudeClient | null;
  /** Active session cwd — used as `root` for project-scoped skills. */
  projectRoot?: string | null;
}

type ScopeFilter = 'all' | 'user' | 'project';

/** The editable working copy shown in the detail pane. */
interface Draft {
  isNew: boolean;
  id?: string;
  name: string;
  description: string;
  allowedTools: string[];
  body: string;
  source: SkillSource;
  scope: SkillScope;
  path?: string;
}

const SOURCE_BADGE: Record<SkillSource, string> = {
  claude: 'bg-violet-400/15 text-violet-300',
  opencode: 'bg-teal-400/15 text-teal-300',
  agent: 'bg-amber-400/15 text-amber-300',
};

/** Snapshot of the fields that count as "changed" for dirty tracking. */
function snapshot(d: Draft): string {
  return JSON.stringify({ name: d.name, description: d.description, allowedTools: d.allowedTools, body: d.body });
}

export function SkillsModal({ open, onClose, client, projectRoot }: Props) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<ScopeFilter>('all');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingTool, setAddingTool] = useState(false);
  const toolInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    const [userSkills, projSkills] = await Promise.all([
      client.listSkills('user'),
      projectRoot ? client.listSkills('project', projectRoot) : Promise.resolve<SkillSummary[]>([]),
    ]);
    setSkills([...userSkills, ...projSkills]);
    setLoading(false);
  }, [client, projectRoot]);

  // (Re)load whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    setDraft(null);
    setError(null);
    void load();
  }, [open, load]);

  // Escape-to-close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const dirty = useMemo(() => {
    if (!draft) return false;
    return draft.isNew ? draft.name.trim() !== '' : snapshot(draft) !== baseline;
  }, [draft, baseline]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills
      .filter(s => filter === 'all' || s.scope === filter)
      .filter(s => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
  }, [skills, filter, query]);

  const selectSkill = useCallback(async (s: SkillSummary) => {
    if (!client) return;
    setError(null);
    const full = await client.getSkill(s.id);
    if (!full) { setError('Could not load skill.'); return; }
    const d: Draft = {
      isNew: false, id: full.id, name: full.name, description: full.description,
      allowedTools: full.allowedTools ?? [], body: full.body ?? '',
      source: full.source, scope: full.scope, path: full.path,
    };
    setDraft(d);
    setBaseline(snapshot(d));
  }, [client]);

  const startNew = useCallback(() => {
    const scope: SkillScope = filter === 'project' && projectRoot ? 'project' : 'user';
    setError(null);
    setDraft({ isNew: true, name: '', description: '', allowedTools: [], body: '# New skill\n\n', source: 'claude', scope });
    setBaseline('');
  }, [filter, projectRoot]);

  const save = useCallback(async () => {
    if (!client || !draft || !dirty || saving) return;
    setSaving(true);
    setError(null);
    if (draft.isNew) {
      const root = draft.scope === 'project' ? projectRoot ?? null : null;
      if (draft.scope === 'project' && !root) { setError('No project root for the active session.'); setSaving(false); return; }
      const res = await client.createSkill(draft.scope, root, {
        name: draft.name.trim(), description: draft.description, body: draft.body,
        source: draft.source, allowedTools: draft.allowedTools, format: 'dir',
      });
      if ('error' in res) { setError(res.error); }
      else { await load(); await selectSkill(res); }
    } else {
      const res = await client.updateSkill(draft.id!, {
        name: draft.name, description: draft.description, body: draft.body, allowedTools: draft.allowedTools,
      });
      if ('error' in res) { setError(res.error); }
      else { setBaseline(snapshot(draft)); await load(); }
    }
    setSaving(false);
  }, [client, draft, dirty, saving, projectRoot, load, selectSkill]);

  const del = useCallback(async (s: SkillSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!client) return;
    if (!window.confirm(`Delete skill “${s.name}”? This removes it from disk.`)) return;
    await client.deleteSkill(s.id);
    setDraft(prev => (prev && prev.id === s.id ? null : prev));
    await load();
  }, [client, load]);

  const patch = (p: Partial<Draft>) => setDraft(d => (d ? { ...d, ...p } : d));

  const removeTool = (tool: string) => patch({ allowedTools: draft?.allowedTools.filter(t => t !== tool) ?? [] });
  const commitTool = () => {
    const v = toolInputRef.current?.value.trim();
    if (v && draft && !draft.allowedTools.includes(v)) patch({ allowedTools: [...draft.allowedTools, v] });
    if (toolInputRef.current) toolInputRef.current.value = '';
    setAddingTool(false);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog" aria-modal="true" aria-label="Skills"
    >
      <div className="flex flex-col bg-surface border border-border-light rounded-xl shadow-2xl overflow-hidden w-[1240px] max-w-[calc(100vw-32px)] h-[740px] max-h-[calc(100vh-32px)]">
        {/* Header */}
        <div className="flex items-center gap-2.5 h-[52px] px-4 border-b border-border shrink-0">
          <Sparkles size={18} className="text-violet-300" />
          <span className="text-sm font-semibold text-zinc-100">Skills</span>
          <span className="text-[11px] text-zinc-600">{shown.length} {shown.length === 1 ? 'skill' : 'skills'}</span>
          {draft && !draft.isNew && draft.path && (
            <span className="ml-auto text-[11px] text-zinc-600 font-mono truncate max-w-[46%]" title={draft.path}>{draft.path}</span>
          )}
          {draft?.isNew && <span className="ml-auto text-[11px] text-violet-300/80 font-mono">New skill</span>}
          <button
            type="button" onClick={onClose}
            className={`${draft ? 'ml-3' : 'ml-auto'} w-7 h-7 rounded-md flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-surface-lighter shrink-0`}
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Left — list */}
          <div className="w-[270px] border-r border-border flex flex-col shrink-0">
            <div className="p-3 border-b border-border flex flex-col gap-2.5">
              <div className="flex items-center gap-2 bg-base border border-border rounded-md px-2.5 py-1.5">
                <Search size={14} className="text-zinc-600 shrink-0" />
                <input
                  value={query} onChange={e => setQuery(e.target.value)}
                  placeholder="Search skills…"
                  className="bg-transparent border-none outline-none text-[12px] text-zinc-200 w-full placeholder:text-zinc-600"
                />
              </div>
              <div className="flex gap-1">
                {(['all', 'user', 'project'] as ScopeFilter[]).map(f => (
                  <button
                    key={f} type="button" onClick={() => setFilter(f)}
                    disabled={f === 'project' && !projectRoot}
                    className={`text-[11px] px-2.5 py-1 rounded capitalize border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                      filter === f ? 'bg-surface-lighter text-zinc-200 border-border-light' : 'text-zinc-500 border-transparent hover:text-zinc-300'
                    }`}
                  >{f}</button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-1.5">
              {loading && <div className="text-[12px] text-zinc-600 px-2 py-3">Loading…</div>}
              {!loading && shown.length === 0 && <div className="text-[12px] text-zinc-600 px-2 py-3">No skills found.</div>}
              {shown.map(s => (
                <div
                  key={s.id} onClick={() => selectSkill(s)}
                  className={`group relative px-2.5 py-2 rounded-md cursor-pointer border ${
                    draft?.id === s.id ? 'bg-surface-light border-border-light' : 'border-transparent hover:bg-surface-light'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12.5px] font-semibold text-zinc-200 truncate">{s.name}</span>
                    <span className={`text-[9px] font-semibold px-1.5 py-px rounded uppercase tracking-wide ${SOURCE_BADGE[s.source]}`}>{s.source}</span>
                  </div>
                  <div className="text-[11px] text-zinc-500 mt-1 leading-snug line-clamp-2">{s.description || <span className="italic text-zinc-600">No description</span>}</div>
                  <button
                    type="button" title="Delete skill" onClick={(e) => del(s, e)}
                    className="absolute top-1/2 right-2 -translate-y-1/2 w-[26px] h-[26px] rounded-md flex items-center justify-center text-zinc-500 bg-surface-lighter opacity-0 group-hover:opacity-100 hover:!text-red-400 hover:!bg-red-400/12 transition-opacity"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>

            <button
              type="button" onClick={startNew}
              className="m-2 flex items-center justify-center gap-1.5 h-[34px] border border-dashed border-border-light rounded-md text-[12px] font-semibold text-zinc-400 hover:text-violet-300 hover:border-violet-300 transition-colors"
            >
              <Plus size={14} /> New skill
            </button>
          </div>

          {/* Right — detail / editor */}
          {!draft ? (
            <div className="flex-1 flex items-center justify-center text-[12px] text-zinc-600">
              Select a skill to view and edit, or create a new one.
            </div>
          ) : (
            <div className="flex-1 flex gap-[18px] p-4 overflow-hidden">
              {/* Left col: name + content */}
              <div className="flex-1 min-w-0 flex flex-col gap-3.5">
                <div className="shrink-0">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold mb-1.5">Name</div>
                  <input
                    value={draft.name} onChange={e => patch({ name: e.target.value })}
                    placeholder="skill-name"
                    className="w-full bg-base border border-border rounded-md px-2.5 py-2 text-[12.5px] text-zinc-200 outline-none focus:border-violet-500 placeholder:text-zinc-600"
                  />
                </div>
                <div className="flex-1 flex flex-col min-h-0">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold mb-1.5 flex items-center justify-between">
                    <span>Content</span>
                    <span className="font-mono text-zinc-700 tracking-normal">{draft.source === 'agent' ? 'skill.md' : 'SKILL.md'} · markdown</span>
                  </div>
                  <textarea
                    value={draft.body} onChange={e => patch({ body: e.target.value })}
                    spellCheck={false}
                    className="flex-1 w-full bg-base border border-border rounded-lg px-4 py-3.5 text-[12.5px] leading-relaxed text-zinc-300 font-mono outline-none focus:border-violet-500 resize-none"
                  />
                </div>
              </div>

              {/* Right col: source/scope + description + tools + save */}
              <div className="w-[260px] shrink-0 flex flex-col gap-3.5 overflow-y-auto">
                {draft.isNew ? (
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold mb-1.5">Source</div>
                      <select
                        value={draft.source} onChange={e => patch({ source: e.target.value as SkillSource })}
                        className="w-full bg-base border border-border rounded-md px-2 py-1.5 text-[12px] text-zinc-200 outline-none focus:border-violet-500"
                      >
                        <option value="claude">claude</option>
                        <option value="opencode">opencode</option>
                        <option value="agent">agent</option>
                      </select>
                    </div>
                    <div className="flex-1">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold mb-1.5">Scope</div>
                      <select
                        value={draft.scope} onChange={e => patch({ scope: e.target.value as SkillScope })}
                        className="w-full bg-base border border-border rounded-md px-2 py-1.5 text-[12px] text-zinc-200 outline-none focus:border-violet-500"
                      >
                        <option value="user">user</option>
                        <option value="project" disabled={!projectRoot}>project</option>
                      </select>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[9px] font-semibold px-1.5 py-px rounded uppercase tracking-wide ${SOURCE_BADGE[draft.source]}`}>{draft.source}</span>
                    <span className="text-[9px] font-semibold px-1.5 py-px rounded uppercase tracking-wide bg-surface-lighter text-zinc-400">{draft.scope}</span>
                  </div>
                )}

                <div>
                  <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold mb-1.5">Description</div>
                  <textarea
                    value={draft.description} onChange={e => patch({ description: e.target.value })}
                    placeholder="What this skill does and when to use it."
                    className="w-full h-[90px] bg-base border border-border rounded-md px-2.5 py-2 text-[12.5px] leading-snug text-zinc-200 outline-none focus:border-violet-500 resize-none placeholder:text-zinc-600"
                  />
                </div>

                <div>
                  <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold mb-1.5">Allowed tools</div>
                  <div className="flex flex-wrap gap-1.5 items-center">
                    {draft.allowedTools.map(t => (
                      <span key={t} className="text-[11px] bg-base border border-border rounded px-2 py-0.5 text-zinc-400 font-mono flex items-center gap-1.5">
                        {t}
                        <button type="button" onClick={() => removeTool(t)} className="text-zinc-600 hover:text-red-400 flex"><X size={11} /></button>
                      </span>
                    ))}
                    {addingTool ? (
                      <input
                        ref={toolInputRef} autoFocus
                        onKeyDown={e => { if (e.key === 'Enter') commitTool(); if (e.key === 'Escape') setAddingTool(false); }}
                        onBlur={commitTool}
                        placeholder="Bash"
                        className="text-[11px] bg-base border border-violet-500 rounded px-2 py-0.5 text-zinc-200 font-mono outline-none w-20"
                      />
                    ) : (
                      <button type="button" onClick={() => setAddingTool(true)} className="text-[11px] text-zinc-600 border border-dashed border-border-light rounded px-2 py-0.5 hover:text-violet-300 hover:border-violet-300">+ add tool</button>
                    )}
                  </div>
                </div>

                {/* Actions pinned to bottom */}
                <div className="mt-auto pt-3.5 border-t border-border flex flex-col gap-2.5">
                  {error && <div className="text-[11px] text-red-400">{error}</div>}
                  {dirty && <div className="text-[11px] text-amber-400">● Unsaved changes</div>}
                  <button
                    type="button" onClick={save} disabled={!dirty || saving}
                    className={`w-full text-center text-[12px] font-semibold py-2 rounded-md border transition-colors ${
                      dirty && !saving
                        ? 'bg-violet-500 border-violet-500 text-white hover:bg-violet-600 cursor-pointer'
                        : 'bg-surface-lighter border-border text-zinc-600 cursor-not-allowed'
                    }`}
                  >
                    {saving ? 'Saving…' : draft.isNew ? 'Create skill' : 'Save changes'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
