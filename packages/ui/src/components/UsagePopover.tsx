import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Gauge, RefreshCw, X, CreditCard, AlertTriangle } from 'lucide-react';
import type { ProviderUsage, UsageSeverity, UsageSnapshot, UsageWindow } from '../lib/claude-client';
import { useAppStore } from '../lib/store';

/** How often the snapshot refreshes on its own while the app is open. */
const POLL_MS = 5 * 60_000;

const SEVERITY_BAR: Record<UsageSeverity, string> = {
  normal: 'bg-gradient-to-r from-indigo-500 to-violet-400',
  warning: 'bg-gradient-to-r from-amber-500 to-amber-300',
  critical: 'bg-gradient-to-r from-red-600 to-red-400',
};

const SEVERITY_TEXT: Record<UsageSeverity, string> = {
  normal: 'text-zinc-300',
  warning: 'text-amber-400',
  critical: 'text-red-400',
};

const PROVIDER_LABEL: Record<ProviderUsage['provider'], string> = { claude: 'Claude', codex: 'Codex' };

/**
 * Plan limits for every signed-in provider, in the sidebar footer.
 *
 * The button carries the worst active limit as a two-pixel bar so the number
 * is readable without opening anything; the panel breaks it down per window.
 * Providers that report `logged_out` are dropped entirely rather than shown
 * as an error — someone who never ran `codex login` should not see a red row
 * about it every time they glance at the sidebar.
 */
export function UsagePopover() {
  // Straight from the store rather than a prop: the popover is self-contained
  // and the sidebar has no other reason to know about the client.
  const client = useAppStore(s => s.client);
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  /** Re-renders the "hace Ns" footer and the countdowns without refetching. */
  const [, setTick] = useState(0);

  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (refresh: boolean) => {
    if (!client) return;
    setLoading(true);
    try {
      setSnapshot(await client.getUsage(refresh));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client]);

  // The button shows a live number, so the first fetch cannot wait for the
  // panel to open.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const run = () => { if (!cancelled) void load(false); };
    run();
    const timer = setInterval(run, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [client, load]);

  // Opening is an explicit "tell me now" — bypass the bridge's TTL cache.
  useEffect(() => { if (open) void load(true); }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, [open]);

  // Measured before paint so the panel never flashes in the corner, and
  // re-measured on resize because it is pinned to the sidebar's bottom edge.
  useLayoutEffect(() => {
    if (!open) { setAnchor(null); return; }
    const measure = () => setAnchor(btnRef.current?.getBoundingClientRect() ?? null);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const providers = useMemo(
    () => (snapshot?.providers ?? []).filter(p => p.status !== 'logged_out'),
    [snapshot],
  );

  /** The one number worth putting on the button: highest percentage in play. */
  const headline = useMemo(() => {
    const windows = providers.flatMap(p => p.windows);
    if (windows.length === 0) return null;
    return windows.reduce((worst, w) => (w.percent > worst.percent ? w : worst));
  }, [providers]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        title="Uso del plan"
        className={`flex items-center gap-2.5 h-8 px-3 rounded-md text-[12px] font-medium transition-colors group ${
          open ? 'bg-surface-light text-zinc-100' : 'text-zinc-400 hover:text-zinc-200 hover:bg-surface-light'
        }`}
      >
        <Gauge size={15} className={open ? 'text-violet-400' : 'text-zinc-500 group-hover:text-violet-300 transition-colors'} />
        <span className="flex-1 text-left">Usage</span>
        {headline && (
          <span className="flex items-center gap-1.5 shrink-0">
            <span className="w-[26px] h-[3px] rounded-full bg-zinc-700 overflow-hidden">
              <span className={`block h-full rounded-full ${SEVERITY_BAR[headline.severity]}`} style={{ width: `${headline.percent}%` }} />
            </span>
            <span className={`font-mono text-[10px] tabular-nums w-[26px] text-right ${headline.severity === 'normal' ? 'text-zinc-500' : SEVERITY_TEXT[headline.severity]}`}>
              {headline.percent}%
            </span>
          </span>
        )}
      </button>

      {/* Portalled for the same reason as PortForwardsPopover: out here the
       *  panel has no clipping or drag-region ancestor to fight with. */}
      {open && anchor && createPortal(
        <div
          ref={popRef}
          style={{
            position: 'fixed',
            left: anchor.right + 10,
            // Bottom-aligned to the button so the panel grows upward out of
            // the sidebar footer rather than off the bottom of the window.
            bottom: Math.max(8, window.innerHeight - anchor.bottom - 4),
            zIndex: 10000,
            WebkitAppRegion: 'no-drag',
          } as React.CSSProperties}
          className="w-[344px] bg-surface border border-border-light rounded-xl shadow-2xl overflow-hidden"
        >
          <div className="px-3.5 py-2.5 flex items-start justify-between border-b border-border">
            <div>
              <div className="text-[12px] font-semibold text-zinc-100">Usage</div>
              <div className="text-[10px] text-zinc-600 mt-px">Límites de tu plan, por proveedor</div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Cerrar"
              className="w-[22px] h-[22px] rounded-[5px] grid place-items-center text-zinc-600 hover:bg-surface-light hover:text-zinc-300 transition-colors"
            >
              <X size={12} />
            </button>
          </div>

          {/* Header and footer are fixed, so the scroller absorbs whatever
           *  vertical room is left above the button in a short window. */}
          <div className="overflow-y-auto" style={{ maxHeight: Math.max(160, Math.min(452, anchor.bottom - 96)) }}>
            {error && providers.length === 0 ? (
              <div className="flex items-start gap-2 px-3.5 py-3 text-[11px] text-amber-400/90">
                <AlertTriangle size={13} className="mt-px shrink-0" />
                <span>No se pudo leer el uso: {error}</span>
              </div>
            ) : providers.length === 0 ? (
              <div className="px-3.5 py-4 text-[11px] text-zinc-600">
                {loading ? 'Cargando…' : 'Ningún proveedor con sesión iniciada.'}
              </div>
            ) : (
              providers.map(p => <ProviderSection key={p.provider} usage={p} />)
            )}
          </div>

          <div className="px-3.5 py-2 flex items-center justify-between border-t border-border">
            <span className="text-[10px] text-zinc-600">
              {snapshot ? `Actualizado ${formatAgo(snapshot.fetchedAt)}` : '—'}
            </span>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={loading}
              className="flex items-center gap-1.5 px-1.5 py-[3px] rounded-[5px] text-[10px] text-zinc-500 hover:bg-surface-light hover:text-zinc-300 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={11} className={loading ? 'animate-spin' : undefined} />
              Actualizar
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function ProviderSection({ usage }: { usage: ProviderUsage }) {
  return (
    <section className="px-3.5 py-3 border-b border-border last:border-b-0">
      <div className="flex items-center gap-2 mb-2.5">
        <span
          className={`w-[18px] h-[18px] rounded-[5px] grid place-items-center text-[10px] font-bold shrink-0 ${
            usage.provider === 'claude' ? 'bg-[#d97757] text-[#1b0f09]' : 'bg-zinc-200 text-zinc-900'
          }`}
        >
          {usage.provider === 'claude' ? '✳' : '◎'}
        </span>
        <span className="text-[12px] font-semibold text-zinc-100">{PROVIDER_LABEL[usage.provider]}</span>
        {usage.account?.plan && (
          <span className="text-[10px] text-zinc-500 border border-border-light rounded-full px-1.5 leading-[1.5]">
            {usage.account.plan}
          </span>
        )}
        {usage.account?.email && (
          <span className="ml-auto text-[10px] text-zinc-600 truncate max-w-[132px]">{usage.account.email}</span>
        )}
      </div>

      {usage.status === 'error' ? (
        <div className="flex items-start gap-2 text-[11px] text-amber-400/90">
          <AlertTriangle size={13} className="mt-px shrink-0" />
          <span>{usage.error || 'No se pudo leer el uso'}</span>
        </div>
      ) : usage.windows.length === 0 ? (
        <div className="text-[11px] text-zinc-600">Sin límites reportados.</div>
      ) : (
        usage.windows.map(w => <Meter key={w.id} window={w} />)
      )}

      {usage.breakdown && usage.breakdown.length > 0 && (
        <div className="mt-2.5 pt-2 border-t border-dashed border-border">
          <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1.5">Semana por superficie</div>
          {usage.breakdown.map(row => (
            <div key={row.key} className="flex items-center gap-[7px] mb-1 text-[11px] text-zinc-400">
              <span className={`w-1.5 h-1.5 rounded-sm shrink-0 ${row.percent > 0 ? 'bg-violet-400' : 'bg-zinc-700'}`} />
              {row.label}
              <span className="ml-auto font-mono text-[10px] text-zinc-500 tabular-nums">{row.percent}%</span>
            </div>
          ))}
        </div>
      )}

      {usage.credits && (
        <div className="flex items-center gap-[7px] mt-2.5 px-2.5 py-[7px] rounded-md bg-surface-light text-[11px] text-zinc-500">
          <CreditCard size={12} className="shrink-0" />
          <span className={usage.credits.enabled ? 'text-zinc-400' : undefined}>{usage.credits.label}</span>
          {formatCredits(usage.credits) && (
            <span className="ml-auto font-mono text-[11px] font-semibold text-zinc-300 tabular-nums">
              {formatCredits(usage.credits)}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function Meter({ window: w }: { window: UsageWindow }) {
  return (
    <div className="mb-2.5 last:mb-0">
      <div className="flex items-baseline gap-1.5 mb-1">
        <span className="text-[11px] font-medium text-zinc-400">{windowLabel(w)}</span>
        {windowDetail(w) && <span className="text-[10px] text-zinc-600">· {windowDetail(w)}</span>}
        <span className={`ml-auto font-mono text-[11px] font-semibold tabular-nums ${SEVERITY_TEXT[w.severity]}`}>
          {w.percent}%
        </span>
      </div>
      <div className="h-[5px] rounded-full bg-zinc-700 overflow-hidden">
        <div className={`h-full rounded-full transition-[width] duration-500 ${SEVERITY_BAR[w.severity]}`} style={{ width: `${w.percent}%` }} />
      </div>
      <div className="flex justify-between mt-1 text-[10px] text-zinc-600">
        <span className={w.percent >= 100 ? 'text-red-400' : undefined}>
          {w.percent >= 100 ? 'límite alcanzado' : formatResetIn(w.resetsAt)}
          {w.isActive ? ' · activo ahora' : ''}
        </span>
        <span>{formatResetAt(w.resetsAt)}</span>
      </div>
    </div>
  );
}

function windowLabel(w: UsageWindow): string {
  if (w.kind === 'session') return 'Sesión';
  if (w.kind === 'weekly') return 'Semanal';
  return w.label || 'Límite';
}

/** Scope wins over window length — "· Fable" says more than "· 7 d". */
function windowDetail(w: UsageWindow): string | null {
  if (w.scope) return w.scope;
  if (w.windowMinutes) return formatWindowLength(w.windowMinutes);
  if (w.kind === 'weekly') return 'todos los modelos';
  return null;
}

function formatWindowLength(minutes: number): string {
  if (minutes % 10080 === 0) return `${minutes / 10080} sem`;
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

function formatResetIn(iso?: string | null): string {
  if (!iso) return 'sin reinicio';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'reiniciando…';
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `se reinicia en ${days} d ${hours} h`;
  if (hours > 0) return `se reinicia en ${hours} h ${minutes % 60} m`;
  return `se reinicia en ${minutes} m`;
}

function formatResetAt(iso?: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(undefined, sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function formatAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `hace ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  return `hace ${Math.round(minutes / 60)} h`;
}

function formatCredits(credits: NonNullable<ProviderUsage['credits']>): string | null {
  const { usedMinor, limitMinor, currency = 'USD' } = credits;
  const money = (minor: number) => (minor / 100).toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: 2 });
  if (usedMinor != null && limitMinor != null) return `${money(usedMinor)} / ${money(limitMinor)}`;
  if (limitMinor != null) return money(limitMinor);
  if (usedMinor != null) return money(usedMinor);
  return null;
}
