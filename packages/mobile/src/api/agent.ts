/**
 * The Codiby Agent's routes on one host: status, pending approvals, and the
 * push registration of this phone. Unlike `requestJson`, failures keep the
 * bridge's own `error` text ("Firebase is not configured…"), because here the
 * reason is what tells the user what to fix.
 */

import { ServerError } from './client';

const TIMEOUT_MS = 8_000;

/**
 * The host never answered (offline, wrong route, timeout) — as opposed to
 * answering with an error. Callers with several routes try the next one only
 * for this.
 */
export class UnreachableError extends ServerError {
  constructor(message: string) {
    super(message);
    this.name = 'UnreachableError';
  }
}

/** By name too: transpiled `extends Error` classes can lose their prototype. */
export function isUnreachable(error: unknown): boolean {
  return (
    error instanceof UnreachableError ||
    (error instanceof Error && error.name === 'UnreachableError')
  );
}

export interface AgentStatus {
  readonly enabled: boolean;
  readonly host: string;
  readonly persona: { readonly name: string; readonly emoji: string };
  readonly session: {
    readonly id: string;
    readonly name: string;
    readonly runtimeStatus: string;
    readonly isStreaming: boolean;
    readonly pendingApproval: {
      readonly requestId: string;
      readonly toolName: string;
    } | null;
  } | null;
}

export interface PendingApproval {
  readonly requestId: string;
  readonly code: string;
  readonly toolName: string;
  readonly title: string;
  readonly summary: string;
  readonly category: string | null;
  readonly sessionId: string;
  readonly sessionName: string;
  readonly createdAt: number;
  readonly expiresAt: number | null;
}

export interface PushRegistration {
  readonly deviceId: string;
  /** Whether the host has its Firebase key; without it nothing can be pushed yet. */
  readonly configured: boolean;
}

export interface PushTestResult {
  readonly ok: boolean;
  readonly results: readonly {
    readonly deviceId: string;
    readonly ok: boolean;
    readonly error?: string;
  }[];
}

async function agentRequest(
  baseUrl: string,
  token: string,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = {},
): Promise<unknown> {
  const timeoutMs = init.timeoutMs ?? TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token.trim().length > 0) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (response.status === 401) {
      throw new ServerError('Invalid or missing token');
    }
    if (!response.ok) {
      const message =
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : `The server responded with HTTP ${response.status}`;
      throw new ServerError(message);
    }
    return body;
  } catch (error) {
    if (error instanceof ServerError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new UnreachableError(`No response after ${timeoutMs / 1000} s`);
    }
    throw new UnreachableError('Could not reach the server');
  } finally {
    clearTimeout(timer);
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function parseAgentStatus(body: unknown): AgentStatus {
  const raw = record(body);
  const persona = record(raw.persona);
  const session =
    raw.session === null || raw.session === undefined
      ? null
      : record(raw.session);
  const pending = session === null ? null : session.pendingApproval;
  return {
    enabled: raw.enabled === true,
    host: str(raw.host),
    persona: { name: str(persona.name) || 'Codiby', emoji: str(persona.emoji) },
    session:
      session === null
        ? null
        : {
            id: str(session.id),
            name: str(session.name),
            runtimeStatus: str(session.runtimeStatus),
            isStreaming: session.isStreaming === true,
            pendingApproval:
              typeof pending === 'object' && pending !== null
                ? {
                    requestId: str(record(pending).requestId),
                    toolName: str(record(pending).toolName),
                  }
                : null,
          },
  };
}

export function parseApprovals(body: unknown): PendingApproval[] {
  const list = record(body).approvals;
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map(record)
    .filter(item => str(item.requestId).length > 0)
    .map(item => ({
      requestId: str(item.requestId),
      code: str(item.code),
      toolName: str(item.toolName),
      title: str(item.title) || str(item.toolName),
      summary: str(item.summary),
      category: str(item.category) || null,
      sessionId: str(item.sessionId),
      sessionName: str(item.sessionName),
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
      // 0 = no expiry (approvals of coding sessions wait indefinitely).
      expiresAt:
        typeof item.expiresAt === 'number' && item.expiresAt > 0
          ? item.expiresAt
          : null,
    }));
}

export async function fetchAgentStatus(
  baseUrl: string,
  token: string,
): Promise<AgentStatus> {
  return parseAgentStatus(await agentRequest(baseUrl, token, '/agent/status'));
}

export async function fetchApprovals(
  baseUrl: string,
  token: string,
): Promise<PendingApproval[]> {
  return parseApprovals(await agentRequest(baseUrl, token, '/agent/approvals'));
}

export async function answerApproval(
  baseUrl: string,
  token: string,
  requestId: string,
  allow: boolean,
  via: 'app' | 'push',
): Promise<void> {
  await agentRequest(
    baseUrl,
    token,
    `/agent/approvals/${encodeURIComponent(requestId)}`,
    {
      method: 'POST',
      body: { allow, via },
    },
  );
}

export async function registerPushDevice(
  baseUrl: string,
  token: string,
  device: {
    platform: 'android' | 'ios';
    token: string;
    name: string;
    appVersion?: string;
    replacesToken?: string | null;
  },
): Promise<PushRegistration> {
  const body = record(
    await agentRequest(baseUrl, token, '/agent/push/devices', {
      method: 'POST',
      body: device,
    }),
  );
  const deviceId = str(record(body.device).id);
  if (deviceId.length === 0) {
    throw new ServerError('The host did not return a device id');
  }
  return { deviceId, configured: body.configured === true };
}

export async function sendTestPush(
  baseUrl: string,
  token: string,
  deviceId: string,
): Promise<PushTestResult> {
  const body = record(
    await agentRequest(baseUrl, token, '/agent/push/test', {
      method: 'POST',
      body: { deviceId },
      timeoutMs: 20_000,
    }),
  );
  const results = Array.isArray(body.results)
    ? body.results.map(record).map(r => ({
        deviceId: str(r.deviceId),
        ok: r.ok === true,
        ...(typeof r.error === 'string' ? { error: r.error } : {}),
      }))
    : [];
  return { ok: body.ok === true, results };
}
