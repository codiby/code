import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Network, Plus, Copy, ExternalLink, X, Check, RefreshCw, AlertTriangle } from 'lucide-react';
import type { ClaudeClient, SessionInfo } from '../lib/claude-client';

type Forward = { localPort: number; remotePort: number; label?: string };

interface Props {
  client: ClaudeClient | null;
  /** The currently-active remote session. The popover hides itself when the
   *  active session is local (no remoteId). */
  session: SessionInfo | undefined;
  /** Tunnel status for the active session's remote, broadcast by the server
   *  on the multiplexed /ws ("remote.status" event). Drives the offline
   *  banner. Defaults to "online" when unknown so the chip is usable as
   *  soon as the user opens it. */
  tunnelStatus?: 'connecting' | 'online' | 'reconnecting' | 'offline';
}

export function PortForwardsPopover({ client, session, tunnelStatus = 'online' }: Props) {
  const [open, setOpen] = useState(false);
  const [forwards, setForwards] = useState<Forward[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const sessionId = session?.id ?? null;
  const remoteId = session?.remoteId ?? null;
  const offline = tunnelStatus === 'offline' || tunnelStatus === 'reconnecting';

  const refresh = useCallback(async () => {
    if (!client || !sessionId) return;
    setLoading(true);
    try {
      const list = await client.listPortForwards(sessionId);
      setForwards(list);
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Failed to load forwards');
    } finally {
      setLoading(false);
    }
  }, [client, sessionId]);

  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open, refresh]);

  // close on outside-click / Esc
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (btnRef.current?.contains(t)) return;
      setOpen(false);
      setShowForm(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); setShowForm(false); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Hide chip entirely for local sessions.
  if (!remoteId) return null;

  return (
    <div className="relative" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <button
        ref={btnRef}
        onClick={() => setOpen(v => !v)}
        title={`Port forwards${forwards.length > 0 ? ` (${forwards.length})` : ''}`}
        className={[
          'h-6 px-2 flex items-center gap-1.5 rounded-md border transition-colors',
          open
            ? 'bg-violet-500/10 border-violet-500/40 text-zinc-100'
            : 'bg-surface hover:bg-surface-light border-border hover:border-border-light text-zinc-300 hover:text-zinc-100',
        ].join(' ')}
      >
        <Network className="w-3.5 h-3.5 text-violet-300" />
        <span className="text-[11px] font-medium">Forwards</span>
        {forwards.length > 0 ? (
          <span className="font-mono text-[10px] font-semibold text-violet-300 bg-violet-500/15 rounded px-1 leading-[1.3]">
            {forwards.length}
          </span>
        ) : null}
      </button>

      {open && (
        <div
          ref={popRef}
          className="absolute right-0 top-7 z-[10000] w-[360px] bg-surface border border-border-light rounded-lg shadow-2xl overflow-hidden"
        >
          {/* arrow */}
          <span className="absolute -top-1.5 right-6 w-2.5 h-2.5 bg-surface border-l border-t border-border-light rotate-45" />

          {/* head */}
          <div
            className={[
              'px-3.5 py-2.5 flex items-center gap-2.5 border-b border-border',
              offline
                ? 'bg-amber-500/[0.04]'
                : 'bg-gradient-to-b from-violet-500/[0.04] to-transparent',
            ].join(' ')}
          >
            <div
              className={[
                'w-6.5 h-6.5 flex items-center justify-center rounded-md',
                offline ? 'bg-amber-500/15 text-amber-300' : 'bg-violet-500/12 text-violet-300',
              ].join(' ')}
              style={{ width: 26, height: 26 }}
            >
              <Network className="w-3.5 h-3.5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold text-zinc-200 leading-tight">Port forwards</div>
              <div className="text-[10.5px] font-mono text-zinc-500 flex items-center gap-1.5 mt-0.5">
                <TunnelDot status={tunnelStatus} />
                <span className="truncate">
                  {session?.remoteName ?? 'remote'} · {tunnelStatusLabel(tunnelStatus)}
                </span>
              </div>
            </div>
            <button
              onClick={refresh}
              disabled={loading}
              className="w-6 h-6 flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-surface-light transition-colors disabled:opacity-40"
              title="Refresh"
            >
              <RefreshCw className={['w-3.5 h-3.5', loading ? 'animate-spin' : ''].join(' ')} />
            </button>
          </div>

          {offline && (
            <div className="px-3.5 py-2 flex items-center gap-2 text-[11px] text-amber-300 bg-amber-500/[0.06] border-b border-amber-500/15">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>Forwards inactive until the tunnel reconnects.</span>
            </div>
          )}

          {error && (
            <div className="px-3.5 py-2 text-[11px] text-red-300 bg-red-500/[0.06] border-b border-red-500/20">
              {error}
            </div>
          )}

          {/* list / empty */}
          {forwards.length === 0 ? (
            <EmptyState onAdd={() => setShowForm(true)} disabled={offline} />
          ) : (
            <ul className="py-1">
              {forwards.map(f => (
                <ForwardRow
                  key={`${f.localPort}:${f.remotePort}`}
                  forward={f}
                  disabled={offline}
                  onRemove={async () => {
                    setForwards(prev => prev.filter(x => !(x.localPort === f.localPort && x.remotePort === f.remotePort)));
                    try {
                      if (client && sessionId) await client.removePortForward(sessionId, f.localPort, f.remotePort);
                    } catch (e: any) {
                      setError(e?.message || 'Failed to remove forward');
                      refresh();
                    }
                  }}
                />
              ))}
            </ul>
          )}

          {/* footer add button (hidden when form is open) */}
          {forwards.length > 0 && !showForm && (
            <div className="border-t border-border p-2 bg-base/40">
              <button
                onClick={() => setShowForm(true)}
                disabled={offline}
                className="w-full h-[30px] flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border-light text-zinc-300 hover:bg-violet-500/[0.08] hover:border-violet-500/40 hover:text-violet-200 transition-colors text-[12px] font-medium disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:border-border-light disabled:hover:text-zinc-300"
              >
                <Plus className="w-3.5 h-3.5" />
                Add forward
              </button>
            </div>
          )}

          {/* form */}
          {showForm && (
            <AddForwardForm
              onCancel={() => setShowForm(false)}
              onSubmit={async ({ remotePort, localPort, label }) => {
                if (!client || !sessionId) return;
                try {
                  const created = await client.addPortForward(sessionId, { remotePort, localPort, label });
                  setForwards(prev => [...prev, { localPort: created.localPort, remotePort: created.remotePort, label }]);
                  setShowForm(false);
                  setError(null);
                } catch (e: any) {
                  setError(e?.message || 'Failed to add forward');
                }
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ForwardRow({ forward, disabled, onRemove }: { forward: Forward; disabled: boolean; onRemove: () => void }) {
  const url = `http://localhost:${forward.localPort}`;
  return (
    <li className="group px-3.5 py-2 grid grid-cols-[1fr_auto] gap-2.5 items-center hover:bg-surface-light not-first:border-t not-first:border-border">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-zinc-200 truncate">
            {forward.label?.trim() || `Forward :${forward.remotePort}`}
          </span>
          <StatusPill disabled={disabled} />
        </div>
        <div className="mt-0.5 font-mono text-[10.5px] text-zinc-500 flex items-center gap-1.5">
          <span className="text-violet-300/90">localhost:{forward.localPort}</span>
          <ArrowRight />
          <span className="text-zinc-300/90">remote:{forward.remotePort}</span>
        </div>
      </div>
      <div className="flex gap-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
        <IconBtn
          title={`Copy ${url}`}
          onClick={() => { void navigator.clipboard?.writeText(url); }}
          disabled={disabled}
        >
          <Copy className="w-3.5 h-3.5" />
        </IconBtn>
        <IconBtn
          title="Open in browser"
          onClick={() => { window.open(url, '_blank', 'noopener'); }}
          disabled={disabled}
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </IconBtn>
        <IconBtn title="Remove" onClick={onRemove} danger>
          <X className="w-3.5 h-3.5" />
        </IconBtn>
      </div>
    </li>
  );
}

function IconBtn({
  children, onClick, title, disabled, danger,
}: { children: React.ReactNode; onClick: () => void; title: string; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={[
        'w-6 h-6 flex items-center justify-center rounded-md text-zinc-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed',
        danger ? 'hover:text-red-300 hover:bg-surface-lighter' : 'hover:text-zinc-100 hover:bg-surface-lighter',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function ArrowRight() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-600">
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

function StatusPill({ disabled }: { disabled: boolean }) {
  if (disabled) {
    return (
      <span className="inline-flex items-center gap-1 text-[9.5px] font-semibold uppercase tracking-wider text-zinc-500 bg-surface-lighter border border-border-light px-1.5 py-px rounded-full">
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
        Paused
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[9.5px] font-semibold uppercase tracking-wider text-emerald-400 bg-emerald-400/10 border border-emerald-400/25 px-1.5 py-px rounded-full">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
      Live
    </span>
  );
}

function TunnelDot({ status }: { status: Props['tunnelStatus'] }) {
  const cls =
    status === 'online'        ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]' :
    status === 'connecting'    ? 'bg-amber-400'    :
    status === 'reconnecting'  ? 'bg-amber-400'    :
    /* offline */                'bg-zinc-500';
  return <span className={['w-1.5 h-1.5 rounded-full', cls].join(' ')} />;
}

function tunnelStatusLabel(status: Props['tunnelStatus']) {
  switch (status) {
    case 'connecting':   return 'connecting…';
    case 'reconnecting': return 'reconnecting…';
    case 'offline':      return 'tunnel offline';
    case 'online':
    default:             return 'tunnel up';
  }
}

// ---------------------------------------------------------------------------

function EmptyState({ onAdd, disabled }: { onAdd: () => void; disabled: boolean }) {
  return (
    <div className="px-4 py-6 text-center">
      <div className="inline-flex w-9 h-9 items-center justify-center rounded-full bg-surface-light border border-dashed border-border-light text-zinc-500 mb-2.5">
        <Plus className="w-4 h-4" />
      </div>
      <div className="text-[12.5px] font-medium text-zinc-200">No forwards yet</div>
      <div className="text-[11.5px] text-zinc-500 mt-0.5 mb-3">
        Expose a remote port to your machine over the SSH tunnel.
      </div>
      <button
        onClick={onAdd}
        disabled={disabled}
        className="h-[28px] px-3 inline-flex items-center gap-1.5 rounded-md bg-violet-500/15 hover:bg-violet-500/25 text-violet-200 text-[11.5px] font-medium border border-violet-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Plus className="w-3.5 h-3.5" />
        Add forward
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AddForwardForm({
  onSubmit, onCancel,
}: {
  onSubmit: (v: { remotePort: number; localPort: number | null; label?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [remotePort, setRemotePort] = useState('');
  const [localPort, setLocalPort] = useState('');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const remoteRef = useRef<HTMLInputElement>(null);

  useEffect(() => { remoteRef.current?.focus(); }, []);

  const remotePortNum = useMemo(() => {
    const n = Number(remotePort);
    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
  }, [remotePort]);
  const localPortNum = useMemo(() => {
    if (!localPort.trim()) return null;
    const n = Number(localPort);
    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : -1;
  }, [localPort]);

  const valid = remotePortNum !== null && localPortNum !== -1;
  const localPreview = localPort.trim() ? localPort.trim() : '<auto>';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || !remotePortNum) return;
    setSubmitting(true);
    try {
      await onSubmit({
        remotePort: remotePortNum,
        localPort: localPortNum === -1 ? null : localPortNum,
        label: label.trim() || undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="border-t border-border bg-gradient-to-b from-base/60 to-base px-3.5 py-3"
    >
      <div className="text-[10px] uppercase tracking-[0.12em] font-semibold text-zinc-500 mb-2.5 flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />
        New forward
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Remote port" required>
          <Input
            ref={remoteRef}
            mono
            value={remotePort}
            onChange={e => setRemotePort(e.target.value)}
            placeholder="5432"
            inputMode="numeric"
          />
        </Field>
        <Field label="Local port" hint="auto">
          <Input
            mono
            value={localPort}
            onChange={e => setLocalPort(e.target.value)}
            placeholder="auto"
            inputMode="numeric"
          />
        </Field>
      </div>

      <div className="mt-2.5">
        <Field label="Label" hint="optional">
          <Input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="e.g. Redis"
          />
        </Field>
      </div>

      {remotePortNum && (
        <div className="mt-2.5 px-2.5 py-1.5 font-mono text-[10.5px] text-zinc-500 bg-base border border-border rounded-md flex items-center gap-1.5">
          <span className="w-1 h-1 rounded-full bg-violet-400 shrink-0" />
          <span className="truncate">
            Will open at <span className="text-zinc-300">http://localhost:{localPreview}</span> → remote:{remotePortNum}
          </span>
        </div>
      )}

      <div className="flex items-center gap-1.5 mt-3">
        <button
          type="submit"
          disabled={!valid || submitting}
          className="h-[30px] px-3.5 inline-flex items-center gap-1.5 rounded-md text-[12px] font-semibold text-violet-50 bg-gradient-to-b from-violet-400 to-violet-600 border border-violet-400/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_6px_14px_-8px_rgba(167,139,250,0.7)] hover:brightness-110 transition disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100"
        >
          <Check className="w-3.5 h-3.5" />
          {submitting ? 'Adding…' : 'Add'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-[30px] px-3 text-[12px] text-zinc-400 hover:text-zinc-100 hover:bg-surface-light rounded-md transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({
  label, hint, required, children,
}: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[11px] font-medium text-zinc-300">
          {label}
          {required && <span className="text-violet-400 ml-0.5">*</span>}
        </span>
        {hint && <span className="text-[10px] text-zinc-500">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

const Input = (() => {
  // Stand-alone styled <input> that supports a `mono` flag for the
  // port-number fields. Defined as a forwardRef so the form can focus the
  // first field on mount.
  return ((props: React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; ref?: React.Ref<HTMLInputElement> }) => {
    const { mono, ref, className, ...rest } = props;
    return (
      <input
        ref={ref}
        {...rest}
        className={[
          'w-full h-[30px] px-2.5 rounded-md bg-base border border-border text-[12px] text-zinc-100',
          'placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/50 focus:bg-surface transition-colors',
          mono ? 'font-mono' : '',
          className || '',
        ].join(' ')}
      />
    );
  });
})();
