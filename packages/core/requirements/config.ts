/**
 * Tunables for requirements + loop, read from `ui-preferences.json` with a
 * per-tab-group override. Everything has a safe default so a missing prefs
 * file never leaves the loop unbounded.
 */

import { loadPreferences } from '../session/storage';
import { sessionGroupChain } from '../config/group-chain';
import { DEFAULT_COMMAND_TIMEOUT_MS } from './types';

export type RequirementsConfig = {
  judgeModel: string;
  commandTimeoutMs: number;
  autoCapture: boolean;
};

export type LoopConfig = {
  maxIterations: number;
  maxCostUsd: number;
  maxRuntimeMs: number;
  /** Identical failing set N times in a row with no file changes → pause. */
  stallThreshold: number;
};

const REQUIREMENTS_DEFAULTS: RequirementsConfig = {
  judgeModel: 'claude-sonnet-5',
  commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  autoCapture: true,
};

const LOOP_DEFAULTS: LoopConfig = {
  maxIterations: 25,
  maxCostUsd: 10,
  maxRuntimeMs: 3_600_000,
  stallThreshold: 3,
};

function sectionFor(sessionId: string, key: 'requirements' | 'loop'): Record<string, unknown> {
  let prefs: Record<string, unknown>;
  try {
    prefs = loadPreferences();
  } catch {
    return {};
  }
  const global = (prefs[key] as Record<string, unknown> | undefined) ?? {};
  const map = (prefs.tabGroupMap as Record<string, string> | undefined) ?? {};
  const groups = (prefs.tabGroups as Record<string, Record<string, unknown> & { parentId?: string | null }> | undefined) ?? {};
  // Groups nest, so layer every ancestor's section root-first — the closest
  // group wins, and anything it leaves unset falls back up the chain.
  const chain = sessionGroupChain(groups, map, sessionId).slice().reverse();
  let out = { ...global };
  for (const group of chain) {
    const section = group[key] as Record<string, unknown> | undefined;
    if (section) out = { ...out, ...section };
  }
  return out;
}

function pickNumber(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function requirementsConfig(sessionId: string): RequirementsConfig {
  const section = sectionFor(sessionId, 'requirements');
  return {
    judgeModel: typeof section.judgeModel === 'string' && section.judgeModel.trim()
      ? section.judgeModel.trim()
      : REQUIREMENTS_DEFAULTS.judgeModel,
    commandTimeoutMs: pickNumber(section.commandTimeoutMs, REQUIREMENTS_DEFAULTS.commandTimeoutMs),
    autoCapture: typeof section.autoCapture === 'boolean' ? section.autoCapture : REQUIREMENTS_DEFAULTS.autoCapture,
  };
}

export function loopConfig(sessionId: string): LoopConfig {
  const section = sectionFor(sessionId, 'loop');
  return {
    maxIterations: pickNumber(section.maxIterations, LOOP_DEFAULTS.maxIterations),
    maxCostUsd: pickNumber(section.maxCostUsd, LOOP_DEFAULTS.maxCostUsd),
    maxRuntimeMs: pickNumber(section.maxRuntimeMs, LOOP_DEFAULTS.maxRuntimeMs),
    stallThreshold: pickNumber(section.stallThreshold, LOOP_DEFAULTS.stallThreshold),
  };
}
