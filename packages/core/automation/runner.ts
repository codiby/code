import type { AutomationRecord, AutomationRunRecord } from '../database/schema';
import { handleCreateSession } from '../handlers/sessions';
import { log, logError } from '../lib/logger';
import type { TurnCompleteInfo } from '../provider/types';
import { sessions } from '../session/sessions';
import { getSessionState } from '../session/state';
import {
  createRun,
  finishRun,
  finishRunBySession,
  getActiveRunBySession,
  getRun,
  hasActiveRun,
  startRun,
} from './repository';
import type { AutomationRunTrigger } from './types';

type RunnerDeps = {
  port: number;
  sendMessage: (sessionId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  broadcastSessionList: () => void;
};

let deps: RunnerDeps | null = null;
const timeoutHandles = new Map<string, ReturnType<typeof setTimeout>>();

export function configureAutomationRunner(nextDeps: RunnerDeps): void {
  deps = nextDeps;
}

export async function runAutomation(
  automation: AutomationRecord,
  trigger: AutomationRunTrigger,
  scheduledFor: number | null = null,
): Promise<AutomationRunRecord | null> {
  if (!deps) throw new Error('Automation runner is not configured');

  if (hasActiveRun(automation.id)) {
    return createRun(automation, trigger, scheduledFor, 'skipped');
  }

  const run = createRun(automation, trigger, scheduledFor);
  if (!run) return null;

  const request = new Request(`http://localhost:${deps.port}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `${automation.name} - ${new Date().toISOString()}`,
      cwd: automation.cwd,
      provider: automation.provider,
      model: automation.model,
      permissionMode: automation.permissionMode,
      effort: automation.effort,
    }),
  });

  try {
    const response = await handleCreateSession(request, deps.port);
    if (!response.ok) throw new Error(`Session creation failed (${response.status})`);
    const created = await response.json() as { id: string };
    startRun(run.id, created.id);
    deps.broadcastSessionList();

    if (automation.maxRuntimeMs) {
      const handle = setTimeout(() => void timeoutRun(run.id, created.id), automation.maxRuntimeMs);
      timeoutHandles.set(run.id, handle);
    }

    const sent = await deps.sendMessage(created.id, automation.prompt);
    if (!sent.ok) {
      clearRunTimeout(run.id);
      finishRun(run.id, 'failed', sent.error || 'Failed to send automation prompt');
    }
    return getRun(automation.id, run.id);
  } catch (error) {
    clearRunTimeout(run.id);
    finishRun(run.id, 'failed', error instanceof Error ? error.message : String(error));
    logError(`[automation:${automation.id}] ${error}`);
    return getRun(automation.id, run.id);
  }
}

export function completeAutomationRun(sessionId: string, info: TurnCompleteInfo): void {
  const run = getActiveRunBySession(sessionId);
  if (!run) return;
  const fallbackResult = [...getSessionState(sessionId).messages].reverse().find(message =>
    message.role === 'assistant' &&
    !message.toolName &&
    !message.isToolResult &&
    !message.isThinking &&
    message.timestamp >= (run.startedAt ?? run.createdAt),
  )?.content;
  const completedInfo = { ...info, resultText: info.resultText || fallbackResult };
  clearRunTimeout(run.id);
  const failed = info.stopReason === 'error' || info.stopReason === 'interrupted';
  finishRunBySession(sessionId, failed ? 'failed' : 'succeeded', completedInfo);
  log(`[automation:${run.automationId}] Run ${run.id} completed`);
}

export function failAutomationRun(sessionId: string, error: string): void {
  const run = getActiveRunBySession(sessionId);
  if (!run) return;
  clearRunTimeout(run.id);
  finishRunBySession(sessionId, 'failed', { error });
}

export async function cancelAutomationRun(automationId: string, runId: string): Promise<boolean> {
  const run = getRun(automationId, runId);
  if (!run || !['scheduled', 'running'].includes(run.status)) return false;
  clearRunTimeout(run.id);
  finishRun(run.id, 'cancelled', 'Cancelled by user');
  if (run.sessionId) {
    try { await sessions.get(run.sessionId)?.providerSession?.close(); } catch {}
  }
  return true;
}

function clearRunTimeout(runId: string): void {
  const handle = timeoutHandles.get(runId);
  if (handle) clearTimeout(handle);
  timeoutHandles.delete(runId);
}

async function timeoutRun(runId: string, sessionId: string): Promise<void> {
  timeoutHandles.delete(runId);
  const finished = finishRun(runId, 'timed_out', 'Automation exceeded its maximum runtime');
  if (!finished) return;
  try { await sessions.get(sessionId)?.providerSession?.close(); } catch {}
}
