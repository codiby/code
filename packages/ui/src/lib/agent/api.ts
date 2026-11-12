/**
 * Client for the Codiby Agent's `/agent/*` routes on one host. The agent runs
 * on whichever bridge has it enabled (often a remote like ryzen9), so every
 * call is pinned to a host instead of following the focused session.
 *
 * Each area keeps its own typed helpers in `lib/agent/<area>.ts` built on
 * `AgentApi.get/send`, so areas never edit each other's files.
 */

import type { ClaudeClient } from '../claude-client';

export class AgentApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class AgentApi {
  constructor(readonly client: ClaudeClient, readonly remoteId: string | null) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.client.hostFetch(this.remoteId, path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const message = (data && typeof data === 'object' && 'error' in data) ? String((data as { error: unknown }).error) : `${res.status} ${res.statusText}`;
      throw new AgentApiError(res.status, message);
    }
    return data as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return this.request<T>(method, path, body ?? {});
  }
}

// ---------------------------------------------------------------------------
// Core types (mirror packages/core/agent)
// ---------------------------------------------------------------------------

export interface AgentPersona { name: string; emoji: string; language: string; timezone: string; style: string; }
export interface AgentOwner { name: string; telegramChatIds: string[]; whatsappJids: string[]; emails: string[]; }
export interface AgentConfig {
  enabled: boolean;
  persona: AgentPersona;
  owner: AgentOwner;
  workspaceDir: string;
  quietHours: { enabled: boolean; start: string; end: string };
  preferredChannel: string | null;
  provider: string;
  model: string | null;
}

export interface AgentChannelSummary {
  id: string;
  type: string;
  name: string;
  status: { connected: boolean; detail?: string; lastError?: string | null };
  ownerPaired: boolean;
}

export interface AgentStatus {
  enabled: boolean;
  host: string;
  persona: AgentPersona;
  session: null | {
    id: string;
    name: string;
    runtimeStatus: string;
    permissionMode: string;
    isStreaming: boolean;
    pendingApproval: { requestId: string; toolName: string } | null;
    messageCount: number;
  };
  channels: AgentChannelSummary[];
}

export interface AgentChannelMessage {
  id: string;
  direction: 'in' | 'out';
  channelId: string;
  channelType: string;
  peer: string;
  peerName: string | null;
  trusted: boolean;
  kind: string;
  text: string;
  status: string;
  error: string | null;
  createdAt: number;
  handledAt: number | null;
}

export const agentCore = {
  status: (api: AgentApi) => api.get<AgentStatus>('/agent/status'),
  config: (api: AgentApi) => api.get<AgentConfig>('/agent/config'),
  saveConfig: (api: AgentApi, patch: Partial<AgentConfig>) => api.send<AgentConfig>('PUT', '/agent/config', patch),
  messages: (api: AgentApi, opts: { limit?: number; direction?: 'in' | 'out'; trusted?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.direction) q.set('direction', opts.direction);
    if (opts.trusted !== undefined) q.set('trusted', String(opts.trusted));
    return api.get<{ messages: AgentChannelMessage[] }>(`/agent/messages?${q}`);
  },
  markHandled: (api: AgentApi, id: string) => api.send<{ ok: true }>('POST', `/agent/messages/${encodeURIComponent(id)}/handled`),
};
