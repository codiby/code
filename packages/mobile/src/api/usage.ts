import { requestJson } from './client';

export type UsageSeverity = 'normal' | 'warning' | 'critical';
export interface UsageWindow {
  id: string;
  kind: 'session' | 'weekly' | 'other';
  label?: string;
  scope?: string | null;
  percent: number;
  severity: UsageSeverity;
  resetsAt?: string | null;
  isActive?: boolean;
  windowMinutes?: number;
}
export interface ProviderUsage {
  provider: 'claude' | 'codex';
  status: 'ok' | 'logged_out' | 'error';
  account?: { email?: string | null; plan?: string | null };
  windows: UsageWindow[];
  credits?: {
    enabled: boolean;
    label: string;
    usedMinor?: number | null;
    limitMinor?: number | null;
    currency?: string;
  } | null;
  breakdown?: { key: string; label: string; percent: number }[] | null;
  error?: string;
}
export interface UsageSnapshot {
  fetchedAt: string;
  providers: ProviderUsage[];
}

export function fetchUsage(baseUrl: string, token: string, refresh = false) {
  return requestJson<UsageSnapshot>(
    baseUrl,
    `/providers/usage${refresh ? '?refresh=1' : ''}`,
    body => {
      const snapshot = body as UsageSnapshot | null;
      if (
        typeof snapshot?.fetchedAt !== 'string' ||
        !Array.isArray(snapshot.providers) ||
        !snapshot.providers.every(
          p =>
            p &&
            ['claude', 'codex'].includes(p.provider) &&
            ['ok', 'error', 'logged_out'].includes(p.status) &&
            Array.isArray(p.windows) &&
            p.windows.every(
              w =>
                w &&
                typeof w.id === 'string' &&
                Number.isFinite(w.percent) &&
                ['session', 'weekly', 'other'].includes(w.kind) &&
                ['normal', 'warning', 'critical'].includes(w.severity),
            ),
        )
      ) {
        throw new Error('Respuesta de uso inválida');
      }
      return snapshot;
    },
    token,
    { timeoutMs: 30_000 },
  );
}

export function usageHeadline(snapshots: UsageSnapshot[]): UsageWindow | null {
  const windows = snapshots.flatMap(s =>
    s.providers.filter(p => p.status === 'ok').flatMap(p => p.windows),
  );
  return windows.reduce<UsageWindow | null>(
    (worst, window) =>
      !worst || window.percent > worst.percent ? window : worst,
    null,
  );
}
