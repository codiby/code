import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Network, Plus, Copy, ExternalLink, X, Check, RefreshCw, AlertTriangle, Radio } from 'lucide-react';
import type { ClaudeClient, PublishedPort, SessionInfo } from '../lib/claude-client';

type Forward = { localPort: number; remotePort: number; label?: string };

interface Props {
  client: ClaudeClient | null;
  /** The currently-active session. */
  session: SessionInfo | undefined;
  /** Tunnel status for the active session's remote, broadcast by the server
   *  on the multiplexed /ws ("remote.status" event). Drives the offline
   *  banner. Defaults to "online" when unknown so the chip is usable as
   *  soon as the user opens it. */
  tunnelStatus?: 'connecting' | 'online' | 'reconnecting' | 'offline';
  /** Ports this session pushed out to the network, from the store. Mostly
   *  opened by the agent through `ui_forward_port`. */
  publishedPorts?: PublishedPort[];
  /** True when this browser reached the bridge from another machine — the
   *  case the published-ports section exists for. */
  viewerIsRemote?: boolean;
}

/**
 * The two directions a session's ports can travel, in one chip.
 *
 *  - **Published** — a port on the bridge's machine pushed out to every
 *    interface so *this* browser can reach it. Only meaningful when the
 *    browser is elsewhere; that is the whole point.
 *  - **SSH forwards** — a port on the session's remote host tunnelled back to
 *    this machine. Only meaningful for a session that lives on a remote.
 *
 * A session can be in both states at once (a remote session viewed from a
 * third machine), so neither section is conditional on the other.
 */
export function PortForwardsPopover({
  client,
  session,
  tunnelStatus = 'online',
  publishedPorts = [],
  viewerIsRemote = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [forwards, setForwards] = useState<Forward[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showPublishForm, setShowPublishForm] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const sessionId = session?.id ?? null;
  const remoteId = session?.remoteId ?? null;
  const offline = tunnelStatus === 'offline' || tunnelStatus === 'reconnecting';

  // Published ports live on the bridge's machine, so the URL that works for
  // whoever is clicking is the host *this page* came from — not whatever the
  // server guessed for the agent.
  const publishedUrl = useCallback(
    (p: PublishedPort) => `${window.location.protocol}//${window.location.hostname}:${p.publicPort}`,
    [],
  );

  const refresh = useCallback(async () => {
    if (!client || !sessionId) return;
    setLoading(true);
    try {
      if (remoteId) setForwards(await client.listPortForwards(sessionId));
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Failed to load forwards');
    } finally {
      setLoading(false);
    }
  }, [client, sessionId, remoteId]);

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

  // Nothing to say on a local session viewed from this machine — unless
  // something is already published, in which case hiding the only way to close
  // it would strand the port.
  if (!remoteId && !viewerIsRemote && publishedPorts.length === 0) return null;

  const total = forwards.length + publishedPorts.length;

  return (
    <div className="relative" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <button
        ref={btnRef}
        onClick={() => setOpen(v => !v)}
        title={`Port forwards${total > 0 ? ` (${total})` : ''}`}
        className={[
          'h-6 px-2 flex items-center gap-1.5 rounded-md border transition-colors',
          open
            ? 'bg-violet-500/10 border-violet-500/40 text-zinc-100'
            : 'bg-surface hover:bg-surface-light border-border hover:border-border-light text-zinc-300 hover:text-zinc-100',
        ].join(' ')}
      >
        <Network className="w-3.5 h-3.5 text-violet-300" />
        <span className="text-[11px] font-medium">Forwards</span>
        {total > 0 ? (
          <span className="font-mono text-[10px] font-semibold text-violet-300 bg-violet-500/15 rounded px-1 leading-[1.3]">
            {total}
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
                {remoteId ? (
                  <>
                    <TunnelDot status={tunnelStatus} />
                    <span className="truncate">
                      {session?.remoteName ?? 'remote'} · {tunnelStatusLabel(tunnelStatus)}
                    </span>
                  </>
                ) : (
                  <span className="truncate">viewing from {window.location.hostname}</span>
                )}
              </div>
            </div>
            {remoteId && (
              <button
                onClick={refresh}
                disabled={loading}
                className="w-6 h-6 flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-surface-light transition-colors disabled:opacity-40"
                title="Refresh"
              >
                <RefreshCw className={['w-3.5 h-3.5', loading ? 'animate-spin' : ''].join(' ')} />
              </button>
            )}
          </div>

          {offline && remoteId && (
            <div className="px-3.5 py-2 flex items-center gap-2 text-[11px] text-amber-300 bg-amber-500/[0.06] border-b border-amber-500/15">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>Forwards inactive until the tunnel reconnects.</span>
            </div>
          )}

          {/* ---- Published: this machine's ports, pushed out to your browser ---- */}
          {(viewerIsRemote || publishedPorts.length > 0) && (
            <>
              <SectionHead
                icon={<Radio className="w-3 h-3" />}
                title="Published to you"
                hint={`${publishedPorts.length || 'none'}`}
              />

              {publishError && (
                <div className="px-3.5 py-2 text-[11px] text-red-300 bg-red-500/[0.06] border-b border-red-500/20">
                  {publishError}
                </div>
              )}

              {publishedPorts.length === 0 ? (
                <PublishEmptyState onAdd={() => setShowPublishForm(true)} />
              ) : (
                <ul className="py-1">
                  {publishedPorts.map(p => (
                    <PublishedRow
                      key={p.id}
                      port={p}
                      url={publishedUrl(p)}
                      onRemove={async () => {
                        if (!client || !sessionId) return;
                        try {
                          // No optimistic removal: the server broadcasts the
                          // new list, and that broadcast is the source of
                          // truth for every open tab, not just this one.
                          await client.unpublishPort(sessionId, p.publicPort);
                          setPublishError(null);
                        } catch (e: any) {
                          setPublishError(e?.message || 'Failed to close port');
                        }
                      }}
                    />
                  ))}
                </ul>
              )}

              {publishedPorts.length > 0 && !showPublishForm && (
                <div className="border-t border-border p-2 bg-base/40">
                  <button
                    onClick={() => setShowPublishForm(true)}
                    className="w-full h-[30px] flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border-light text-zinc-300 hover:bg-emerald-500/[0.08] hover:border-emerald-500/40 hover:text-emerald-200 transition-colors text-[12px] font-medium"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Publish a port
                  </button>
                </div>
              )}

              {showPublishForm && (
                <PublishPortForm
                  onCancel={() => { setShowPublishForm(false); setPublishError(null); }}
                  onSubmit={async ({ port, publicPort, label }) => {
                    if (!client || !sessionId) return;
                    try {
                      await client.publishPort(sessionId, { port, publicPort, label });
                      setShowPublishForm(false);
                      setPublishError(null);
                    } catch (e: any) {
                      // Includes the server's "already in use" reason, which
                      // is the whole point of keeping the form open here.
                      setPublishError(e?.message || 'Failed to publish port');
                    }
                  }}
                />
              )}
            </>
          )}

          {/* ---- SSH: the remote host's ports, tunnelled back here ---- */}
          {remoteId && (
            <>
              {(viewerIsRemote || publishedPorts.length > 0) && (
                <SectionHead
                  icon={<Network className="w-3 h-3" />}
                  title="From the remote"
                  hint={`${forwards.length || 'none'}`}
                />
              )}

              {error && (
                <div className="px-3.5 py-2 text-[11px] text-red-300 bg-red-500/[0.06] border-b border-red-500/20">
                  {error}
                </div>
              )}

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
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Divider that names a direction. Only rendered when both directions are on
 *  screen — with one list, a header just adds a line to read. */
function SectionHead({ icon, title, hint }: { icon: React.ReactNode; title: string; hint: string }) {
  return (
    <div className="px-3.5 py-1.5 flex items-center gap-1.5 bg-base/50 border-b border-border">
      <span className="text-zinc-500">{icon}</span>
      <span className="text-[10px] uppercase tracking-[0.1em] font-semibold text-zinc-400">{title}</span>
      <span className="ml-auto font-mono text-[10px] text-zinc-600">{hint}</span>
    </div>
  );
}

function PublishedRow({ port, url, onRemove }: { port: PublishedPort; url: string; onRemove: () => void }) {
  return (
    <li className="group px-3.5 py-2 grid grid-cols-[1fr_auto] gap-2.5 items-center hover:bg-surface-light not-first:border-t not-first:border-border">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-zinc-200 truncate">
            {port.label?.trim() || `Port ${port.targetPort}`}
          </span>
          <LivePill />
        </div>
        <div className="mt-0.5 font-mono text-[10.5px] text-zinc-500 flex items-center gap-1.5">
          <span className="text-emerald-300/90">:{port.publicPort}</span>
          <ArrowRight />
          <span className="text-zinc-300/90">{port.targetHost}:{port.targetPort}</span>
          {port.connections > 0 && <span className="text-zinc-600">· {port.connections} conn</span>}
        </div>
      </div>
      <div className="flex gap-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
        <IconBtn title={`Copy ${url}`} onClick={() => { void navigator.clipboard?.writeText(url); }}>
          <Copy className="w-3.5 h-3.5" />
        </IconBtn>
        <IconBtn title="Open in browser" onClick={() => { window.open(url, '_blank', 'noopener'); }}>
          <ExternalLink className="w-3.5 h-3.5" />
        </IconBtn>
        <IconBtn title="Stop publishing" onClick={onRemove} danger>
          <X className="w-3.5 h-3.5" />
        </IconBtn>
      </div>
    </li>
  );
}

function LivePill() {
  return (
    <span className="inline-flex items-center gap-1 text-[9.5px] font-semibold uppercase tracking-wider text-emerald-400 bg-emerald-400/10 border border-emerald-400/25 px-1.5 py-px rounded-full">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
      Live
    </span>
  );
}

function PublishEmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="px-4 py-5 text-center border-b border-border">
      <div className="text-[12.5px] font-medium text-zinc-200">Nothing published</div>
      <div className="text-[11.5px] text-zinc-500 mt-0.5 mb-3">
        Your browser is on another machine, so this one's <span className="font-mono text-zinc-400">localhost</span> ports
        are not reachable until they are published.
      </div>
      <button
        onClick={onAdd}
        className="h-[28px] px-3 inline-flex items-center gap-1.5 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 text-[11.5px] font-medium border border-emerald-500/30 transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
        Publish a port
      </button>
    </div>
  );
}

function PublishPortForm({
  onSubmit, onCancel,
}: {
  onSubmit: (v: { port: number; publicPort: number | null; label?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [port, setPort] = useState('');
  const [publicPort, setPublicPort] = useState('');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const portRef = useRef<HTMLInputElement>(null);

  useEffect(() => { portRef.current?.focus(); }, []);

  const portNum = useMemo(() => {
    const n = Number(port);
    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
  }, [port]);
  // -1 means "typed, but not a port" — distinct from "left blank", which is
  // the normal case and lets the server pick.
  const publicNum = useMemo(() => {
    if (!publicPort.trim()) return null;
    const n = Number(publicPort);
    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : -1;
  }, [publicPort]);

  const valid = portNum !== null && publicNum !== -1;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || !portNum) return;
    setSubmitting(true);
    try {
      await onSubmit({ port: portNum, publicPort: publicNum === -1 ? null : publicNum, label: label.trim() || undefined });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="border-t border-border bg-gradient-to-b from-base/60 to-base px-3.5 py-3">
      <div className="text-[10px] uppercase tracking-[0.12em] font-semibold text-zinc-500 mb-2.5 flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        Publish a port
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Local port" required>
          <Input ref={portRef} mono value={port} onChange={e => setPort(e.target.value)} placeholder="5173" inputMode="numeric" />
        </Field>
        <Field label="Public port" hint="auto">
          <Input mono value={publicPort} onChange={e => setPublicPort(e.target.value)} placeholder="auto" inputMode="numeric" />
        </Field>
      </div>

      <div className="mt-2.5">
        <Field label="Label" hint="optional">
          <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Vite dev" />
        </Field>
      </div>

      {portNum && (
        <div className="mt-2.5 px-2.5 py-1.5 font-mono text-[10.5px] text-zinc-500 bg-base border border-border rounded-md flex items-center gap-1.5">
          <span className="w-1 h-1 rounded-full bg-emerald-400 shrink-0" />
          <span className="truncate">
            Opens at{' '}
            <span className="text-zinc-300">
              {window.location.hostname}:{publicNum && publicNum > 0 ? publicNum : portNum}
            </span>{' '}
            → localhost:{portNum}
          </span>
        </div>
      )}

      <div className="mt-2 text-[10.5px] text-zinc-500 leading-snug">
        Binds on every network interface with no authentication in front of it.
      </div>

      <div className="flex items-center gap-1.5 mt-3">
        <button
          type="submit"
          disabled={!valid || submitting}
          className="h-[30px] px-3.5 inline-flex items-center gap-1.5 rounded-md text-[12px] font-semibold text-emerald-50 bg-gradient-to-b from-emerald-400 to-emerald-600 border border-emerald-400/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_6px_14px_-8px_rgba(52,211,153,0.7)] hover:brightness-110 transition disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100"
        >
          <Check className="w-3.5 h-3.5" />
          {submitting ? 'Publishing…' : 'Publish'}
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
