/**
 * Agent view → Browser: the agent host's headless Chromium — what it runs,
 * which tabs it holds, and a live view of the selected tab. Frames are
 * fetched every 1.5 s only while the view is on screen and the window is
 * visible, so a forgotten tab costs the host nothing.
 */

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowUpRight, Globe, Pause, Square } from 'lucide-react';
import type { AgentApi } from '../../lib/agent/api';
import { agentBrowser, tabKey, type AgentBrowserStatus, type AgentBrowserTab } from '../../lib/agent/browser';
import { Button, Card, EmptyNote, ErrorNote, Pill, Section, Spinner, Stat, relativeTime, usePolled, type AgentSectionProps } from './ui';

const STATUS_INTERVAL_MS = 3_000;
const FRAME_INTERVAL_MS = 1_500;

const ENGINE_LABEL: Record<NonNullable<AgentBrowserStatus['executableKind']>, string> = {
  'headless-shell': 'Headless shell',
  chromium: 'Chromium',
  chrome: 'Chrome',
};

/** True while `ref` is on screen and the window is not hidden. */
function useOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible');
  const [intersecting, setIntersecting] = useState(true);

  useEffect(() => {
    const onChange = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setIntersecting(!!entry?.isIntersecting));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return pageVisible && intersecting;
}

function LiveView({ api, tab }: { api: AgentApi; tab: AgentBrowserTab }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(boxRef);
  const [src, setSrc] = useState<string | null>(null);
  const [frameAt, setFrameAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const srcRef = useRef<string | null>(null);

  // Object URLs pin their blob until revoked; drop the last one on unmount.
  useEffect(() => () => { if (srcRef.current) URL.revokeObjectURL(srcRef.current); }, []);

  useEffect(() => {
    if (!onScreen || !tab.live) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const tick = async () => {
      try {
        const blob = await agentBrowser.frame(api, tab, ctrl.signal);
        if (cancelled) return;
        if (blob) {
          const url = URL.createObjectURL(blob);
          if (srcRef.current) URL.revokeObjectURL(srcRef.current);
          srcRef.current = url;
          setSrc(url);
          setFrameAt(Date.now());
        }
        setGone(!blob);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
      // Wait for each frame before asking for the next: a slow link never piles requests up.
      if (!cancelled) timer = setTimeout(() => void tick(), FRAME_INTERVAL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      ctrl.abort();
      clearTimeout(timer);
    };
    // `tab` is identified by session + name; its other fields change on every status poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, tab.sessionId, tab.name, tab.live, onScreen]);

  const paused = tab.live && !onScreen;
  return (
    <Card className="p-0 overflow-hidden">
      <div className="flex items-center gap-2 px-3.5 py-2 border-b border-border min-w-0">
        <Globe size={13} className="text-zinc-500 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] text-zinc-200 font-medium truncate">{tab.title || tab.name}</div>
          <div className="text-[11px] text-zinc-500 truncate font-mono">{tab.url}</div>
        </div>
        {paused ? <Pill>Paused</Pill> : tab.live ? <Pill tone="green">Live</Pill> : <Pill>Sleeping</Pill>}
        {frameAt && tab.live && <span className="text-[10.5px] text-zinc-600 whitespace-nowrap">{relativeTime(frameAt)}</span>}
      </div>
      <div ref={boxRef} className="relative bg-base aspect-[1280/900]">
        {!tab.live ? (
          <div className="absolute inset-0 grid place-items-center px-6 text-center text-[12px] text-zinc-500">
            The browser is stopped. This tab reopens at its last page the next time it is used.
          </div>
        ) : src && !gone ? (
          <img src={src} alt={`Live view of ${tab.title || tab.name}`} className="absolute inset-0 w-full h-full object-contain select-none" draggable={false} />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-[12px] text-zinc-500">
            {gone ? 'This tab is no longer live.' : 'Waiting for the first frame…'}
          </div>
        )}
        {paused && src && (
          <div className="absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded-full bg-black/60 text-[10.5px] text-zinc-300">
            <Pause size={10} /> Paused while hidden
          </div>
        )}
      </div>
      {error && <div className="p-2.5 border-t border-border"><ErrorNote message={error} /></div>}
    </Card>
  );
}

function TabRow({ tab, selected, onSelect, onOpenSession }: {
  tab: AgentBrowserTab;
  selected: boolean;
  onSelect: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  return (
    <div
      className={`flex items-center gap-2.5 px-3 py-2 rounded-md border transition-colors ${
        selected ? 'border-indigo-400/50 bg-indigo-400/5' : 'border-border bg-surface hover:bg-surface-light'
      }`}
    >
      <button type="button" onClick={onSelect} aria-pressed={selected} className="flex-1 min-w-0 text-left flex items-center gap-2.5">
        <Globe size={13} className={tab.live ? 'text-indigo-300 shrink-0' : 'text-zinc-600 shrink-0'} />
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] text-zinc-200 truncate">{tab.title || tab.name}</span>
          <span className="block text-[11px] text-zinc-500 truncate">
            <span className="text-zinc-400">{tab.name}</span> · {tab.url}
          </span>
        </span>
      </button>
      {tab.agent ? <Pill tone="indigo">Agent</Pill> : <Pill>Session {tab.sessionId.slice(0, 6)}</Pill>}
      {tab.cookieJar !== 'default' && <Pill>Jar {tab.cookieJar}</Pill>}
      {tab.live ? <Pill tone="green">Live</Pill> : <Pill>Sleeping</Pill>}
      {onOpenSession && (
        <button
          type="button"
          onClick={() => onOpenSession(tab.sessionId)}
          title="Open the session that owns this tab"
          aria-label="Open the session that owns this tab"
          className="w-6 h-6 grid place-items-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-surface-lighter transition-colors"
        >
          <ArrowUpRight size={12} />
        </button>
      )}
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1 text-[12px] min-w-0">
      <span className="w-[110px] shrink-0 text-zinc-500">{label}</span>
      <span className="min-w-0 flex-1 text-zinc-300 break-all">{children}</span>
    </div>
  );
}

export function BrowserSection({ api, refreshKey, onOpenSession }: AgentSectionProps) {
  const status = usePolled(() => agentBrowser.status(api), [api, refreshKey], STATUS_INTERVAL_MS);
  const [selected, setSelected] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (status.loading && !status.data) return <Spinner />;
  if (status.error && !status.data) {
    return <ErrorNote message={`Couldn't read the browser on this host: ${status.error}`} onRetry={() => void status.reload()} />;
  }
  const s = status.data!;
  const tabs = s.tabs;
  const current = tabs.find(t => tabKey(t) === selected)
    ?? tabs.find(t => t.live && t.agent)
    ?? tabs.find(t => t.live)
    ?? tabs[0]
    ?? null;
  const liveCount = tabs.filter(t => t.live).length;

  const stop = async () => {
    setStopping(true);
    setActionError(null);
    try {
      await agentBrowser.stop(api);
      await status.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  };

  const state = s.running ? 'Running' : s.starting ? 'Starting' : 'Stopped';
  return (
    <>
      <Section
        title="Browser"
        hint="The agent's own Chromium on this host. Its logins persist across restarts; it starts on first use and stops after 15 minutes idle."
        action={
          <Button tone="danger" onClick={() => void stop()} disabled={!s.running || stopping} title="Close Chromium now. Tabs reopen at their last page when next used.">
            <Square size={11} /> {stopping ? 'Stopping…' : 'Stop browser'}
          </Button>
        }
      >
        {actionError && <div className="mb-3"><ErrorNote message={actionError} /></div>}
        {!s.available && s.error && <div className="mb-3"><ErrorNote message={s.error} /></div>}
        {s.available && s.error && !s.running && <div className="mb-3"><ErrorNote message={`Last problem: ${s.error}`} /></div>}

        <div className="flex gap-2.5 mb-3">
          <Stat value={state} label="Status" tone={s.running ? 'text-green-400' : s.starting ? 'text-amber-300' : undefined} />
          <Stat value={tabs.length ? `${liveCount} of ${tabs.length}` : '0'} label="Live tabs" />
          <Stat value={s.executableKind ? ENGINE_LABEL[s.executableKind] : '—'} label="Engine" />
        </div>

        <Card>
          <DetailRow label="Executable">
            {s.executable ? <span className="font-mono text-[11.5px]">{s.executable}</span> : <span className="text-zinc-500">None found</span>}
          </DetailRow>
          {s.running && (
            <DetailRow label="Process">
              <span className="inline-flex items-center gap-2">
                pid {s.pid}
                {s.sandbox ? <Pill tone="green">Sandboxed</Pill> : <Pill tone="amber">No sandbox</Pill>}
              </span>
            </DetailRow>
          )}
          {s.running && <DetailRow label="Started">{relativeTime(s.startedAt)}</DetailRow>}
          {s.running && <DetailRow label="Idle shutdown">{relativeTime(s.idleShutdownAt)}</DetailRow>}
          {!s.running && <DetailRow label="Last used">{relativeTime(s.lastUsedAt)}</DetailRow>}
        </Card>
      </Section>

      <Section title="Tabs" hint="The agent browses in its persistent profile; other sessions get throwaway cookie jars.">
        {tabs.length === 0 ? (
          <EmptyNote>No tabs yet. The agent opens one when it needs the web.</EmptyNote>
        ) : (
          <div className="flex flex-col gap-1.5">
            {tabs.map(t => (
              <TabRow
                key={tabKey(t)}
                tab={t}
                selected={!!current && tabKey(current) === tabKey(t)}
                onSelect={() => setSelected(tabKey(t))}
                onOpenSession={onOpenSession}
              />
            ))}
          </div>
        )}
      </Section>

      {current && (
        <Section title="Live view">
          <LiveView key={tabKey(current)} api={api} tab={current} />
        </Section>
      )}
    </>
  );
}
