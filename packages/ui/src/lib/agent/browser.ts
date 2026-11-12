/**
 * Client for the agent host's headless browser (`/agent/browser/*`): status,
 * live-view frames and stop. Mirrors packages/core/browser/manager.ts.
 */

import { AgentApiError, type AgentApi } from './api';

export interface AgentBrowserTab {
  sessionId: string;
  name: string;
  url: string;
  title: string;
  cookieJar: string;
  /** False while the browser is stopped; the tab reopens on the agent's next request. */
  live: boolean;
  agent: boolean;
  lastUsedAt: number;
}

export interface AgentBrowserStatus {
  running: boolean;
  starting: boolean;
  executable: string | null;
  executableKind: 'headless-shell' | 'chromium' | 'chrome' | null;
  /** False when no Chromium was found on the host. */
  available: boolean;
  error: string | null;
  pid: number | null;
  sandbox: boolean | null;
  startedAt: number | null;
  lastUsedAt: number | null;
  idleShutdownAt: number | null;
  tabs: AgentBrowserTab[];
}

export const agentBrowser = {
  status: (api: AgentApi) => api.get<AgentBrowserStatus>('/agent/browser/status'),

  stop: (api: AgentApi) => api.send<{ ok: true; stopped: boolean }>('POST', '/agent/browser/stop'),

  /** One JPEG frame of a live tab, or null when the tab is not live. */
  async frame(api: AgentApi, tab: { sessionId: string; name: string }, signal?: AbortSignal): Promise<Blob | null> {
    const q = new URLSearchParams({ sessionId: tab.sessionId, name: tab.name });
    const res = await api.client.hostFetch(api.remoteId, `/agent/browser/screenshot?${q}`, { signal });
    if (res.status === 404) return null;
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json() as { error?: unknown };
        if (body && typeof body.error === 'string') message = body.error;
      } catch {}
      throw new AgentApiError(res.status, message);
    }
    return res.blob();
  },
};

export function tabKey(tab: { sessionId: string; name: string }): string {
  return `${tab.sessionId}\u0000${tab.name}`;
}
