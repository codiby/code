/**
 * Policy settings — `~/.codiby/agent/policy.json`.
 *
 * Kept apart from the rules (which live in `agent_rules`) because these are
 * knobs of the approval flow itself, not decisions about tools.
 */

import { agentDataDir, createJsonStore } from '../store';

export interface PolicySettings {
  /**
   * Fan approvals of every session (not only the agent's) out to the owner's
   * channels. On by default: it is how "approve from Telegram" already works
   * for coding sessions.
   */
  approvalsForAllSessions: boolean;
  /** Agent-session approvals auto-deny after this many minutes without an answer. */
  approvalTimeoutMinutes: number;
  /** Activity rows older than this are pruned. */
  activityRetentionDays: number;
}

export const POLICY_DEFAULTS: PolicySettings = {
  approvalsForAllSessions: true,
  approvalTimeoutMinutes: 15,
  activityRetentionDays: 30,
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizePolicySettings(raw: unknown): PolicySettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    approvalsForAllSessions: typeof r.approvalsForAllSessions === 'boolean' ? r.approvalsForAllSessions : POLICY_DEFAULTS.approvalsForAllSessions,
    approvalTimeoutMinutes: clampInt(r.approvalTimeoutMinutes, 1, 24 * 60, POLICY_DEFAULTS.approvalTimeoutMinutes),
    activityRetentionDays: clampInt(r.activityRetentionDays, 1, 365, POLICY_DEFAULTS.activityRetentionDays),
  };
}

const store = createJsonStore<PolicySettings>({ file: agentDataDir('policy.json'), normalize: normalizePolicySettings });

export function loadPolicySettings(): PolicySettings {
  return store.get();
}

/** Only known keys are applied; values are clamped by `normalizePolicySettings`. */
export function patchPolicySettings(patch: Record<string, unknown>): PolicySettings {
  return store.update(current => {
    const next: Record<string, unknown> = { ...current };
    for (const key of Object.keys(POLICY_DEFAULTS) as (keyof PolicySettings)[]) {
      if (key in patch) next[key] = patch[key];
    }
    return next as unknown as PolicySettings;
  });
}

/** Tests only. */
export function _reloadPolicySettings(): PolicySettings {
  return store.reload();
}
