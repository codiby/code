/**
 * Memory settings (`~/.codiby/agent/memory.json`, edited from the Agent view)
 * and the rotation bookkeeping (`memory-state.json`, written only by the
 * bridge). Two files so a settings PUT can never clobber the timestamps the
 * daily rotation relies on.
 */

import { agentDataDir, createJsonStore } from '../store';

export interface MemorySettings {
  /** Start a fresh agent thread once a day, when the owner has been quiet for a while. */
  dailyRotation: {
    enabled: boolean;
    /** Local "HH:MM" in persona.timezone. */
    time: string;
  };
  /** Before any rotation, give the agent one turn to save what it learned. */
  consolidateOnRotate: boolean;
}

/**
 * done — the agent finished its consolidation turn · timeout — it didn't
 * within the limit (rotation went ahead) · failed — the message couldn't be
 * delivered or the turn died · nothing_new — no conversation since the last
 * rotation · disabled — turned off in settings · unavailable — no runtime yet.
 */
export type ConsolidationOutcome = 'done' | 'timeout' | 'failed' | 'nothing_new' | 'disabled' | 'unavailable';

export interface MemoryRuntimeState {
  /** Last time the agent thread was rotated, for any reason. */
  lastRotatedAt: number | null;
  /** The daily slot (epoch ms) already handled — rotated, or skipped because nothing was new. */
  lastDailySlot: number | null;
  lastConsolidation: ConsolidationRecord | null;
}

export interface ConsolidationRecord {
  at: number;
  reason: string;
  outcome: ConsolidationOutcome;
  /** Memories and people written during the consolidation turn. */
  saved: number;
}

export const DEFAULT_ROTATION_TIME = '04:00';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTime(v: unknown): v is string {
  return typeof v === 'string' && HHMM.test(v);
}

export function normalizeMemorySettings(raw: unknown): MemorySettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const daily = (r.dailyRotation && typeof r.dailyRotation === 'object' ? r.dailyRotation : {}) as Record<string, unknown>;
  return {
    dailyRotation: {
      enabled: typeof daily.enabled === 'boolean' ? daily.enabled : true,
      time: isValidTime(daily.time) ? daily.time : DEFAULT_ROTATION_TIME,
    },
    consolidateOnRotate: typeof r.consolidateOnRotate === 'boolean' ? r.consolidateOnRotate : true,
  };
}

const OUTCOMES = new Set<ConsolidationOutcome>(['done', 'timeout', 'failed', 'nothing_new', 'disabled', 'unavailable']);
const epoch = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

export function normalizeMemoryState(raw: unknown): MemoryRuntimeState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const last = (r.lastConsolidation && typeof r.lastConsolidation === 'object' ? r.lastConsolidation : null) as Record<string, unknown> | null;
  const at = epoch(last?.at);
  return {
    lastRotatedAt: epoch(r.lastRotatedAt),
    lastDailySlot: epoch(r.lastDailySlot),
    lastConsolidation: last && at && OUTCOMES.has(last.outcome as ConsolidationOutcome)
      ? {
          at,
          reason: typeof last.reason === 'string' ? last.reason.slice(0, 200) : '',
          outcome: last.outcome as ConsolidationOutcome,
          saved: typeof last.saved === 'number' && Number.isFinite(last.saved) && last.saved > 0 ? Math.trunc(last.saved) : 0,
        }
      : null,
  };
}

export const memorySettingsStore = createJsonStore<MemorySettings>({
  file: agentDataDir('memory.json'),
  normalize: normalizeMemorySettings,
});

export const memoryStateStore = createJsonStore<MemoryRuntimeState>({
  file: agentDataDir('memory-state.json'),
  normalize: normalizeMemoryState,
});

export function loadMemorySettings(): MemorySettings {
  return memorySettingsStore.get();
}

/** Partial update from PUT /agent/memory/settings; unknown keys are ignored. */
export function patchMemorySettings(patch: { dailyRotation?: { enabled?: unknown; time?: unknown }; consolidateOnRotate?: unknown }): MemorySettings {
  return memorySettingsStore.update(cur => ({
    dailyRotation: {
      enabled: typeof patch.dailyRotation?.enabled === 'boolean' ? patch.dailyRotation.enabled : cur.dailyRotation.enabled,
      time: isValidTime(patch.dailyRotation?.time) ? patch.dailyRotation.time : cur.dailyRotation.time,
    },
    consolidateOnRotate: typeof patch.consolidateOnRotate === 'boolean' ? patch.consolidateOnRotate : cur.consolidateOnRotate,
  }));
}
