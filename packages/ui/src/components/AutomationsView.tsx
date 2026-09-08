import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Zap, Plus, Clock, Play, Trash2, X, Pencil, Copy, AlertTriangle,
  Loader2, ArrowUpRight, RotateCw, Webhook, Check,
} from 'lucide-react';
import type {
  Automation,
  AutomationEffort,
  AutomationInput,
  AutomationPermissionMode,
  AutomationRun,
  AutomationRunStatus,
  AutomationTriggerType,
  ClaudeClient,
} from '../lib/claude-client';
import {
  CRON_PRESETS,
  EFFORT_LABEL,
  FAILING_STATUSES,
  PERMISSION_MODE_META,
  RUNTIME_PRESETS,
  RUN_STATUS_META,
  formatCost,
  formatDuration,
  formatTokens,
  humanizeCron,
  nextCronRuns,
  relativeFuture,
  relativePast,
  shortPath,
  shortStamp,
  RUN_TRIGGER_LABEL,
  TRIGGER_TYPE_META,
  webhookCurl,
  webhookUrl,
} from '../lib/automations';

// The Automatizaciones screen — cron-scheduled prompts that the bridge runs on
// its own, with no session open. Mounted in the main pane (replacing the
// session workspace) when the sidebar's "Automatizaciones" nav item is active.
//
// Everything here is server state: definitions come from `GET /automations` and
// history from `GET /automations/:id/runs`. There is no local store — the
// scheduler is the source of truth, so the view polls instead of caching.

/** Runs pulled per automation for the row sparkline. */
const SPARK_WINDOW = 20;
/** Runs pulled for the drawer's history + its aggregate KPIs. */
const HISTORY_PAGE = 50;
/** Poll cadence. Runs flip status without any client action, so the list has to re-read. */
const POLL_MS = 15_000;

const PROVIDERS = ['claude', 'codex', 'opencode'];
const EFFORTS: AutomationEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSION_MODES: AutomationPermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

const INPUT_CLASS =
  'w-full bg-base border border-border rounded-md px-2.5 py-1.5 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-400/50';
const LABEL_CLASS = 'text-[10px] uppercase tracking-wide text-zinc-600 font-semibold mb-1.5 block';

interface Props {
  client: ClaudeClient | null;
  /** Pre-fills the working directory of a new automation. */
  defaultCwd?: string | null;
  /** Opens the session an automation run spawned, when it still exists. */
  onOpenSession?: (sessionId: string) => void;
}

export function AutomationsView({ client, defaultCwd, onOpenSession }: Props) {
  const [items, setItems] = useState<Automation[]>([]);
  const [sparks, setSparks] = useState<Record<string, AutomationRun[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ mode: 'create' | 'edit'; source?: Automation } | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (showSpinner = false) => {
    if (!client) return;
    if (showSpinner) setLoading(true);
    try {
      const list = await client.listAutomations();
      setItems(list);
      setError(null);
      // One request per automation. The bridge is local and the list is
      // hand-authored, so this stays cheap; if it ever grows, the fix is a
      // batch endpoint rather than dropping the sparkline.
      const pairs = await Promise.all(list.map(async a => {
        const { runs } = await client.listAutomationRuns(a.id, { limit: SPARK_WINDOW });
        return [a.id, runs] as const;
      }));
      setSparks(Object.fromEntries(pairs));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { void load(true); }, [load]);

  useEffect(() => {
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const selected = useMemo(
    () => items.find(a => a.id === selectedId) ?? null,
    [items, selectedId],
  );

  const stats = useMemo(() => {
    const dayAgo = Date.now() - 86_400_000;
    let active = 0, running = 0, failing = 0;
    for (const a of items) {
      if (a.enabled) active++;
      const runs = sparks[a.id] ?? [];
      if (runs.some(r => r.status === 'running' || r.status === 'scheduled')) running++;
      if (runs.some(r => FAILING_STATUSES.includes(r.status) && r.createdAt >= dayAgo)) failing++;
    }
    return { active, paused: items.length - active, running, failing };
  }, [items, sparks]);

  const mutate = useCallback(async (id: string, fn: () => Promise<unknown>) => {
    setBusy(b => ({ ...b, [id]: true }));
    try {
      await fn();
      await load();
    } finally {
      setBusy(b => ({ ...b, [id]: false }));
    }
  }, [load]);

  const handleToggle = (a: Automation) => mutate(a.id, async () => {
    const res = await client?.updateAutomation(a.id, { enabled: !a.enabled });
    if (res && 'error' in res) setNotice(res.error);
  });

  const handleRunNow = (a: Automation) => mutate(a.id, async () => {
    const res = await client?.runAutomation(a.id);
    if (res?.skipped) setNotice(`"${a.name}" ya tenía una ejecución en curso, así que esta se saltó.`);
    else if (res?.error) setNotice(res.error);
  });

  const handleDelete = (a: Automation) => {
    if (!window.confirm(`¿Eliminar “${a.name}”? Su historial de ejecuciones deja de mostrarse.`)) return;
    if (selectedId === a.id) setSelectedId(null);
    return mutate(a.id, async () => { await client?.deleteAutomation(a.id); });
  };

  const handleSave = async (input: AutomationInput, id?: string) => {
    const res = id ? await client?.updateAutomation(id, input) : await client?.createAutomation(input);
    if (res && 'error' in res) return res.error;
    setEditor(null);
    await load();
    return null;
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-base">
      <div className="h-12 border-b border-border flex items-center justify-between px-5 shrink-0">
        <h1 className="text-[15px] font-semibold text-zinc-200 flex items-center gap-2">
          <Zap size={16} strokeWidth={2} className="text-indigo-400" />
          Automatizaciones
          <span className="text-[11px] text-zinc-600 font-normal ml-1">prompts que corren solos en un horario</span>
        </h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load(true)}
            title="Recargar"
            className="w-7 h-7 grid place-items-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-surface-light transition-colors"
          >
            <RotateCw size={13} strokeWidth={2} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button
            type="button"
            onClick={() => setEditor({ mode: 'create' })}
            className="inline-flex items-center gap-1.5 h-[30px] px-3 rounded-md text-[12px] font-medium bg-indigo-400 text-[#0f1012] hover:brightness-110"
          >
            <Plus size={13} strokeWidth={2.4} />
            Nueva automatización
          </button>
        </div>
      </div>

      {notice && (
        <div className="px-5 py-2 border-b border-border bg-amber-500/8 text-[11.5px] text-amber-300 flex items-center gap-2">
          <AlertTriangle size={13} className="shrink-0" />
          {notice}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-5 py-[18px]">
        {error ? (
          <div className="max-w-[520px] mx-auto mt-[10vh] text-center">
            <p className="text-[13px] text-zinc-300">No se pudo leer las automatizaciones</p>
            <p className="text-[11.5px] text-zinc-500 mt-1.5 font-mono">{error}</p>
            <button
              type="button"
              onClick={() => void load(true)}
              className="mt-4 text-[12px] px-3 py-1.5 rounded-md border border-border text-zinc-300 hover:bg-surface-light"
            >
              Reintentar
            </button>
          </div>
        ) : loading && items.length === 0 ? (
          <div className="flex items-center justify-center pt-[15vh] text-zinc-600">
            <Loader2 size={18} className="animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState onCreate={() => setEditor({ mode: 'create' })} />
        ) : (
          <>
            <div className="flex gap-2.5 mb-[18px]">
              <Stat n={stats.active} label="Activas" tone={stats.active ? 'text-green-400' : undefined} />
              <Stat n={stats.paused} label="Pausadas" />
              <Stat n={stats.running} label="Corriendo ahora" tone={stats.running ? 'text-indigo-400' : undefined} />
              <Stat n={stats.failing} label="Con fallos (24h)" tone={stats.failing ? 'text-red-400' : undefined} />
            </div>
            <div className="flex flex-col gap-2">
              {items.map(a => (
                <AutomationRow
                  key={a.id}
                  automation={a}
                  runs={sparks[a.id] ?? []}
                  busy={!!busy[a.id]}
                  onOpen={() => setSelectedId(a.id)}
                  onToggle={() => void handleToggle(a)}
                  onRunNow={() => void handleRunNow(a)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {selected && (
        <AutomationDrawer
          key={selected.id}
          client={client}
          automation={selected}
          busy={!!busy[selected.id]}
          onClose={() => setSelectedId(null)}
          onToggle={() => void handleToggle(selected)}
          onRunNow={() => void handleRunNow(selected)}
          onEdit={() => setEditor({ mode: 'edit', source: selected })}
          onDuplicate={() => setEditor({ mode: 'create', source: selected })}
          onDelete={() => void handleDelete(selected)}
          onOpenSession={onOpenSession}
        />
      )}

      {editor && (
        <AutomationEditor
          mode={editor.mode}
          source={editor.source}
          client={client}
          defaultCwd={defaultCwd}
          onCancel={() => setEditor(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function Stat({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <div className="flex-1 bg-surface border border-border rounded-lg px-3.5 py-3">
      <div className={`text-[20px] font-semibold leading-none ${tone || 'text-zinc-200'}`}>{n}</div>
      <div className="text-[11px] text-zinc-500 mt-1.5">{label}</div>
    </div>
  );
}

/** Health pill — the *definition's* state, derived from its most recent run. */
function StatusPill({ automation, runs }: { automation: Automation; runs: AutomationRun[] }) {
  const base = 'text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full border whitespace-nowrap';
  if (runs.some(r => r.status === 'running')) {
    return <span className={`${base} text-indigo-400 bg-indigo-500/12 border-indigo-400/35`}>Corriendo</span>;
  }
  if (!automation.enabled) {
    return <span className={`${base} text-zinc-500 bg-zinc-500/10 border-zinc-500/30`}>Pausada</span>;
  }
  const last = runs.find(r => r.status !== 'scheduled');
  if (last && FAILING_STATUSES.includes(last.status)) {
    return <span className={`${base} text-red-400 bg-red-500/10 border-red-400/30`}>{RUN_STATUS_META[last.status].label}</span>;
  }
  return <span className={`${base} text-green-400 bg-green-500/10 border-green-400/30`}>Activa</span>;
}

/**
 * Oldest-to-newest strip of the recent runs. A streak of red is visible here
 * without opening anything, which is the whole point of paying for the extra
 * request per row.
 */
function RunStrip({ runs }: { runs: AutomationRun[] }) {
  if (!runs.length) return <span className="text-[11px] text-zinc-600">sin historial</span>;
  return (
    <div className="flex gap-[2px] items-end" title={runs.length === 1 ? '1 ejecución reciente' : `${runs.length} ejecuciones recientes`}>
      {[...runs].reverse().map(r => (
        <span
          key={r.id}
          className={`w-1 h-3.5 rounded-[1px] ${RUN_STATUS_META[r.status].tick} ${r.status === 'running' ? 'animate-pulse' : ''}`}
        />
      ))}
    </div>
  );
}

function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={on ? 'Pausar' : 'Activar'}
      aria-label={on ? 'Pausar automatización' : 'Activar automatización'}
      className={`relative w-[34px] h-[19px] rounded-full shrink-0 border transition-colors disabled:opacity-50 ${
        on ? 'bg-indigo-400/40 border-transparent' : 'bg-surface-lighter border-border-light'
      }`}
    >
      <span className={`absolute top-[1px] w-[15px] h-[15px] rounded-full transition-all ${on ? 'left-[16px] bg-indigo-400' : 'left-[1px] bg-zinc-300'}`} />
    </button>
  );
}

function AutomationRow({ automation, runs, busy, onOpen, onToggle, onRunNow }: {
  automation: Automation;
  runs: AutomationRun[];
  busy: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onRunNow: () => void;
}) {
  const last = runs.find(r => r.status !== 'scheduled' && r.status !== 'running');
  const running = runs.some(r => r.status === 'running');
  const isWebhook = automation.triggerType === 'webhook';
  const humanized = automation.cronExpression ? humanizeCron(automation.cronExpression) : '';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      className={`group flex items-center gap-3.5 bg-surface border border-border rounded-lg px-3.5 py-3 cursor-pointer hover:border-border-light hover:bg-surface-light transition-colors ${automation.enabled ? '' : 'opacity-60'}`}
    >
      <div className={`w-8 h-8 rounded-md grid place-items-center shrink-0 ${automation.enabled ? 'bg-indigo-500/12 text-indigo-400' : 'bg-zinc-500/12 text-zinc-500'}`}>
        {isWebhook ? <Webhook size={16} strokeWidth={2} /> : <Clock size={16} strokeWidth={2} />}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-[13px] font-medium text-zinc-200">
          <span className="truncate">{automation.name}</span>
          <StatusPill automation={automation} runs={runs} />
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-500 mt-1">
          {isWebhook ? (
            <span>Al llamar su webhook</span>
          ) : (
            <>
              {/* `humanizeCron` echoes the expression back when it can't read it —
                  showing both would just print the same string twice. */}
              {humanized !== automation.cronExpression && <span>{humanized}</span>}
              <code className="font-mono text-[10px] text-zinc-400 bg-base border border-border rounded px-1.5 py-px">
                {automation.cronExpression}
              </code>
              <span className="text-[10px] text-zinc-400 bg-base border border-border rounded px-1.5 py-px">
                {automation.timezone}
              </span>
            </>
          )}
          <span className="text-zinc-700">·</span>
          <span className="font-mono text-[10.5px] truncate max-w-[220px]">{shortPath(automation.cwd)}</span>
          <span className="text-zinc-700">·</span>
          <span>{automation.provider}{automation.model ? ` · ${automation.model}` : ''}</span>
        </div>
      </div>

      <div className="w-[120px] shrink-0 hidden lg:block">
        <RunStrip runs={runs} />
        <div className={`text-[11px] mt-1 ${running ? 'text-indigo-400' : last ? RUN_STATUS_META[last.status].tone : 'text-zinc-600'}`}>
          {running
            ? 'corriendo…'
            : last
              ? `${RUN_STATUS_META[last.status].label.toLowerCase()} · ${relativePast(last.createdAt)}`
              : 'sin ejecuciones'}
        </div>
      </div>

      <div className="w-[128px] shrink-0 text-right text-[11px] text-zinc-500 hidden md:block">
        {/* A webhook automation has no next run to count down to — what matters
            is whether it is listening at all. */}
        {isWebhook ? (
          <>
            <b className="block text-zinc-400 font-medium">
              {automation.enabled ? 'A la espera' : '—'}
            </b>
            {automation.enabled ? 'de su webhook' : 'pausada'}
          </>
        ) : (
          <>
            <b className="block text-zinc-400 font-medium">
              {automation.enabled ? relativeFuture(automation.nextRunAt) : '—'}
            </b>
            {automation.enabled ? shortStamp(automation.nextRunAt) : 'pausada'}
          </>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
        <button
          type="button"
          onClick={onRunNow}
          disabled={busy}
          title="Ejecutar ahora"
          aria-label="Ejecutar ahora"
          className="w-[26px] h-[26px] grid place-items-center rounded-md text-zinc-600 hover:text-zinc-100 hover:bg-surface-lighter disabled:opacity-40 transition-colors"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} strokeWidth={2} fill="currentColor" />}
        </button>
        <Toggle on={automation.enabled} onClick={onToggle} disabled={busy} />
      </div>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="max-w-[620px] mx-auto pt-[6vh] text-center">
      <div className="w-12 h-12 rounded-xl bg-indigo-500/12 grid place-items-center mx-auto mb-4">
        <Zap size={22} className="text-indigo-400" />
      </div>
      <h2 className="text-[15px] font-semibold text-zinc-200">Sin automatizaciones todavía</h2>
      <p className="text-[12px] text-zinc-500 mt-1.5 mb-6">
        Una automatización corre un prompt en tu carpeta, en el horario que le pongas, sin que abras una sesión.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="inline-flex items-center gap-1.5 h-[30px] px-3.5 rounded-md text-[12px] font-medium bg-indigo-400 text-[#0f1012] hover:brightness-110"
      >
        <Plus size={13} strokeWidth={2.4} />
        Crear la primera
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

type RunFilter = 'all' | AutomationRunStatus;

function AutomationDrawer({
  client, automation, busy, onClose, onToggle, onRunNow, onEdit, onDuplicate, onDelete, onOpenSession,
}: {
  client: ClaudeClient | null;
  automation: Automation;
  busy: boolean;
  onClose: () => void;
  onToggle: () => void;
  onRunNow: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [filter, setFilter] = useState<RunFilter>('all');
  const [loading, setLoading] = useState(true);
  const [promptOpen, setPromptOpen] = useState(false);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  const fetchRuns = useCallback(async (append = false) => {
    if (!client) return;
    setLoading(true);
    const { runs: page, nextCursor } = await client.listAutomationRuns(automation.id, {
      limit: HISTORY_PAGE,
      status: filter === 'all' ? undefined : filter,
      before: append ? cursor ?? undefined : undefined,
    });
    setRuns(prev => (append ? [...prev, ...page] : page));
    setCursor(nextCursor);
    setLoading(false);
  }, [client, automation.id, filter, cursor]);

  // Re-reads whenever the filter changes; `fetchRuns` closes over `cursor`, so
  // the initial load is triggered off the primitive deps instead.
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!client) return;
      setLoading(true);
      const { runs: page, nextCursor } = await client.listAutomationRuns(automation.id, {
        limit: HISTORY_PAGE,
        status: filter === 'all' ? undefined : filter,
      });
      if (!alive) return;
      setRuns(page);
      setCursor(nextCursor);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [client, automation.id, filter]);

  const hasActiveRun = runs.some(r => r.status === 'running' || r.status === 'scheduled');

  // Poll the head of the history so a run fired from here — or by the scheduler
  // while the drawer is open — shows up and flips status without a reopen.
  // Merging by id keeps any older pages the user loaded with "Cargar más".
  useEffect(() => {
    if (!client) return;
    const timer = setInterval(async () => {
      const { runs: page } = await client.listAutomationRuns(automation.id, {
        limit: HISTORY_PAGE,
        status: filter === 'all' ? undefined : filter,
      });
      setRuns(prev => {
        const byId = new Map(prev.map(r => [r.id, r]));
        for (const r of page) byId.set(r.id, r);
        return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
      });
    }, hasActiveRun ? 3000 : POLL_MS);
    return () => clearInterval(timer);
  }, [client, automation.id, filter, hasActiveRun]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const kpis = useMemo(() => {
    const finished = runs.filter(r => r.status !== 'scheduled' && r.status !== 'running' && r.status !== 'skipped');
    const ok = finished.filter(r => r.status === 'succeeded').length;
    const cost = runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
    return {
      last: runs.find(r => r.status !== 'scheduled') ?? null,
      ok,
      total: finished.length,
      cost,
      perRun: finished.length ? cost / finished.length : 0,
    };
  }, [runs]);

  const handleCancel = async (run: AutomationRun) => {
    await client?.cancelAutomationRun(automation.id, run.id);
    await fetchRuns();
  };

  const isWebhook = automation.triggerType === 'webhook';
  const humanized = automation.cronExpression ? humanizeCron(automation.cronExpression) : '';

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      {/* `top-9` clears the app's fixed 36px titlebar, which sits at z-[9999]
          and would otherwise cover the drawer's own header. */}
      <div className="fixed top-9 right-0 bottom-0 z-50 w-[620px] max-w-[92vw] bg-surface border-l border-border-light flex flex-col">
        <div className="px-[18px] pt-4 pb-3.5 border-b border-border shrink-0">
          <div className="flex items-start gap-2.5">
            <div className="w-[30px] h-[30px] rounded-md grid place-items-center shrink-0 bg-indigo-500/12 text-indigo-400">
              <Clock size={15} strokeWidth={2} />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-[15px] font-semibold text-zinc-200 truncate">{automation.name}</h2>
              {automation.description && (
                <div className="text-[12px] text-zinc-500 mt-1">{automation.description}</div>
              )}
            </div>
            <Toggle on={automation.enabled} onClick={onToggle} disabled={busy} />
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="w-[26px] h-[26px] grid place-items-center rounded-md text-zinc-600 hover:text-zinc-100 hover:bg-surface-lighter"
            >
              <X size={15} />
            </button>
          </div>

          <div className="flex items-center gap-1.5 mt-3">
            <button
              type="button"
              onClick={onRunNow}
              disabled={busy}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] font-medium bg-indigo-400 text-[#0f1012] hover:brightness-110 disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={11} fill="currentColor" />}
              Ejecutar ahora
            </button>
            <DrawerAction icon={Pencil} label="Editar" onClick={onEdit} />
            <DrawerAction icon={Copy} label="Duplicar" onClick={onDuplicate} />
            <div className="flex-1" />
            <button
              type="button"
              onClick={onDelete}
              aria-label="Eliminar"
              title="Eliminar"
              className="w-[26px] h-[26px] grid place-items-center rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-500/10"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-[18px] py-4">
          <div className="grid grid-cols-4 gap-2 mb-4">
            {isWebhook ? (
              <Kpi
                label="Disparador"
                value={automation.enabled ? 'Webhook' : 'Pausada'}
                sub={automation.enabled ? 'a la espera de la llamada' : 'no responde llamadas'}
              />
            ) : (
              <Kpi label="Próxima" value={automation.enabled ? relativeFuture(automation.nextRunAt) : 'Pausada'}
                sub={automation.enabled ? shortStamp(automation.nextRunAt) : 'no está programada'} />
            )}
            <Kpi
              label="Última"
              value={kpis.last ? RUN_STATUS_META[kpis.last.status].label : '—'}
              valueTone={kpis.last ? RUN_STATUS_META[kpis.last.status].tone : undefined}
              sub={kpis.last ? `${relativePast(kpis.last.createdAt)} · ${formatDuration(kpis.last.durationMs)}` : 'sin ejecuciones'}
            />
            <Kpi
              label={`Éxito (${kpis.total})`}
              value={kpis.total ? `${kpis.ok}/${kpis.total}` : '—'}
              sub={kpis.total ? `${Math.round((kpis.ok / kpis.total) * 100)}%` : 'sin datos'}
            />
            <Kpi
              label="Coste"
              value={kpis.total ? formatCost(kpis.cost) : '—'}
              sub={kpis.total ? `~${formatCost(kpis.perRun)} / run` : 'sin datos'}
            />
          </div>

          {isWebhook && client && (
            <Section title="URL del webhook">
              <WebhookUrlBox origin={client.localServerUrl} automationId={automation.id} />
            </Section>
          )}

          <Section
            title="Prompt"
            action={<button type="button" className="text-[11px] text-indigo-400 hover:underline" onClick={() => setPromptOpen(o => !o)}>
              {promptOpen ? 'contraer' : 'expandir'}
            </button>}
          >
            <div className="bg-base border border-border rounded-md px-3 py-2.5">
              <pre className={`text-[12px] text-zinc-400 whitespace-pre-wrap font-sans leading-[1.55] ${promptOpen ? '' : 'max-h-20 overflow-hidden'}`}>
                {automation.prompt}
              </pre>
            </div>
          </Section>

          <Section title="Configuración">
            <dl className="bg-base border border-border rounded-md px-3 py-2.5 grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-2 text-[12px]">
              <dt className="text-zinc-600 whitespace-nowrap">Disparador</dt>
              <dd className="text-zinc-400">
                {isWebhook ? (
                  'Webhook — solo corre cuando algo llama a su URL'
                ) : (
                  <>
                    {humanized !== automation.cronExpression && `${humanized} · `}
                    <code className="font-mono text-[11px] text-zinc-300">{automation.cronExpression}</code> · {automation.timezone}
                  </>
                )}
              </dd>
              <dt className="text-zinc-600 whitespace-nowrap">Carpeta</dt>
              <dd className="text-zinc-400 font-mono text-[11px] truncate">{automation.cwd}</dd>
              <dt className="text-zinc-600 whitespace-nowrap">Agente</dt>
              <dd className="text-zinc-400">
                {automation.provider}
                {automation.model ? ` · ${automation.model}` : ''}
                {automation.effort ? ` · esfuerzo ${EFFORT_LABEL[automation.effort]}` : ''}
              </dd>
              <dt className="text-zinc-600 whitespace-nowrap">Permisos</dt>
              <dd className="text-zinc-400">
                {PERMISSION_MODE_META[automation.permissionMode].label}
                <span className="text-zinc-600"> — {PERMISSION_MODE_META[automation.permissionMode].hint}</span>
              </dd>
              <dt className="text-zinc-600 whitespace-nowrap">Límites</dt>
              <dd className="text-zinc-400">
                {automation.maxRuntimeMs
                  // Prefer the preset's own wording ("10 minutos") over the
                  // run-duration format, which reads oddly as a limit ("10m 00s").
                  ? `corta a los ${RUNTIME_PRESETS.find(p => p.ms === automation.maxRuntimeMs)?.label ?? formatDuration(automation.maxRuntimeMs)}`
                  : 'sin tiempo máximo'}
                {' · si ya hay una corriendo, '}<b className="font-medium text-zinc-300">se salta</b>
              </dd>
            </dl>
          </Section>

          <Section
            title="Ejecuciones"
            action={
              <div className="flex gap-1">
                {([['all', 'Todas'], ['failed', 'Fallidas'], ['skipped', 'Saltadas']] as [RunFilter, string][]).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setFilter(id)}
                    className={`text-[10px] px-2 py-[3px] rounded border transition-colors ${
                      filter === id ? 'bg-surface-lighter text-zinc-100 border-border-light' : 'text-zinc-500 border-transparent hover:text-zinc-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            }
          >
            {loading && runs.length === 0 ? (
              <div className="flex justify-center py-6 text-zinc-600"><Loader2 size={16} className="animate-spin" /></div>
            ) : runs.length === 0 ? (
              <div className="text-center py-6 text-[12px] text-zinc-600">
                {filter === 'all' ? 'Todavía no ha corrido ninguna vez.' : 'Ninguna ejecución con este estado.'}
              </div>
            ) : (
              <div className="flex flex-col gap-px bg-border border border-border rounded-md overflow-hidden">
                {runs.map(run => (
                  <RunRow
                    key={run.id}
                    run={run}
                    open={openRunId === run.id}
                    onToggle={() => setOpenRunId(id => (id === run.id ? null : run.id))}
                    onCancel={() => void handleCancel(run)}
                    onOpenSession={onOpenSession}
                  />
                ))}
              </div>
            )}
            {cursor && (
              <button
                type="button"
                onClick={() => void fetchRuns(true)}
                className="mt-2.5 text-[11px] text-indigo-400 hover:underline"
              >
                Cargar más ↓
              </button>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}

/**
 * The callable endpoint for a webhook automation, with copy buttons for both
 * the bare URL and a ready-to-run curl. Shown wherever a user might want to
 * hand it to a watcher.
 */
function WebhookUrlBox({ origin, automationId }: { origin: string; automationId: string }) {
  const [copied, setCopied] = useState<'url' | 'curl' | null>(null);
  const url = webhookUrl(origin, automationId);

  const copy = async (what: 'url' | 'curl') => {
    try {
      await navigator.clipboard.writeText(what === 'url' ? url : webhookCurl(origin, automationId));
      setCopied(what);
      setTimeout(() => setCopied(c => (c === what ? null : c)), 1800);
    } catch { /* clipboard blocked — the text is selectable either way */ }
  };

  return (
    <div className="bg-base border border-border rounded-md px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-surface-lighter text-zinc-400 shrink-0">
          POST
        </span>
        <code className="font-mono text-[11px] text-zinc-300 flex-1 min-w-0 truncate select-all" title={url}>
          {url}
        </code>
        <CopyButton label="Copiar URL" done={copied === 'url'} onClick={() => void copy('url')} />
      </div>
      <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-border">
        <span className="text-[11px] text-zinc-600">
          Llámala desde tu watcher cuando ocurra el evento.
        </span>
        <button
          type="button"
          onClick={() => void copy('curl')}
          className="text-[11px] text-indigo-400 hover:underline shrink-0"
        >
          {copied === 'curl' ? 'curl copiado' : 'copiar curl'}
        </button>
      </div>
    </div>
  );
}

function CopyButton({ label, done, onClick }: { label: string; done: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`w-[26px] h-[26px] grid place-items-center rounded-md shrink-0 transition-colors ${
        done ? 'text-green-400' : 'text-zinc-600 hover:text-zinc-100 hover:bg-surface-lighter'
      }`}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function DrawerAction({ icon: Icon, label, onClick }: { icon: typeof Pencil; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] text-zinc-400 border border-border hover:bg-surface-light hover:text-zinc-100 hover:border-border-light transition-colors"
    >
      <Icon size={12} />
      {label}
    </button>
  );
}

function Kpi({ label, value, valueTone, sub }: { label: string; value: string; valueTone?: string; sub: string }) {
  return (
    <div className="bg-base border border-border rounded-md px-2.5 py-2">
      <div className="text-[9px] uppercase tracking-wide text-zinc-600 font-semibold">{label}</div>
      <div className={`text-[13px] font-medium mt-1.5 ${valueTone || 'text-zinc-200'}`}>{value}</div>
      <div className="text-[11px] text-zinc-500">{sub}</div>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mb-[18px]">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-wide text-zinc-600 font-semibold">{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

function RunRow({ run, open, onToggle, onCancel, onOpenSession }: {
  run: AutomationRun;
  open: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const meta = RUN_STATUS_META[run.status];
  const active = run.status === 'running' || run.status === 'scheduled';
  const tokens = run.inputTokens !== null || run.outputTokens !== null
    ? `${formatTokens(run.inputTokens)}↓ ${formatTokens(run.outputTokens)}↑`
    : '';

  return (
    <div className="bg-base hover:bg-surface transition-colors">
      <button type="button" onClick={onToggle} className="w-full text-left px-3 py-2.5">
        <div className="flex items-center gap-2.5 text-[12px]">
          <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${meta.tick} ${run.status === 'running' ? 'animate-pulse' : ''}`} />
          <span className={`font-medium w-[76px] shrink-0 ${meta.tone}`}>{meta.label}</span>
          <span className="text-[9px] uppercase tracking-wide font-semibold px-1.5 py-px rounded bg-surface-lighter text-zinc-500 shrink-0">
            {RUN_TRIGGER_LABEL[run.trigger]}
          </span>
          <span className="flex-1 min-w-0 text-[11px] text-zinc-500 truncate">
            {active && run.startedAt ? `empezó ${relativePast(run.startedAt)}` : shortStamp(run.createdAt)}
          </span>
          <span className="text-[11px] text-zinc-500 tabular-nums w-[56px] text-right shrink-0">{formatDuration(run.durationMs)}</span>
          <span className="text-[11px] text-zinc-500 tabular-nums w-[64px] text-right shrink-0">{formatCost(run.costUsd)}</span>
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3 -mt-0.5">
          <div className="pt-2.5 border-t border-border">
            {(run.error || run.resultText || meta.hint) && (
              <pre className={`text-[11px] leading-[1.6] whitespace-pre-wrap font-sans rounded border px-2.5 py-2 max-h-[180px] overflow-auto ${
                run.error
                  ? 'text-red-300 border-red-400/25 bg-red-500/5'
                  : 'text-zinc-400 border-border bg-surface'
              }`}>
                {run.error || run.resultText || meta.hint}
              </pre>
            )}
            <div className="flex items-center gap-3 mt-2 text-[11px] text-zinc-600">
              {tokens && <span className="tabular-nums">{tokens}</span>}
              {run.stopReason && <span>parada: {run.stopReason}</span>}
              <div className="flex-1" />
              {active && (
                <button type="button" onClick={onCancel} className="text-zinc-400 hover:text-red-400">
                  Cancelar ejecución
                </button>
              )}
              {run.sessionId && onOpenSession && (
                <button
                  type="button"
                  onClick={() => onOpenSession(run.sessionId!)}
                  className="inline-flex items-center gap-1 text-indigo-400 hover:underline"
                >
                  Abrir sesión <ArrowUpRight size={11} />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

interface Draft {
  name: string;
  description: string;
  triggerType: AutomationTriggerType;
  cronExpression: string;
  timezone: string;
  cwd: string;
  prompt: string;
  provider: string;
  model: string;
  permissionMode: AutomationPermissionMode;
  effort: AutomationEffort | '';
  maxRuntimeMs: number | null;
  enabled: boolean;
}

const LOCAL_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
})();

const TIMEZONES: string[] = (() => {
  const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  try {
    if (supported) return supported('timeZone');
  } catch { /* fall through to the short list */ }
  return [...new Set(['UTC', LOCAL_TZ, 'America/Mexico_City', 'America/New_York', 'Europe/Madrid'])];
})();

function draftFrom(source: Automation | undefined, mode: 'create' | 'edit', defaultCwd?: string | null): Draft {
  if (source) {
    return {
      // Duplicating keeps every setting but must not collide by name.
      name: mode === 'create' ? `${source.name} (copia)` : source.name,
      description: source.description ?? '',
      triggerType: source.triggerType,
      // Keep a usable default so flipping a webhook automation over to cron
      // lands on a valid expression rather than an empty box.
      cronExpression: source.cronExpression ?? '0 9 * * *',
      timezone: source.timezone,
      cwd: source.cwd,
      prompt: source.prompt,
      provider: source.provider,
      model: source.model ?? '',
      permissionMode: source.permissionMode,
      effort: source.effort ?? '',
      maxRuntimeMs: source.maxRuntimeMs,
      enabled: source.enabled,
    };
  }
  return {
    name: '',
    description: '',
    triggerType: 'cron',
    cronExpression: '0 9 * * *',
    timezone: LOCAL_TZ,
    cwd: defaultCwd ?? '',
    prompt: '',
    provider: 'claude',
    model: '',
    permissionMode: 'default',
    effort: '',
    maxRuntimeMs: 10 * 60_000,
    enabled: true,
  };
}

function AutomationEditor({ mode, source, client, defaultCwd, onCancel, onSave }: {
  mode: 'create' | 'edit';
  source?: Automation;
  /** Only used to build the webhook URL shown when editing a webhook automation. */
  client: ClaudeClient | null;
  defaultCwd?: string | null;
  onCancel: () => void;
  onSave: (input: AutomationInput, id?: string) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(source, mode, defaultCwd));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(d => ({ ...d, [key]: value }));

  const isWebhook = draft.triggerType === 'webhook';
  const preview = useMemo(() => nextCronRuns(draft.cronExpression, 3), [draft.cronExpression]);
  const cronValid = preview.length > 0;
  const canSave = draft.name.trim() && draft.prompt.trim() && draft.cwd.trim()
    && (isWebhook || draft.cronExpression.trim());

  const submit = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);
    const input: AutomationInput = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      triggerType: draft.triggerType,
      // A webhook automation must clear any cron it used to carry, otherwise the
      // server would keep scheduling the expression left behind by the switch.
      cronExpression: isWebhook ? null : draft.cronExpression.trim(),
      timezone: draft.timezone,
      enabled: draft.enabled,
      prompt: draft.prompt.trim(),
      cwd: draft.cwd.trim(),
      provider: draft.provider,
      model: draft.model.trim() || null,
      permissionMode: draft.permissionMode,
      effort: draft.effort || null,
      maxRuntimeMs: draft.maxRuntimeMs,
    };
    const err = await onSave(input, mode === 'edit' ? source?.id : undefined);
    if (err) setError(err);
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/55 flex items-start justify-center pt-[9vh] px-4" onClick={onCancel}>
      <div
        className="w-full max-w-[540px] max-h-[82vh] bg-surface border border-border-light rounded-xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-[18px] pt-4 pb-3 border-b border-border">
          <h2 className="text-[14px] font-semibold text-zinc-200">
            {mode === 'edit' ? 'Editar automatización' : 'Nueva automatización'}
          </h2>
          <button type="button" onClick={onCancel} className="text-zinc-500 hover:text-zinc-200"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-[18px] py-4">
          <div className="mb-3">
            <label className={LABEL_CLASS}>Nombre</label>
            <input ref={nameRef} className={INPUT_CLASS} value={draft.name}
              placeholder="Resumen diario de PRs" onChange={e => set('name', e.target.value)} />
          </div>
          <div className="mb-3">
            <label className={LABEL_CLASS}>Descripción <span className="normal-case tracking-normal text-zinc-600">— opcional</span></label>
            <input className={INPUT_CLASS} value={draft.description}
              placeholder="Para qué sirve, en una línea" onChange={e => set('description', e.target.value)} />
          </div>

          <GroupDivider title="Cuándo corre" />

          <div className="mb-3">
            <label className={LABEL_CLASS}>Tipo de invocación</label>
            <div className="flex gap-1.5">
              {(['cron', 'webhook'] as AutomationTriggerType[]).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => set('triggerType', t)}
                  className={`flex-1 text-[11px] py-1.5 rounded-md border transition-colors inline-flex items-center justify-center gap-1.5 ${
                    draft.triggerType === t
                      ? 'bg-surface-lighter border-indigo-400/50 text-zinc-100'
                      : 'border-border text-zinc-500 hover:text-zinc-200'
                  }`}
                >
                  {t === 'cron' ? <Clock size={12} /> : <Webhook size={12} />}
                  {TRIGGER_TYPE_META[t].label}
                </button>
              ))}
            </div>
            <div className="text-[11px] text-zinc-600 mt-1.5">{TRIGGER_TYPE_META[draft.triggerType].hint}</div>
          </div>

          {isWebhook ? (
            <div className="mb-3">
              <label className={LABEL_CLASS}>URL a la que debe llamar tu watcher</label>
              {mode === 'edit' && source && client ? (
                <WebhookUrlBox origin={client.localServerUrl} automationId={source.id} />
              ) : (
                // The id is minted by the server, so there is no URL to show yet.
                <div className="bg-base border border-dashed border-border rounded-md px-3 py-2.5 text-[11px] text-zinc-500">
                  La URL se genera al guardar — lleva el id de la automatización y la
                  verás aquí y en su detalle, lista para copiar.
                </div>
              )}
            </div>
          ) : (
          <>
          <div className="mb-3">
            <label className={LABEL_CLASS}>Cadencia</label>
            <div className="flex gap-1.5">
              {CRON_PRESETS.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => set('cronExpression', p.cron)}
                  className={`flex-1 text-[11px] py-1.5 rounded-md border transition-colors ${
                    draft.cronExpression === p.cron
                      ? 'bg-surface-lighter border-indigo-400/50 text-zinc-100'
                      : 'border-border text-zinc-500 hover:text-zinc-200'
                  }`}
                >
                  {p.label}
                </button>
              ))}
              <button
                type="button"
                className={`flex-1 text-[11px] py-1.5 rounded-md border transition-colors ${
                  CRON_PRESETS.every(p => p.cron !== draft.cronExpression)
                    ? 'bg-surface-lighter border-indigo-400/50 text-zinc-100'
                    : 'border-border text-zinc-500 hover:text-zinc-200'
                }`}
              >
                Personalizado
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5 mb-1">
            <div>
              <label className={LABEL_CLASS}>Expresión cron</label>
              <input className={`${INPUT_CLASS} font-mono`} value={draft.cronExpression}
                onChange={e => set('cronExpression', e.target.value)} />
            </div>
            <div>
              <label className={LABEL_CLASS}>Zona horaria</label>
              <select className={INPUT_CLASS} value={draft.timezone} onChange={e => set('timezone', e.target.value)}>
                {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
              </select>
            </div>
          </div>

          {/* The preview is computed in the browser's timezone; once saved, the
              server recomputes `nextRunAt` in the automation's own zone. */}
          <div className={`rounded-md border px-2.5 py-2 mb-3 ${cronValid ? 'bg-indigo-500/6 border-indigo-400/20' : 'bg-amber-500/6 border-amber-400/25'}`}>
            {cronValid ? (
              <>
                <div className="text-[10px] uppercase tracking-wide font-semibold text-indigo-400 mb-1.5">
                  {humanizeCron(draft.cronExpression)}
                </div>
                {preview.map((ts, i) => (
                  <div key={ts} className="flex justify-between text-[11px] text-zinc-400 py-px">
                    <span>{i === 0 ? 'Siguiente' : 'Luego'}</span>
                    <span className="text-zinc-600">{shortStamp(ts)}</span>
                  </div>
                ))}
                {draft.timezone !== LOCAL_TZ && (
                  <div className="text-[10px] text-zinc-600 mt-1.5">
                    Horas en tu zona ({LOCAL_TZ}); el servidor programa en {draft.timezone}.
                  </div>
                )}
              </>
            ) : (
              <div className="text-[11px] text-amber-400 flex items-start gap-1.5">
                <AlertTriangle size={12} className="shrink-0 mt-px" />
                No se pudo interpretar la expresión. El servidor la validará al guardar.
              </div>
            )}
          </div>
          </>
          )}

          <GroupDivider title="Qué hace" />

          <div className="mb-3">
            <label className={LABEL_CLASS}>Carpeta de trabajo</label>
            <input className={`${INPUT_CLASS} font-mono`} value={draft.cwd}
              placeholder="/ruta/al/proyecto" onChange={e => set('cwd', e.target.value)} />
          </div>
          <div className="mb-3">
            <label className={LABEL_CLASS}>Prompt</label>
            <textarea
              className={`${INPUT_CLASS} min-h-[76px] resize-y leading-[1.55]`}
              value={draft.prompt}
              placeholder="Describe exactamente qué debe hacer el agente. Corre sin nadie mirando: sé explícito sobre qué NO debe tocar."
              onChange={e => set('prompt', e.target.value)}
            />
          </div>

          <GroupDivider title="Con qué agente" />

          <div className="grid grid-cols-3 gap-2 mb-3">
            <div>
              <label className={LABEL_CLASS}>Proveedor</label>
              <select className={INPUT_CLASS} value={draft.provider} onChange={e => set('provider', e.target.value)}>
                {PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL_CLASS}>Modelo</label>
              <input className={INPUT_CLASS} value={draft.model}
                placeholder="por defecto" onChange={e => set('model', e.target.value)} />
            </div>
            <div>
              <label className={LABEL_CLASS}>Esfuerzo</label>
              <select className={INPUT_CLASS} value={draft.effort}
                onChange={e => set('effort', e.target.value as AutomationEffort | '')}>
                <option value="">por defecto</option>
                {EFFORTS.map(e => <option key={e} value={e}>{EFFORT_LABEL[e]}</option>)}
              </select>
            </div>
          </div>

          <div className="mb-3">
            <label className={LABEL_CLASS}>Permisos</label>
            <div className="flex gap-1.5">
              {PERMISSION_MODES.map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => set('permissionMode', m)}
                  className={`flex-1 text-[11px] py-1.5 rounded-md border transition-colors ${
                    draft.permissionMode === m
                      ? 'bg-surface-lighter border-indigo-400/50 text-zinc-100'
                      : 'border-border text-zinc-500 hover:text-zinc-200'
                  }`}
                >
                  {PERMISSION_MODE_META[m].label}
                </button>
              ))}
            </div>
            <div className="text-[11px] text-amber-400/90 flex items-start gap-1.5 mt-2">
              <AlertTriangle size={12} className="shrink-0 mt-px" />
              <span>
                {PERMISSION_MODE_META[draft.permissionMode].hint}{' '}
                Nadie va a aprobar nada mientras corre.
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className={LABEL_CLASS}>Tiempo máximo</label>
              <select
                className={INPUT_CLASS}
                value={String(draft.maxRuntimeMs)}
                onChange={e => set('maxRuntimeMs', e.target.value === 'null' ? null : Number(e.target.value))}
              >
                {RUNTIME_PRESETS.map(p => (
                  <option key={p.label} value={String(p.ms)}>{p.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL_CLASS}>Si ya hay una corriendo</label>
              <input className={`${INPUT_CLASS} text-zinc-500`} value="Saltar esta ejecución" disabled />
            </div>
          </div>

          {error && (
            <div className="mt-3 text-[11.5px] text-red-400 flex items-start gap-1.5">
              <AlertTriangle size={12} className="shrink-0 mt-px" />
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-[18px] py-3 border-t border-border">
          <label className="flex items-center gap-2 text-[12px] text-zinc-500 cursor-pointer">
            <Toggle on={draft.enabled} onClick={() => set('enabled', !draft.enabled)} />
            {mode === 'edit' ? 'Activa' : 'Activar al guardar'}
          </label>
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className="text-[12px] px-3 py-1.5 rounded-md text-zinc-400 hover:text-zinc-200">
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSave || saving}
              className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3.5 py-1.5 rounded-md bg-indigo-400 text-[#0f1012] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving && <Loader2 size={12} className="animate-spin" />}
              Guardar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function GroupDivider({ title }: { title: string }) {
  return (
    <>
      <div className="h-px bg-border -mx-[18px] my-4" />
      <div className="text-[10px] uppercase tracking-[0.05em] text-zinc-600 font-bold mb-3">{title}</div>
    </>
  );
}
