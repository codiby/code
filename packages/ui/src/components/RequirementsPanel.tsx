/**
 * Requirements panel — the session's Target plus the acceptance criteria the
 * server verifies on its own.
 *
 * The split that matters: the agent can only *append* requirements and propose
 * changes to the ones you approved. Approving, waiving, editing a locked check
 * and deleting all live in this panel and nowhere else. Status is never
 * editable here either — it is written by the runner and signed, so the panel
 * shows outcomes rather than letting anyone assert them.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, TextArea, TextField } from '@heroui/react';
import type {
  Requirement,
  RequirementEvent,
  RequirementProposal,
  RequirementsSnapshot,
} from '../lib/requirements';
import { progressLabel } from '../lib/requirements';

export type RequirementsPanelProps = {
  snapshot: RequirementsSnapshot | null;
  /** Ids currently executing, so a per-row spinner can beat the WS round-trip. */
  runningIds: string[];
  onSetTarget: (target: string) => void;
  onSetState: (rid: string, action: 'lock' | 'unlock' | 'waive', reason?: string) => void;
  onEdit: (rid: string, patch: { title?: string; check?: unknown }) => void;
  onDelete: (rid: string) => void;
  onRun: (ids?: string[]) => void;
  onResolveProposal: (pid: string, decision: 'approve' | 'reject') => void;
  onLoadEvents: () => Promise<RequirementEvent[]>;
  /** Resolve a server-side absolute image path into a data URL for <img>. */
  onLoadImage: (path: string) => Promise<string | null>;
  onClose: () => void;
  onToggleFullWidth: () => void;
};

const DOT: Record<string, string> = {
  passing: 'bg-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.15)]',
  failing: 'bg-red-400 shadow-[0_0_0_3px_rgba(248,113,113,0.15)]',
  running: 'bg-cyan-400 animate-pulse',
  pending: 'bg-zinc-600',
};

const STATE_CHIP: Record<string, string> = {
  locked: 'bg-surface-lighter text-zinc-400 border-transparent',
  draft: 'border-amber-400/40 text-amber-400',
  waived: 'border-border-light text-zinc-500',
  tampered: 'border-red-400/50 text-red-400 bg-red-400/10',
};

const STATE_LABEL: Record<string, string> = {
  locked: '🔒 aprobado',
  draft: 'borrador',
  waived: 'waived',
  tampered: '⚠ alterado',
};

const ACTOR_COLOR: Record<string, string> = {
  agent: 'text-violet-400',
  user: 'text-cyan-400',
  runner: 'text-zinc-400',
};

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function RequirementsPanel({
  snapshot, runningIds,
  onSetTarget, onSetState, onEdit, onDelete, onRun, onResolveProposal,
  onLoadEvents, onLoadImage, onClose, onToggleFullWidth,
}: RequirementsPanelProps) {
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetDraft, setTargetDraft] = useState('');
  const [events, setEvents] = useState<RequirementEvent[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const requirements = snapshot?.requirements ?? [];
  const proposals = snapshot?.proposals ?? [];
  const progress = snapshot?.progress;
  const running = useMemo(() => new Set(runningIds), [runningIds]);

  // The host passes fresh closures every render, so the fetchers live in refs:
  // depending on them directly would re-run the effect on every setState and
  // spin forever.
  const loadEventsRef = useRef(onLoadEvents);
  loadEventsRef.current = onLoadEvents;

  useEffect(() => {
    if (!historyOpen) return;
    let alive = true;
    loadEventsRef.current().then(list => { if (alive) setEvents(list); });
    return () => { alive = false; };
    // Re-fetch when the snapshot moves so the trail stays current while open.
  }, [historyOpen, snapshot]);

  const saveTarget = () => {
    const next = targetDraft.trim();
    if (next) onSetTarget(next);
    setEditingTarget(false);
  };

  const anyRunnable = requirements.some(r => r.state === 'draft' || r.state === 'locked');

  return (
    <div className="h-full w-full min-h-0 flex flex-col bg-surface text-zinc-200 overflow-hidden">
      {/* header */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-border flex-shrink-0"
        onDoubleClick={onToggleFullWidth}
      >
        <span className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold">Requerimientos</span>
        {progress && (
          <span className="text-[11px] text-zinc-400">{progressLabel(progress)}</span>
        )}
        <div className="flex-1" />
        <Button
          size="sm"
          isDisabled={!anyRunnable}
          className="text-[11px] h-auto px-2 py-1 rounded border border-cyan-400/45 text-cyan-300 bg-transparent hover:bg-cyan-400/10 disabled:opacity-40"
          onPress={() => onRun()}
        >
          ▶ Correr todo
        </Button>
        <Button
          isIconOnly size="sm" variant="ghost"
          className="text-zinc-500 hover:text-zinc-200 text-sm px-1 h-auto min-w-0"
          onPress={onClose}
          aria-label="Cerrar requerimientos"
        >
          ✕
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Target */}
        <section className="border-b border-border">
          <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-1">
            <span className="text-[10px] uppercase tracking-[0.09em] text-zinc-500 font-semibold">Objetivo</span>
            <div className="flex-1" />
            {!editingTarget && (
              <button
                className="text-[11px] text-zinc-500 hover:text-zinc-200 px-1.5 py-0.5 rounded hover:bg-surface-lighter"
                onClick={() => { setTargetDraft(snapshot?.target ?? ''); setEditingTarget(true); }}
              >
                editar
              </button>
            )}
          </div>
          {editingTarget ? (
            <div className="px-3.5 pb-3 flex flex-col gap-2">
              <TextField value={targetDraft} onChange={setTargetDraft} aria-label="Objetivo de la sesión">
                <TextArea
                  autoFocus
                  rows={3}
                  className="block w-full text-[13px] bg-base border border-border-light rounded p-2 text-zinc-200 resize-y placeholder:text-zinc-600"
                  placeholder="Qué se busca construir en esta sesión, en lenguaje llano."
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') { e.preventDefault(); setEditingTarget(false); }
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveTarget(); }
                  }}
                />
              </TextField>
              <div className="flex gap-2">
                <Button size="sm" className="text-[11px] h-auto px-2 py-1 rounded bg-violet-600 hover:bg-violet-500 text-white" onPress={saveTarget}>
                  Guardar
                </Button>
                <Button size="sm" variant="ghost" className="text-[11px] h-auto px-2 py-1 text-zinc-400" onPress={() => setEditingTarget(false)}>
                  Cancelar
                </Button>
              </div>
            </div>
          ) : (
            <p className={`px-3.5 pb-3.5 text-[13px] leading-relaxed ${snapshot?.target ? 'text-zinc-200' : 'text-zinc-500 italic'}`}>
              {snapshot?.target || 'Sin objetivo todavía — el agente lo define con set_target, o lo escribes tú.'}
            </p>
          )}
        </section>

        {/* Proposals */}
        {proposals.length > 0 && (
          <section className="border-b border-border pb-1">
            <div className="px-3.5 pt-2.5 pb-1.5 text-[10px] uppercase tracking-[0.09em] text-zinc-500 font-semibold">
              Pendientes de aprobación <span className="text-amber-400">{proposals.length}</span>
            </div>
            {proposals.map(p => (
              <ProposalCard
                key={p.id}
                proposal={p}
                requirement={requirements.find(r => r.id === p.requirementId)}
                onResolve={onResolveProposal}
              />
            ))}
          </section>
        )}

        {/* Progress bar */}
        {progress && progress.total > 0 && (
          <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-border">
            <div className="flex-1 h-[5px] rounded bg-surface-lighter flex overflow-hidden gap-px">
              <Bar n={progress.passing} className="bg-emerald-400" />
              <Bar n={progress.failing} className="bg-red-400" />
              {/* Cyan means "executing right now". A requirement that is merely
                  approved-but-never-run is dim: a full cyan bar on an untouched
                  list reads as work in progress when nothing is happening. */}
              <Bar n={Math.min(running.size, progress.pending)} className="bg-cyan-400 animate-pulse" />
              <Bar n={progress.pending - Math.min(running.size, progress.pending)} className="bg-zinc-600/60" />
              <Bar n={progress.draft} className="bg-amber-400/50" />
              <Bar n={progress.waived + progress.tampered} className="bg-zinc-700/50" />
            </div>
            <span className="text-[11px] text-zinc-400 whitespace-nowrap">{progressLabel(progress)}</span>
          </div>
        )}

        {/* List */}
        {requirements.length === 0 ? (
          <p className="px-3.5 py-6 text-[12px] text-zinc-500 leading-relaxed">
            Todavía no hay requerimientos. Pídele al agente que los defina — solo puede agregarlos,
            y no cuentan hasta que los apruebes aquí.
          </p>
        ) : (
          requirements.map(r => (
            <RequirementRow
              key={r.id}
              requirement={r}
              running={running.has(r.id)}
              onSetState={onSetState}
              onEdit={onEdit}
              onDelete={onDelete}
              onRun={onRun}
              onLoadImage={onLoadImage}
            />
          ))
        )}

        {/* History */}
        <section className="border-t border-border">
          <button
            className="w-full flex items-center gap-2 px-3.5 py-2.5 text-[10px] uppercase tracking-[0.09em] text-zinc-500 font-semibold hover:text-zinc-300"
            onClick={() => setHistoryOpen(o => !o)}
          >
            Historial
            <span className={`transition-transform ${historyOpen ? 'rotate-90' : ''}`}>▸</span>
          </button>
          {historyOpen && (
            <div className="px-3.5 pb-4 flex flex-col gap-0.5">
              {events === null && <span className="text-[11px] text-zinc-600">cargando…</span>}
              {events?.length === 0 && <span className="text-[11px] text-zinc-600">sin eventos</span>}
              {events?.map(e => (
                <div key={e.id} className="flex gap-2.5 text-[11px] items-baseline">
                  <span className="w-10 flex-shrink-0 text-zinc-600 tabular-nums">{timeLabel(e.createdAt)}</span>
                  <span className={`w-12 flex-shrink-0 ${ACTOR_COLOR[e.actor] ?? 'text-zinc-500'}`}>{e.actor}</span>
                  <span className="text-zinc-400 min-w-0 break-words">
                    {e.event}{e.detail ? ` — ${e.detail}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Bar({ n, className }: { n: number; className: string }) {
  if (n <= 0) return null;
  return <i style={{ flex: n }} className={`block h-full ${className}`} />;
}

function ProposalCard({
  proposal, requirement, onResolve,
}: {
  proposal: RequirementProposal;
  requirement?: Requirement;
  onResolve: (pid: string, decision: 'approve' | 'reject') => void;
}) {
  const verb = proposal.action === 'waive' ? 'saltarse' : proposal.action === 'delete' ? 'borrar' : 'editar';
  return (
    <div className="mx-3.5 mb-3 px-3 py-2.5 rounded-lg border border-amber-400/30 bg-amber-400/[0.06]">
      <div className="text-[12px] text-zinc-200 mb-1">
        <span className="inline-block px-1.5 py-px mr-1.5 rounded text-[10px] uppercase tracking-wide bg-amber-400/20 text-amber-300">
          {proposal.action}
        </span>
        {requirement?.title ?? proposal.requirementId}
      </div>
      <p className="text-[11.5px] text-zinc-400 leading-relaxed mb-2">
        El agente pide {verb} este requerimiento: <q className="text-zinc-200 italic">{proposal.reason}</q>
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          className="text-[11px] h-auto px-2 py-1 rounded border border-emerald-400/45 text-emerald-300 bg-transparent hover:bg-emerald-400/10"
          onPress={() => onResolve(proposal.id, 'approve')}
        >
          Aprobar
        </Button>
        <Button
          size="sm"
          className="text-[11px] h-auto px-2 py-1 rounded border border-border-light text-zinc-300 bg-surface-light hover:bg-surface-lighter"
          onPress={() => onResolve(proposal.id, 'reject')}
        >
          Rechazar
        </Button>
      </div>
    </div>
  );
}

function RequirementRow({
  requirement: r, running,
  onSetState, onEdit, onDelete, onRun, onLoadImage,
}: {
  requirement: Requirement;
  running: boolean;
  onSetState: RequirementsPanelProps['onSetState'];
  onEdit: RequirementsPanelProps['onEdit'];
  onDelete: RequirementsPanelProps['onDelete'];
  onRun: RequirementsPanelProps['onRun'];
  onLoadImage: RequirementsPanelProps['onLoadImage'];
}) {
  const [outputOpen, setOutputOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(r.title);
  const [commandDraft, setCommandDraft] = useState(r.command ?? '');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const status = running ? 'running' : r.status;
  const isCommand = r.kind === 'command';
  const failed = r.status === 'failing' || r.state === 'tampered';

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick, true);
    return () => document.removeEventListener('mousedown', onDocClick, true);
  }, [menuOpen]);

  const saveEdit = () => {
    const patch: { title?: string; check?: unknown } = {};
    if (titleDraft.trim() && titleDraft.trim() !== r.title) patch.title = titleDraft.trim();
    if (isCommand && commandDraft.trim() && commandDraft.trim() !== r.command) {
      patch.check = { type: 'command', command: commandDraft.trim(), timeoutMs: r.timeoutMs ?? undefined };
    }
    if (Object.keys(patch).length) onEdit(r.id, patch);
    setEditing(false);
  };

  return (
    <div className={`group px-3.5 pt-3 pb-3 border-t border-border ${r.state === 'tampered' ? 'bg-red-400/[0.06]' : 'hover:bg-white/[0.02]'}`}>
      <div className="flex items-center gap-2.5">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${DOT[status] ?? DOT.pending}`} />
        <span className={`flex-1 min-w-0 truncate text-[12.5px] ${r.state === 'waived' ? 'line-through text-zinc-500' : 'text-zinc-200'}`}>
          {r.title}
        </span>
        <span className={`text-[10px] px-1.5 py-px rounded border flex-shrink-0 ${STATE_CHIP[r.state] ?? ''}`}>
          {STATE_LABEL[r.state] ?? r.state}
        </span>
        <div className="flex gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {(r.state === 'draft' || r.state === 'locked') && (
            <button
              title="Correr este requerimiento"
              className="w-[22px] h-[22px] grid place-items-center rounded text-zinc-500 hover:bg-surface-lighter hover:text-zinc-200 text-[11px]"
              onClick={() => onRun([r.id])}
            >
              ▶
            </button>
          )}
          <div className="relative" ref={menuRef}>
            <button
              title="Más"
              className="w-[22px] h-[22px] grid place-items-center rounded text-zinc-500 hover:bg-surface-lighter hover:text-zinc-200 text-[11px]"
              onClick={() => setMenuOpen(o => !o)}
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 z-20 min-w-[170px] bg-[#1f1f1f] border border-border-light rounded-md shadow-xl overflow-hidden text-[11.5px]">
                {r.state === 'draft' && (
                  <MenuItem label="Aprobar" onClick={() => { onSetState(r.id, 'lock'); setMenuOpen(false); }} />
                )}
                {r.state === 'locked' && (
                  <MenuItem label="Devolver a borrador" onClick={() => { onSetState(r.id, 'unlock'); setMenuOpen(false); }} />
                )}
                {r.state !== 'waived' && r.state !== 'tampered' && (
                  <MenuItem
                    label="Waive…"
                    onClick={() => {
                      const reason = window.prompt('¿Por qué se salta este requerimiento?');
                      if (reason?.trim()) onSetState(r.id, 'waive', reason.trim());
                      setMenuOpen(false);
                    }}
                  />
                )}
                <MenuItem label="Editar" onClick={() => { setEditing(true); setMenuOpen(false); }} />
                <MenuItem
                  label="Borrar"
                  danger
                  onClick={() => { onDelete(r.id); setMenuOpen(false); }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-1.5 ml-[17px]">
        {editing ? (
          <div className="flex flex-col gap-2 pr-2">
            <TextField value={titleDraft} onChange={setTitleDraft} aria-label="Título del requerimiento">
              <Input className="block w-full text-[12px] bg-base border border-border-light rounded px-2 py-1 text-zinc-200" />
            </TextField>
            {isCommand && (
              <TextField value={commandDraft} onChange={setCommandDraft} aria-label="Comando de verificación">
                <Input className="block w-full text-[11px] font-mono bg-base border border-border-light rounded px-2 py-1 text-zinc-300" />
              </TextField>
            )}
            <div className="flex gap-2">
              <Button size="sm" className="text-[11px] h-auto px-2 py-1 rounded bg-violet-600 hover:bg-violet-500 text-white" onPress={saveEdit}>
                Guardar
              </Button>
              <Button size="sm" variant="ghost" className="text-[11px] h-auto px-2 py-1 text-zinc-400" onPress={() => setEditing(false)}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : isCommand ? (
          <div className={`font-mono text-[11px] ${r.state === 'tampered' ? 'text-zinc-600 line-through' : 'text-zinc-400'}`}>
            <span className="text-zinc-600 mr-1.5 font-sans text-[10.5px]">$</span>
            {r.command}
            {r.lastExitCode != null && r.lastExitCode !== 0 && (
              <span className="text-red-400 ml-1.5">(exit {r.lastExitCode})</span>
            )}
          </div>
        ) : (
          <p className="text-[11.5px] text-zinc-400 leading-relaxed">
            <span className="text-zinc-600 mr-1.5">👁 visual</span>
            {r.judgePrompt}
          </p>
        )}

        {r.state === 'waived' && r.waiverReason && (
          <p className="mt-1.5 text-[11.5px] text-zinc-600">Aceptaste saltarlo: “{r.waiverReason}”</p>
        )}

        {/* Visual evidence */}
        {r.kind === 'visual' && (r.imagePath || r.lastImagePath) && (
          <div className="flex gap-2.5 mt-2.5">
            {r.imagePath && (
              <Thumb path={r.imagePath} caption="referencia" onLoadImage={onLoadImage} />
            )}
            {r.lastImagePath && (
              <Thumb path={r.lastImagePath} caption="captura de esta corrida" failed={failed} onLoadImage={onLoadImage} />
            )}
          </div>
        )}

        {/* Verdict */}
        {r.lastVerdict && (
          <div className={`mt-2 text-[11.5px] leading-relaxed flex gap-1.5 ${failed ? 'text-red-400' : 'text-emerald-400'}`}>
            <span className="flex-shrink-0">{failed ? (r.state === 'tampered' ? '⚠' : '✗') : '✓'}</span>
            <span className="text-zinc-400">{r.lastVerdict}</span>
          </div>
        )}

        {/* Command output, collapsed unless it failed */}
        {isCommand && r.lastOutput && (
          <>
            <button
              className="mt-1.5 text-[11px] text-zinc-600 hover:text-zinc-400 inline-flex items-center gap-1.5"
              onClick={() => setOutputOpen(o => !o)}
            >
              <span className={`inline-block transition-transform ${outputOpen || failed ? 'rotate-90' : ''}`}>▸</span>
              salida
            </button>
            {(outputOpen || failed) && (
              <pre className="mt-1.5 bg-base border border-border rounded px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-zinc-400 overflow-x-auto whitespace-pre">
                {r.lastOutput}
              </pre>
            )}
          </>
        )}

        {/* Degenerate-check warning: the user is the only gate on check quality,
            so a command that cannot fail has to be loud at approval time. */}
        {r.degenerateWarning && r.state !== 'waived' && (
          <div className="mt-2 flex gap-1.5 items-start text-[11px] text-amber-400 bg-amber-400/[0.08] border border-amber-400/20 rounded px-2 py-1.5">
            <span>⚠</span><span>{r.degenerateWarning}</span>
          </div>
        )}

        {r.state === 'draft' && !editing && (
          <div className="mt-2.5 flex gap-2 items-center">
            <Button
              size="sm"
              className="text-[11px] h-auto px-2 py-1 rounded border border-emerald-400/45 text-emerald-300 bg-transparent hover:bg-emerald-400/10"
              onPress={() => onSetState(r.id, 'lock')}
            >
              Aprobar requerimiento
            </Button>
            <span className="text-[10.5px] text-zinc-600">no cuenta hasta que lo apruebes</span>
          </div>
        )}
      </div>
    </div>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      className={`w-full text-left px-3 py-1.5 hover:bg-surface-lighter ${danger ? 'text-red-400' : 'text-zinc-300'}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** Lazily resolves a server-side path into a data URL so <img> can show it. */
function Thumb({
  path, caption, failed, onLoadImage,
}: {
  path: string;
  caption: string;
  failed?: boolean;
  onLoadImage: (p: string) => Promise<string | null>;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  // Same reason as `loadEventsRef`: keying the effect on the prop identity
  // would refetch the image on every render.
  const loadImageRef = useRef(onLoadImage);
  loadImageRef.current = onLoadImage;

  useEffect(() => {
    let alive = true;
    loadImageRef.current(path).then(url => { if (alive) setSrc(url); });
    return () => { alive = false; };
  }, [path]);

  return (
    <>
      <div className="w-[132px]">
        <div
          className={`h-20 rounded border overflow-hidden bg-base cursor-zoom-in grid place-items-center ${failed ? 'border-red-400/40' : 'border-border-light'} hover:border-violet-400`}
          onClick={() => src && setZoom(true)}
        >
          {src
            ? <img src={src} alt={caption} className="w-full h-full object-cover object-top" />
            : <span className="text-[10px] text-zinc-600">sin imagen</span>}
        </div>
        <div className="text-[10px] text-zinc-600 mt-1 text-center">{caption}</div>
      </div>
      {zoom && src && (
        <div
          className="fixed inset-0 z-50 bg-black/80 grid place-items-center p-8 cursor-zoom-out"
          onClick={() => setZoom(false)}
        >
          <img src={src} alt={caption} className="max-w-full max-h-full rounded shadow-2xl" />
        </div>
      )}
    </>
  );
}
