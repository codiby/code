/**
 * The Agent screen — Codiby's always-on personal agent. Mounted in the main
 * pane when the sidebar's "Agent" nav item is active.
 *
 * The agent lives on one host (the one with it enabled — often a remote such
 * as ryzen9), so the screen is pinned to a host picked in the header rather
 * than following the focused session. Each tab is a section component owned
 * by one area of packages/core/agent.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Bot, RotateCw, Server } from 'lucide-react';
import type { ClaudeClient } from '../../lib/claude-client';
import { AgentApi, agentCore } from '../../lib/agent/api';
import { discoverAgentHost } from '../../lib/agent/polled';
import { ActivitySection } from './ActivitySection';
import { BrowserSection } from './BrowserSection';
import { ChannelsSection } from './ChannelsSection';
import { ConnectionsSection } from './ConnectionsSection';
import { DevicesSection } from './DevicesSection';
import { HeartbeatSection } from './HeartbeatSection';
import { MemorySection } from './MemorySection';
import { OverviewSection } from './OverviewSection';
import { PersonaSection } from './PersonaSection';
import { RulesSection } from './RulesSection';
import type { AgentSectionProps } from './ui';

type TabId = 'overview' | 'activity' | 'channels' | 'rules' | 'memory' | 'persona' | 'heartbeat' | 'connections' | 'devices' | 'browser';

const TABS: { id: TabId; label: string; Component: (p: AgentSectionProps) => ReactElement }[] = [
  { id: 'overview', label: 'Overview', Component: OverviewSection },
  { id: 'activity', label: 'Activity', Component: ActivitySection },
  { id: 'channels', label: 'Channels', Component: ChannelsSection },
  { id: 'rules', label: 'Rules', Component: RulesSection },
  { id: 'memory', label: 'Memory', Component: MemorySection },
  { id: 'persona', label: 'Persona', Component: PersonaSection },
  { id: 'heartbeat', label: 'Heartbeat', Component: HeartbeatSection },
  { id: 'connections', label: 'Connections', Component: ConnectionsSection },
  { id: 'devices', label: 'Devices', Component: DevicesSection },
  { id: 'browser', label: 'Browser', Component: BrowserSection },
];

const HOST_KEY = 'codiby.agent.host';
const TAB_KEY = 'codiby.agent.tab';
const LOCAL = '__local__';

interface Props {
  client: ClaudeClient;
  onOpenSession?: (sessionId: string) => void;
}

export function AgentView({ client, onOpenSession }: Props) {
  const [hosts, setHosts] = useState<{ id: string; name: string }[]>([]);
  const [hostKey, setHostKey] = useState<string>(() => localStorage.getItem(HOST_KEY) || '');
  // A tab saved by an older build may no longer exist; fall back so one tab stays selected (and focusable).
  const [tab, setTab] = useState<TabId>(() => TABS.find(t => t.id === localStorage.getItem(TAB_KEY))?.id ?? 'overview');
  const [refreshKey, setRefreshKey] = useState(0);

  // Discover hosts; with no saved choice, pick the first one that has the agent enabled.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const remotes = await client.listRemoteHosts();
      if (cancelled) return;
      setHosts(remotes);
      if (localStorage.getItem(HOST_KEY)) return;
      const found = await discoverAgentHost<string | null>(
        [null, ...remotes.map(r => r.id)],
        async rid => (await agentCore.status(new AgentApi(client, rid))).enabled,
        // A host picked from the menu meanwhile is saved (effect below): it wins.
        () => !cancelled && !localStorage.getItem(HOST_KEY),
        null,
      );
      if (found) setHostKey(found.host ?? LOCAL);
    })();
    return () => { cancelled = true; };
  }, [client]);

  useEffect(() => { if (hostKey) localStorage.setItem(HOST_KEY, hostKey); }, [hostKey]);
  useEffect(() => { localStorage.setItem(TAB_KEY, tab); }, [tab]);

  const api = useMemo(
    () => (hostKey ? new AgentApi(client, hostKey === LOCAL ? null : hostKey) : null),
    [client, hostKey],
  );
  const active = TABS.find(t => t.id === tab) ?? TABS[0]!;

  return (
    // min-h-0: without it this column grows to its content inside the main
    // pane, the pane clips it, and the tab body never gets a scrollbar.
    <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-surface">
      <div className="h-12 border-b border-border flex items-center justify-between px-5 shrink-0 gap-4">
        <h1 className="text-[15px] font-semibold text-zinc-200 flex items-center gap-2 min-w-0">
          <Bot size={16} strokeWidth={2} className="text-indigo-400 shrink-0" />
          Agent
          <span className="text-[11px] text-zinc-600 font-normal ml-1 truncate">your always-on assistant, reachable from your messaging apps</span>
        </h1>
        <div className="flex items-center gap-2 shrink-0">
          <label className="flex items-center gap-1.5 text-[11.5px] text-zinc-400">
            <Server size={13} className="text-zinc-500" />
            <select
              aria-label="Agent host"
              value={hostKey}
              onChange={e => { setHostKey(e.target.value); setRefreshKey(k => k + 1); }}
              className="bg-base border border-border rounded-md px-2 py-1 text-[12px] text-zinc-200 max-w-[200px] truncate focus:outline-none focus:border-indigo-400/50"
            >
              <option value={LOCAL}>This computer</option>
              {hosts.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setRefreshKey(k => k + 1)}
            title="Reload"
            aria-label="Reload"
            className="w-7 h-7 grid place-items-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-surface-light transition-colors"
          >
            <RotateCw size={13} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* The divider is an inset shadow, not a border: a -mb-px underline
          overlapping a border made this strip overflow vertically and paint a
          stray scrollbar. The tabs' own 2px underline covers the shadow. */}
      <div
        className="px-5 flex gap-1 overflow-x-auto overflow-y-hidden no-scrollbar shrink-0 shadow-[inset_0_-1px_0_var(--color-border)]"
        role="tablist"
        aria-label="Agent sections"
        onKeyDown={e => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          const i = TABS.findIndex(t => t.id === tab);
          const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
          setTab(next.id);
          e.currentTarget.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
          e.preventDefault();
        }}
      >
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-tab={t.id}
            aria-selected={t.id === tab}
            tabIndex={t.id === tab ? 0 : -1}
            onClick={() => setTab(t.id)}
            // Inset ring: the strip clips overflow, so the browser's outer focus ring would be cut off.
            className={`px-2.5 py-2 text-[12px] whitespace-nowrap border-b-2 transition-colors rounded-t focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400/50 ${
              t.id === tab ? 'border-indigo-400 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-[18px]">
        <div className="max-w-[920px]">
          {api ? <active.Component key={`${hostKey}:${tab}`} api={api} refreshKey={refreshKey} onOpenSession={onOpenSession} /> : null}
        </div>
      </div>
    </div>
  );
}
