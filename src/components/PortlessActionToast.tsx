/**
 * Toast that pops in the bottom-right corner when a Portless action is
 * started — primarily so the user notices when the AI triggers a dev
 * server via the `portless_run` MCP tool. User-initiated runs from the
 * Project Settings pane also pop a toast, but the manual click already
 * provided feedback, so the auto-dismiss is brief there.
 *
 * Listens to the `portless_fired` window event re-emitted by ChatApp from
 * the WS callback. Stacks up to 4 toasts; older ones fade first.
 */

import { useEffect, useState } from 'react';
import { Sparkles, X, ExternalLink, Globe } from 'lucide-react';
import type { PortlessActionStatus } from '../lib/claude-client';

interface ToastItem {
  id: string;
  action: PortlessActionStatus;
  source: 'user' | 'agent';
  enteredAt: number;
}

const AGENT_TTL_MS = 8000;
const USER_TTL_MS = 3500;
const MAX_STACK = 4;

export function PortlessActionToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const onFired = (e: Event) => {
      const detail = (e as CustomEvent<{ action: PortlessActionStatus; source: 'user' | 'agent' }>).detail;
      if (!detail?.action) return;
      const item: ToastItem = {
        id: `${detail.action.key}-${Date.now()}`,
        action: detail.action,
        source: detail.source,
        enteredAt: Date.now(),
      };
      setToasts(prev => {
        // De-dupe: if a toast for the same key is already shown, replace it.
        const filtered = prev.filter(t => t.action.key !== detail.action.key);
        const next = [...filtered, item];
        return next.slice(-MAX_STACK);
      });
      const ttl = detail.source === 'agent' ? AGENT_TTL_MS : USER_TTL_MS;
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== item.id));
      }, ttl);
    };
    window.addEventListener('portless_fired', onFired);

    // The boot log eventually prints the real proxy URL (with the port
    // portless actually bound to — often :1355 because 443 needs root).
    // Swap it in-place so the user clicks the right link.
    const onUrlResolved = (e: Event) => {
      const detail = (e as CustomEvent<{ key: string; url: string }>).detail;
      if (!detail) return;
      setToasts(prev => prev.map(t =>
        t.action.key === detail.key
          ? { ...t, action: { ...t.action, url: detail.url, state: 'running' } }
          : t,
      ));
    };
    window.addEventListener('portless_url_resolved', onUrlResolved);

    return () => {
      window.removeEventListener('portless_fired', onFired);
      window.removeEventListener('portless_url_resolved', onUrlResolved);
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[9000] flex flex-col gap-2 pointer-events-none"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {toasts.map(t => (
        <ToastRow
          key={t.id}
          item={t}
          onDismiss={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
        />
      ))}
    </div>
  );
}

function ToastRow({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const isAgent = item.source === 'agent';
  return (
    <div
      className={[
        'pointer-events-auto w-[340px] rounded-lg border shadow-2xl bg-surface overflow-hidden',
        isAgent ? 'border-violet-500/40' : 'border-border-light',
      ].join(' ')}
    >
      <div
        className={[
          'px-3 py-2 flex items-center gap-2 border-b',
          isAgent
            ? 'bg-gradient-to-r from-violet-500/15 to-transparent border-violet-500/25'
            : 'bg-surface-light/60 border-border',
        ].join(' ')}
      >
        <div
          className={[
            'w-6 h-6 rounded-md flex items-center justify-center shrink-0',
            isAgent ? 'bg-violet-500/20 text-violet-300' : 'bg-emerald-500/15 text-emerald-300',
          ].join(' ')}
        >
          {isAgent ? <Sparkles className="w-3.5 h-3.5" /> : <Globe className="w-3.5 h-3.5" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[11.5px] font-semibold text-zinc-200 truncate">
            {isAgent ? 'Agent started ' : 'Started '}
            <span className="font-mono text-violet-200">{item.action.name}</span>
          </div>
          <div className="text-[10.5px] text-zinc-500">
            {item.action.state === 'starting' ? 'booting through portless…' : 'live'}
          </div>
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="w-6 h-6 inline-flex items-center justify-center rounded text-zinc-500 hover:text-zinc-200 hover:bg-surface-lighter"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <a
        href={item.action.url}
        target="_blank"
        rel="noreferrer"
        className="block px-3 py-2.5 hover:bg-surface-light group"
      >
        <div className="flex items-center gap-2 min-w-0">
          <ExternalLink className="w-3 h-3 text-zinc-500 group-hover:text-violet-300 shrink-0" />
          <span className="text-[12px] font-mono text-zinc-100 group-hover:text-violet-200 truncate">
            {item.action.url}
          </span>
        </div>
        <div className="mt-0.5 text-[10.5px] text-zinc-500 font-mono truncate">
          {item.action.command}
        </div>
      </a>
    </div>
  );
}
