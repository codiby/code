import { useEffect, useState } from 'react';
import { Button, TextField, Input } from '@heroui/react';
import { getNative } from '../lib/native';

const REMOTE_COLORS = ['blue', 'green', 'amber', 'violet', 'red', 'pink'] as const;
type RemoteColor = typeof REMOTE_COLORS[number] | 'auto';

const COLOR_DOT: Record<string, string> = {
  blue:   'bg-blue-400',
  green:  'bg-green-400',
  amber:  'bg-amber-400',
  violet: 'bg-violet-400',
  red:    'bg-red-400',
  pink:   'bg-pink-400',
};

type TunnelStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline';

interface Remote {
  id: string;
  name: string;
  alias: string;
  bunPort: number;
  color: string;
  createdAt: number;
  status?: TunnelStatus;
  lastError?: string | null;
}

interface Props {
  serverUrl: string | null;
}

export function RemotesSection({ serverUrl }: Props) {
  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<Remote | 'new' | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  // Initial load.
  useEffect(() => {
    if (!serverUrl) return;
    refresh();
  }, [serverUrl]);

  // Keep the remotes LIST in sync via the bun WS (`remotes` broadcast on CRUD).
  useEffect(() => {
    if (!serverUrl) return;
    const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg?.type === 'remotes' && Array.isArray(msg.remotes)) {
            setRemotes(prev => msg.remotes.map((r: Remote) => {
              // Preserve the live tunnel status we track from main.
              const cur = prev.find(p => p.id === r.id);
              return { ...r, status: cur?.status, lastError: cur?.lastError };
            }));
          }
        } catch {}
      };
    } catch {}
    return () => { try { ws?.close(); } catch {} };
  }, [serverUrl]);

  // Tunnel STATUS now comes from the Electron main process (it owns the
  // tunnels), pushed over IPC instead of bun's old `remote.status` WS frames.
  useEffect(() => {
    const native = getNative();
    if (!native?.onRemoteTunnelStatus) return;
    return native.onRemoteTunnelStatus(({ remoteId, status, lastError }) => {
      setRemotes(prev => prev.map(r =>
        r.id === remoteId ? { ...r, status: status as TunnelStatus, lastError } : r,
      ));
    });
  }, []);

  async function refresh() {
    if (!serverUrl) return;
    try {
      const res = await fetch(`${serverUrl}/remotes`);
      if (res.ok) setRemotes(await res.json());
    } catch {}
    setLoaded(true);
  }

  async function handleDelete(id: string) {
    if (!serverUrl) return;
    try {
      await fetch(`${serverUrl}/remotes/${id}`, { method: 'DELETE' });
      // Tear down the (Electron-main-owned) tunnel for the removed remote.
      await getNative()?.invoke('remote_tunnel_disconnect', { remoteId: id }).catch(() => {});
      await refresh();
    } catch {}
    setConfirmingDelete(null);
  }

  return (
    <div className="pt-4 border-t border-border">
      <div className="flex items-center gap-2 mb-3">
        <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
          <path d="M7 8h.01M7 16h.01" strokeLinecap="round" strokeWidth="2.5" />
        </svg>
        <span className="text-[12px] font-medium text-zinc-300">Remotes (SSH)</span>
        <Button
          size="sm"
          onPress={() => setEditing('new')}
          className="ml-auto h-auto px-2 py-0.5 min-w-0 text-[11px] text-zinc-300 bg-zinc-800 hover:bg-zinc-700 border border-border hover:border-border-light rounded-md"
        >
          + Add Remote
        </Button>
      </div>

      <p className="text-[12px] text-zinc-500 px-1 mb-3">
        Connect to a workstation where the bun bridge is already running. Each remote points at a <code className="text-zinc-400">Host</code> entry in your <code className="text-zinc-400">~/.ssh/config</code>; sessions you create there live on that machine and survive disconnects.
      </p>

      {!loaded ? (
        <div className="text-[12px] text-zinc-600 px-1">Loading...</div>
      ) : remotes.length === 0 ? (
        <div className="text-[12px] text-zinc-600 px-1 py-2">No remotes configured.</div>
      ) : (
        <div className="space-y-1.5">
          {remotes.map(r => (
            <RemoteRow
              key={r.id}
              remote={r}
              isConfirmingDelete={confirmingDelete === r.id}
              onEdit={() => setEditing(r)}
              onAskDelete={() => setConfirmingDelete(r.id)}
              onCancelDelete={() => setConfirmingDelete(null)}
              onConfirmDelete={() => handleDelete(r.id)}
              serverUrl={serverUrl}
            />
          ))}
        </div>
      )}

      {editing && serverUrl && (
        <RemoteEditDialog
          serverUrl={serverUrl}
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One row in the remotes list
// ---------------------------------------------------------------------------

function statusLabel(s: TunnelStatus | undefined): { label: string; tone: string } {
  switch (s) {
    case 'online':       return { label: 'online',       tone: 'text-green-400' };
    case 'connecting':   return { label: 'connecting…',  tone: 'text-amber-400' };
    case 'reconnecting': return { label: 'reconnecting…', tone: 'text-amber-400' };
    case 'offline':      return { label: 'offline',      tone: 'text-red-400'   };
    case 'idle':
    default:             return { label: 'idle',         tone: 'text-zinc-500'  };
  }
}

function RemoteRow({
  remote, isConfirmingDelete, onEdit, onAskDelete, onCancelDelete, onConfirmDelete, serverUrl,
}: {
  remote: Remote;
  isConfirmingDelete: boolean;
  onEdit: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  serverUrl: string | null;
}) {
  const dot = COLOR_DOT[remote.color] || 'bg-zinc-500';
  const { label, tone } = statusLabel(remote.status);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      // Test Connection runs in Electron main (it owns the tunnel).
      const native = getNative();
      if (!native) { setTestResult('✗ Requires the desktop app'); return; }
      const data = await native.invoke<{ ok: boolean; reason?: string }>('remote_test', { remoteId: remote.id });
      if (data.ok) setTestResult('✓ Connected · bridge up');
      else setTestResult(`✗ ${data.reason || 'Unknown error'}`);
    } catch (e: any) {
      setTestResult(`✗ ${e?.message || String(e)}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex flex-col gap-1 px-2 py-2 rounded-md bg-zinc-900/60 border border-border">
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${dot}`} />
        <span className="text-[12px] text-zinc-200 truncate">{remote.name}</span>
        <span className="text-[11px] text-zinc-500 font-mono truncate">{remote.alias}:{remote.bunPort}</span>
        <span className={`ml-auto text-[10px] uppercase tracking-wider ${tone}`}>{label}</span>
      </div>
      {remote.lastError && remote.status !== 'online' && (
        <div className="text-[11px] text-red-400/90 px-1 truncate" title={remote.lastError}>{remote.lastError}</div>
      )}
      <div className="flex items-center gap-1 mt-0.5">
        <Button
          size="sm"
          onPress={handleTest}
          isDisabled={testing}
          className="h-auto px-2 py-0.5 min-w-0 text-[10px] uppercase tracking-wider text-zinc-400 hover:text-zinc-200 bg-transparent hover:bg-zinc-800"
        >
          {testing ? 'Testing…' : 'Test'}
        </Button>
        <Button
          size="sm"
          onPress={onEdit}
          className="h-auto px-2 py-0.5 min-w-0 text-[10px] uppercase tracking-wider text-zinc-400 hover:text-zinc-200 bg-transparent hover:bg-zinc-800"
        >
          Edit
        </Button>
        {!isConfirmingDelete ? (
          <Button
            size="sm"
            onPress={onAskDelete}
            className="h-auto px-2 py-0.5 min-w-0 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-red-300 bg-transparent hover:bg-red-500/10"
          >
            Remove
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              onPress={onConfirmDelete}
              className="h-auto px-2 py-0.5 min-w-0 text-[10px] uppercase tracking-wider text-red-300 bg-red-500/10 hover:bg-red-500/20"
            >
              Confirm remove
            </Button>
            <Button
              size="sm"
              onPress={onCancelDelete}
              className="h-auto px-2 py-0.5 min-w-0 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 bg-transparent hover:bg-zinc-800"
            >
              Cancel
            </Button>
          </>
        )}
        {testResult && (
          <span className={`ml-auto text-[11px] ${testResult.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`} title={testResult}>
            {testResult}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add / Edit dialog
// ---------------------------------------------------------------------------

function RemoteEditDialog({
  serverUrl, initial, onClose, onSaved,
}: {
  serverUrl: string;
  initial: Remote | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name ?? '');
  const [alias, setAlias] = useState(initial?.alias ?? '');
  const [bunPort, setBunPort] = useState(String(initial?.bunPort ?? 3111));
  const [color, setColor] = useState<RemoteColor>(((initial?.color ?? 'auto') as RemoteColor));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    setSaving(true);
    const body = {
      name: name.trim(),
      alias: alias.trim(),
      bunPort: Number(bunPort) || 3111,
      color,
    };
    try {
      const url = isEdit ? `${serverUrl}/remotes/${initial!.id}` : `${serverUrl}/remotes`;
      const res = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error || `Save failed (HTTP ${res.status})`);
        setSaving(false);
        return;
      }
      // On edit, drop the (main-owned) tunnel so it respawns with the new
      // alias/port on next use.
      if (isEdit && initial) {
        await getNative()?.invoke('remote_tunnel_disconnect', { remoteId: initial.id }).catch(() => {});
      }
      onSaved();
    } catch (e: any) {
      setError(e?.message || String(e));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[420px] max-w-[92vw] p-4 rounded-lg bg-zinc-900 border border-border shadow-2xl">
        <div className="text-[13px] font-medium text-zinc-200 mb-3">
          {isEdit ? `Edit remote — ${initial!.name}` : 'Add remote'}
        </div>

        <div className="space-y-2.5">
          <div>
            <label className="block text-[11px] text-zinc-500 mb-1 px-1">Display name</label>
            <TextField value={name} onChange={setName} aria-label="Display name">
              <Input placeholder="prod-workstation" className="text-[12px]" />
            </TextField>
          </div>

          <div>
            <label className="block text-[11px] text-zinc-500 mb-1 px-1">SSH alias (~/.ssh/config Host)</label>
            <TextField value={alias} onChange={setAlias} aria-label="SSH alias">
              <Input placeholder="workstation" className="font-mono text-[12px]" />
            </TextField>
            <p className="mt-1 text-[10px] text-zinc-600 px-1">
              The alias must exist in your <code className="text-zinc-400">~/.ssh/config</code>. User, port, IdentityFile, ProxyJump are taken from there — we never override them.
            </p>
          </div>

          <div>
            <label className="block text-[11px] text-zinc-500 mb-1 px-1">Remote bun port</label>
            <TextField value={bunPort} onChange={setBunPort} aria-label="Remote bun port">
              <Input placeholder="3111" className="font-mono text-[12px]" />
            </TextField>
          </div>

          <div>
            <label className="block text-[11px] text-zinc-500 mb-1 px-1">Color</label>
            <div className="flex items-center gap-1.5">
              {REMOTE_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`w-5 h-5 rounded-full ${COLOR_DOT[c]} ${color === c ? 'ring-2 ring-offset-2 ring-offset-zinc-900 ring-zinc-200' : 'opacity-70 hover:opacity-100'}`}
                  aria-label={`Color ${c}`}
                />
              ))}
              <button
                type="button"
                onClick={() => setColor('auto')}
                className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded ${color === 'auto' ? 'text-zinc-200 bg-zinc-700' : 'text-zinc-500 bg-zinc-800 hover:text-zinc-300'}`}
              >
                Auto
              </button>
            </div>
          </div>

          {error && (
            <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5">
              {error}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Button
              onPress={onClose}
              className="text-[12px] px-3 py-1.5 h-auto rounded-md text-zinc-400 bg-transparent hover:bg-zinc-800"
            >
              Cancel
            </Button>
            <Button
              onPress={handleSave}
              isDisabled={saving || !name.trim() || !alias.trim()}
              className="ml-auto text-[12px] px-3 py-1.5 h-auto rounded-md font-medium text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-border hover:border-border-light"
            >
              {saving ? 'Saving…' : isEdit ? 'Save' : 'Add'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
