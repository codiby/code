/**
 * Approvals and policies (workstream 3): tool classifier, rules, approval
 * fan-out, activity log.
 *
 * Imported for its side effects by agent/index.ts. The evaluator, approval
 * listener, answerer and routes register at import so they work even while
 * the agent is off on this host (coding sessions still get their approvals
 * fanned out once channels run); seeding and pruning wait for the agent's
 * start hook.
 */

import { log } from '../../lib/logger';
import {
  onAgentStart,
  onAgentStop,
  onAgentToolUse,
  onApproval,
  registerPromptSection,
  setApprovalAnswerer,
  setPolicyEvaluator,
} from '../registry';
import { pruneActivity } from './activity';
import { answerPendingApproval, handleApprovalRequested, handleApprovalResolved } from './approvals';
import { agentPolicyEvaluator, handleAgentToolUse } from './evaluate';
import { permissionsPromptSection } from './prompt';
import { ensureDefaultRules } from './rules';
import { loadPolicySettings } from './settings';
import './routes';

setPolicyEvaluator(agentPolicyEvaluator);
setApprovalAnswerer(answerPendingApproval);
onApproval({ onRequested: handleApprovalRequested, onResolved: handleApprovalResolved });
onAgentToolUse(handleAgentToolUse);
registerPromptSection(permissionsPromptSection);

const DAY_MS = 86_400_000;
let pruneTimer: ReturnType<typeof setInterval> | null = null;

function prune() {
  const removed = pruneActivity(loadPolicySettings().activityRetentionDays);
  if (removed) log(`[agent] pruned ${removed} old activity row(s)`);
}

onAgentStart('policy', () => {
  ensureDefaultRules();
  prune();
  if (!pruneTimer) {
    pruneTimer = setInterval(prune, DAY_MS);
    (pruneTimer as { unref?: () => void }).unref?.();
  }
});

onAgentStop('policy', () => {
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = null;
});

export { classifyToolCall } from './classify';
export { evaluateToolCall } from './evaluate';
export { listPendingApprovals } from './approvals';
