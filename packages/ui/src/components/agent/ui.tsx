/**
 * Shared building blocks for the Agent view's sections, so every area looks
 * the same (styles follow AutomationsView). All visible copy is English.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { AgentApi } from '../../lib/agent/api';
import { createResponseOrder } from '../../lib/agent/polled';

/** Props every section component receives. */
export interface AgentSectionProps {
  api: AgentApi;
  /** Bump to make sections re-read after a host/config change. */
  refreshKey: number;
  /** Open a session tab (e.g. the agent's own chat). */
  onOpenSession?: (sessionId: string) => void;
}

/**
 * Field look without a width. Use it with an explicit `w-[…]`: appending a
 * width to INPUT_CLASS doesn't work, since which of two width utilities wins
 * depends on stylesheet order, not on class order (`w-full` won).
 *
 * 30px tall (5 + 18 + 5 + borders), the same as Button, so an input and the
 * button next to it line up.
 */
export const INPUT_BASE_CLASS =
  'bg-base border border-border rounded-md px-2.5 py-[5px] leading-[18px] text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-400/50 disabled:opacity-50';
export const INPUT_CLASS = `w-full ${INPUT_BASE_CLASS}`;
export const LABEL_CLASS = 'text-[10px] uppercase tracking-wide text-zinc-600 font-semibold mb-1.5 block';

export function Section({ title, action, children, hint }: { title: string; action?: ReactNode; children: ReactNode; hint?: string }) {
  return (
    <div className="mb-[18px]">
      <div className="flex items-center justify-between mb-2 gap-3">
        <div className="min-w-0">
          <span className="text-[10px] uppercase tracking-wide text-zinc-600 font-semibold">{title}</span>
          {hint && <p className="text-[11px] text-zinc-500 mt-0.5">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bg-surface border border-border rounded-lg px-3.5 py-3 ${className}`}>{children}</div>;
}

export function Stat({ value, label, tone }: { value: string | number; label: string; tone?: string }) {
  return (
    <div className="flex-1 bg-surface border border-border rounded-lg px-3.5 py-3 min-w-0">
      <div className={`text-[20px] font-semibold leading-none truncate ${tone || 'text-zinc-200'}`}>{value}</div>
      <div className="text-[11px] text-zinc-500 mt-1.5">{label}</div>
    </div>
  );
}

export function Toggle({ on, onClick, disabled, label }: { on: boolean; onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`relative w-[34px] h-[19px] rounded-full shrink-0 border transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300/70 focus-visible:ring-offset-1 focus-visible:ring-offset-surface ${
        on ? 'bg-indigo-400/40 border-transparent' : 'bg-surface-lighter border-border-light'
      }`}
    >
      <span className={`absolute top-[1px] w-[15px] h-[15px] rounded-full transition-all ${on ? 'left-[16px] bg-indigo-400' : 'left-[1px] bg-zinc-300'}`} />
    </button>
  );
}

export function Button({ children, onClick, tone = 'default', disabled, type = 'button', title }: {
  children: ReactNode;
  onClick?: () => void;
  tone?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
}) {
  // enabled: — a disabled button shouldn't light up on hover as if it could be pressed.
  const tones = {
    default: 'border border-border text-zinc-300 enabled:hover:bg-surface-light',
    primary: 'bg-indigo-400 text-[#0f1012] enabled:hover:brightness-110',
    danger: 'border border-red-500/40 text-red-300 enabled:hover:bg-red-500/10',
  } as const;
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-1.5 h-[30px] px-3 rounded-md text-[12px] font-medium whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-default transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300/70 focus-visible:ring-offset-1 focus-visible:ring-offset-surface ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

export function Pill({ children, tone = 'zinc' }: { children: ReactNode; tone?: 'zinc' | 'green' | 'amber' | 'red' | 'indigo' }) {
  const tones = {
    zinc: 'text-zinc-400 border-border bg-surface-light',
    green: 'text-green-300 border-green-500/30 bg-green-500/10',
    amber: 'text-amber-300 border-amber-500/30 bg-amber-500/10',
    red: 'text-red-300 border-red-500/30 bg-red-500/10',
    indigo: 'text-indigo-300 border-indigo-400/30 bg-indigo-400/10',
  } as const;
  return <span className={`text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full border whitespace-nowrap ${tones[tone]}`}>{children}</span>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block mb-3">
      <span className={LABEL_CLASS}>{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-zinc-500 mt-1">{hint}</span>}
    </label>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="px-3 py-2 rounded-md border border-amber-500/30 bg-amber-500/8 text-[11.5px] text-amber-300 flex items-center gap-2">
      <AlertTriangle size={13} className="shrink-0" />
      <span className="flex-1 min-w-0 break-words">{message}</span>
      {onRetry && <button type="button" onClick={onRetry} className="underline underline-offset-2">Retry</button>}
    </div>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <div className="text-[12px] text-zinc-500 border border-dashed border-border rounded-lg px-4 py-6 text-center">{children}</div>;
}

export function Spinner() {
  return (
    <div className="flex items-center justify-center py-10 text-zinc-600">
      <Loader2 size={18} className="animate-spin" />
    </div>
  );
}

/** "3 min ago" / "in 2 h". */
export function relativeTime(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  const diff = ts - now;
  const abs = Math.abs(diff);
  const units: [number, string][] = [[86_400_000, 'd'], [3_600_000, 'h'], [60_000, 'min']];
  for (const [ms, unit] of units) {
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      return diff < 0 ? `${n} ${unit} ago` : `in ${n} ${unit}`;
    }
  }
  return diff < 0 ? 'just now' : 'in a moment';
}

/**
 * Load-and-poll helper. `load` runs on mount, whenever `deps` change, and
 * every `intervalMs` (0 = no polling). Errors are surfaced, not thrown.
 */
export function usePolled<T>(load: () => Promise<T>, deps: unknown[], intervalMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  // Loads overlap (a slow poll, a search typed on): see lib/agent/polled.ts.
  const order = useRef(createResponseOrder()).current;

  const reload = useCallback(async () => {
    const ticket = order.begin();
    try {
      const next = await loadRef.current();
      if (!ticket.accept()) return;
      setData(next);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!ticket.accept()) return;
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }, [order]);

  useEffect(() => {
    setLoading(true);
    void reload();
    const timer = intervalMs ? setInterval(() => void reload(), intervalMs) : null;
    return () => {
      if (timer) clearInterval(timer);
      order.invalidate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload, setData };
}
