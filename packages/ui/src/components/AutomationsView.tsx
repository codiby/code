import { useMemo, useState } from 'react';
import { Zap, Plus, Clock, Bot, ListFilter, Trash2, X } from 'lucide-react';
import { useAutomations, automations, KIND_META, type Automation, type AutomationKind } from '../lib/automations';

// The Automatizaciones screen — definitions of cron jobs, scheduled agents and
// event rules. Mounted in the main pane (replacing the session workspace) when
// the sidebar's "Automatizaciones" nav item is active.
//
// This is the definitions UI: create / enable / disable / delete. The actual
// scheduler that fires these lives in the backend and is wired separately.

const KIND_ICON: Record<AutomationKind, typeof Clock> = {
  cron: Clock,
  agent: Bot,
  rule: ListFilter,
};

const KIND_ACCENT: Record<AutomationKind, string> = {
  cron: 'bg-blue-500/12 text-blue-400',
  agent: 'bg-green-500/12 text-green-400',
  rule: 'bg-violet-500/12 text-violet-400',
};

const ORDER: AutomationKind[] = ['cron', 'agent', 'rule'];

function relTime(ts?: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'ahora';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function StatusPill({ a }: { a: Automation }) {
  if (!a.enabled)
    return <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full border text-zinc-500 bg-zinc-500/10 border-zinc-500/30">Pausada</span>;
  if (a.lastRunOk === false)
    return <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full border text-red-400 bg-red-500/10 border-red-400/30">Falló</span>;
  return <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full border text-green-400 bg-green-500/10 border-green-400/30">Activa</span>;
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={on ? 'Pausar' : 'Activar'}
      className={`relative w-[34px] h-[19px] rounded-full shrink-0 border transition-colors ${on ? 'bg-indigo-400/40 border-transparent' : 'bg-surface-lighter border-border-light'}`}
    >
      <span className={`absolute top-[1px] w-[15px] h-[15px] rounded-full transition-all ${on ? 'left-[16px] bg-indigo-400' : 'left-[1px] bg-zinc-300'}`} />
    </button>
  );
}

function AutomationRow({ a }: { a: Automation }) {
  const Icon = KIND_ICON[a.kind];
  return (
    <div className="group flex items-center gap-3.5 bg-surface border border-border rounded-lg px-3.5 py-3 hover:border-border-light hover:bg-surface-light transition-colors">
      <div className={`w-8 h-8 rounded-md grid place-items-center shrink-0 ${KIND_ACCENT[a.kind]}`}>
        <Icon size={16} strokeWidth={2} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-[13px] font-medium text-zinc-200">
          <span className="truncate">{a.name}</span>
          <StatusPill a={a} />
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500 mt-0.5">
          {a.schedule && <span>{a.schedule}</span>}
          {a.cron && <code className="font-mono text-[10px] text-zinc-400 bg-base border border-border rounded px-1.5 py-px">{a.cron}</code>}
          {a.trigger && <span>Disparador: {a.trigger}</span>}
          {a.action && <span>{a.action}</span>}
          {a.groupName && <span>grupo: {a.groupName}</span>}
          {a.model && <span>modelo: {a.model}</span>}
        </div>
      </div>
      <div className="text-[11px] text-zinc-500 text-right shrink-0 min-w-[96px] hidden sm:block">
        {a.lastRunAt ? (
          <div className={a.lastRunOk === false ? 'text-red-400' : 'text-green-400'}>
            último: {a.lastRunOk === false ? 'error' : 'ok'} · {relTime(a.lastRunAt)}
          </div>
        ) : (
          <div className="text-zinc-600">sin ejecuciones</div>
        )}
      </div>
      <Toggle on={a.enabled} onClick={() => automations.toggle(a.id)} />
      <button
        type="button"
        onClick={() => automations.remove(a.id)}
        title="Eliminar"
        className="w-6 h-6 grid place-items-center rounded text-zinc-600 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition"
      >
        <Trash2 size={13} strokeWidth={2} />
      </button>
    </div>
  );
}

interface CreateDraft {
  name: string;
  kind: AutomationKind;
  schedule: string;
  cron: string;
  trigger: string;
  cwd: string;
  prompt: string;
}

const EMPTY_DRAFT: CreateDraft = { name: '', kind: 'cron', schedule: '', cron: '', trigger: '', cwd: '', prompt: '' };

function CreateForm({ initialKind, onClose }: { initialKind: AutomationKind; onClose: () => void }) {
  const [draft, setDraft] = useState<CreateDraft>({ ...EMPTY_DRAFT, kind: initialKind });
  const set = <K extends keyof CreateDraft>(k: K, v: CreateDraft[K]) => setDraft(d => ({ ...d, [k]: v }));
  const canSave = draft.name.trim().length > 0;

  const save = () => {
    if (!canSave) return;
    automations.add({
      name: draft.name.trim(),
      kind: draft.kind,
      enabled: true,
      schedule: draft.schedule.trim() || undefined,
      cron: draft.kind === 'cron' ? draft.cron.trim() || undefined : undefined,
      trigger: draft.kind === 'rule' ? draft.trigger.trim() || undefined : undefined,
      cwd: draft.cwd.trim() || undefined,
      prompt: draft.prompt.trim() || undefined,
    });
    onClose();
  };

  const input = 'w-full bg-base border border-border rounded-md px-2.5 py-1.5 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-400/50';
  const label = 'text-[10px] uppercase tracking-wide text-zinc-600 font-semibold mb-1 block';

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center pt-[12vh] px-4" onClick={onClose}>
      <div
        className="w-full max-w-[460px] bg-surface border border-border-light rounded-xl shadow-2xl p-5"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[14px] font-semibold text-zinc-200">Nueva automatización</h2>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-zinc-200"><X size={16} /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className={label}>Nombre</label>
            <input className={input} value={draft.name} autoFocus placeholder="Resumen diario de PRs" onChange={e => set('name', e.target.value)} />
          </div>

          <div>
            <label className={label}>Tipo</label>
            <div className="flex gap-1.5">
              {ORDER.map(k => (
                <button
                  key={k}
                  type="button"
                  onClick={() => set('kind', k)}
                  className={`flex-1 text-[12px] py-1.5 rounded-md border transition ${draft.kind === k ? 'bg-surface-light border-indigo-400/50 text-zinc-100' : 'border-border text-zinc-500 hover:text-zinc-300'}`}
                >
                  {KIND_META[k].label}
                </button>
              ))}
            </div>
          </div>

          {draft.kind === 'rule' ? (
            <div>
              <label className={label}>Disparador</label>
              <input className={input} value={draft.trigger} placeholder="Sesión completa" onChange={e => set('trigger', e.target.value)} />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Cadencia</label>
                <input className={input} value={draft.schedule} placeholder="Cada día · 9:00" onChange={e => set('schedule', e.target.value)} />
              </div>
              {draft.kind === 'cron' && (
                <div>
                  <label className={label}>Cron</label>
                  <input className={`${input} font-mono`} value={draft.cron} placeholder="0 9 * * *" onChange={e => set('cron', e.target.value)} />
                </div>
              )}
            </div>
          )}

          <div>
            <label className={label}>Carpeta (cwd)</label>
            <input className={`${input} font-mono`} value={draft.cwd} placeholder="/Users/jovaz/src/taskr" onChange={e => set('cwd', e.target.value)} />
          </div>

          <div>
            <label className={label}>Prompt</label>
            <textarea className={`${input} resize-none h-[64px]`} value={draft.prompt} placeholder="Qué debe hacer el agente…" onChange={e => set('prompt', e.target.value)} />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} className="text-[12px] px-3 py-1.5 rounded-md text-zinc-400 hover:text-zinc-200">Cancelar</button>
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            className="text-[12px] font-medium px-3.5 py-1.5 rounded-md bg-indigo-400 text-[#0f1012] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Crear
          </button>
        </div>
      </div>
    </div>
  );
}

export function AutomationsView() {
  const list = useAutomations();
  const [creating, setCreating] = useState<null | AutomationKind>(null);

  const stats = useMemo(() => {
    const active = list.filter(a => a.enabled).length;
    const paused = list.length - active;
    const failed = list.filter(a => a.enabled && a.lastRunOk === false).length;
    return { active, paused, failed };
  }, [list]);

  const byKind = useMemo(() => {
    const m: Record<AutomationKind, Automation[]> = { cron: [], agent: [], rule: [] };
    for (const a of list) m[a.kind].push(a);
    return m;
  }, [list]);

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-base">
      {/* Top bar */}
      <div className="h-12 border-b border-border flex items-center justify-between px-5 shrink-0">
        <h1 className="text-[15px] font-semibold text-zinc-200 flex items-center gap-2">
          <Zap size={16} strokeWidth={2} className="text-indigo-400" />
          Automatizaciones
          <span className="text-[11px] text-zinc-600 font-normal ml-1">tareas programadas, agentes y reglas</span>
        </h1>
        <button
          type="button"
          onClick={() => setCreating('cron')}
          className="inline-flex items-center gap-1.5 h-[30px] px-3 rounded-md text-[12px] font-medium bg-indigo-400 text-[#0f1012] hover:brightness-110"
        >
          <Plus size={13} strokeWidth={2.4} />
          Nueva automatización
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-[18px]">
        {list.length === 0 ? (
          <EmptyState onPick={k => setCreating(k)} />
        ) : (
          <>
            {/* Stats */}
            <div className="flex gap-2.5 mb-[18px]">
              <Stat n={stats.active} label="Activas" tone="text-green-400" />
              <Stat n={stats.paused} label="Pausadas" />
              <Stat n={stats.failed} label="Fallos" tone={stats.failed ? 'text-red-400' : undefined} />
            </div>

            {ORDER.map(kind => {
              const items = byKind[kind];
              if (!items.length) return null;
              return (
                <div key={kind} className="mb-5">
                  <div className="text-[10px] uppercase tracking-wide text-zinc-600 font-semibold mb-2 px-0.5">
                    {KIND_META[kind].group}
                  </div>
                  <div className="flex flex-col gap-2">
                    {items.map(a => <AutomationRow key={a.id} a={a} />)}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {creating && <CreateForm initialKind={creating} onClose={() => setCreating(null)} />}
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <div className="flex-1 bg-surface border border-border rounded-lg px-3.5 py-3">
      <div className={`text-[20px] font-semibold leading-none ${tone || 'text-zinc-200'}`}>{n}</div>
      <div className="text-[11px] text-zinc-500 mt-1.5">{label}</div>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (k: AutomationKind) => void }) {
  const tmpls: { kind: AutomationKind; emoji: string; title: string; desc: string }[] = [
    { kind: 'cron', emoji: '⏱', title: 'Cron', desc: 'Ejecuta un prompt en un horario fijo' },
    { kind: 'agent', emoji: '🤖', title: 'Agente', desc: 'Tarea recurrente con un modelo y un grupo' },
    { kind: 'rule', emoji: '⚡', title: 'Regla', desc: 'Reacciona a un evento de una sesión' },
  ];
  return (
    <div className="max-w-[640px] mx-auto pt-[6vh] text-center">
      <div className="w-12 h-12 rounded-xl bg-indigo-500/12 grid place-items-center mx-auto mb-4">
        <Zap size={22} className="text-indigo-400" />
      </div>
      <h2 className="text-[15px] font-semibold text-zinc-200">Sin automatizaciones todavía</h2>
      <p className="text-[12px] text-zinc-500 mt-1.5 mb-6">Programa tareas, agentes recurrentes o reglas que reaccionan a eventos de tus sesiones.</p>
      <div className="flex gap-2.5 text-left">
        {tmpls.map(t => (
          <button
            key={t.kind}
            type="button"
            onClick={() => onPick(t.kind)}
            className="flex-1 border border-dashed border-border-light rounded-lg p-3 hover:border-indigo-400/60 transition group"
          >
            <div className="text-[12px] font-medium text-zinc-300 mb-1 group-hover:text-zinc-100">{t.emoji} {t.title}</div>
            <div className="text-[11px] text-zinc-500">{t.desc}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
