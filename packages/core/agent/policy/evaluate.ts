/**
 * The policy evaluator installed with `setPolicyEvaluator`.
 *
 * It only has an opinion about the agent session: every other session keeps
 * the bridge's permission-mode behaviour exactly as before. Interaction tools
 * (AskUserQuestion, plan approval) are never decided here — their whole point
 * is to reach the owner.
 *
 * 'preview' is pure (the bridge labels tool cards with it); 'decide' records
 * the decision in the activity log.
 */

import { homedir } from 'os';
import { CODIBY_DIR, PORT, touchesProtectedPath, USER_INTERACTION_TOOLS } from '../../config/config';
import { sessions } from '../../session/sessions';
import { getSessionState } from '../../session/state';
import type { Session } from '../../types';
import { loadAgentConfig } from '../config';
import { AGENT_SESSION_ID } from '../session';
import type { PolicyRequest, PolicyVerdict } from '../types';
import { recordDecision, recordToolUse } from './activity';
import { browserLookup } from './browser-context';
import { calendarLookup } from './calendar-context';
import { peopleLookup } from './people-context';
import { classifyToolCall, type Classification, type ClassifyContext } from './classify';
import { decide, listRules, type RuleMatch } from './rules';

export function classifyContext(sessionId = AGENT_SESSION_ID): ClassifyContext {
  const cfg = loadAgentConfig();
  return {
    workspaceDir: cfg.workspaceDir,
    home: homedir(),
    codibyDir: CODIBY_DIR,
    bridgePort: PORT,
    owner: cfg.owner,
    browser: browserLookup(sessionId),
    calendar: calendarLookup(sessionId),
    people: peopleLookup,
    sessionMode: id => sessions.get(id)?.permissionMode ?? null,
  };
}

export interface Evaluation {
  cls: Classification;
  /** Null for interaction tools: those always go to the owner. */
  match: RuleMatch | null;
}

/** Classify and match without side effects. */
export function evaluateToolCall(toolName: string, input: unknown, ctx: ClassifyContext = classifyContext()): Evaluation {
  const cls = classifyToolCall(toolName, input, ctx);
  if (cls.category === 'interaction' || USER_INTERACTION_TOOLS.has(toolName)) return { cls, match: null };
  return { cls, match: decide(listRules(), toolName, cls) };
}

const usesExactIds = (session: Session) => (session.provider || 'claude') === 'claude';

export function agentPolicyEvaluator(req: PolicyRequest): PolicyVerdict | null {
  if (req.session.id !== AGENT_SESSION_ID) return null;
  const { cls, match } = evaluateToolCall(req.toolName, req.input);
  if (!match) return null;
  if (req.phase === 'decide') {
    recordDecision({
      sessionId: req.session.id,
      requestId: req.requestId,
      toolName: req.toolName,
      input: req.input,
      cls,
      match,
      exactIds: usesExactIds(req.session),
    });
  }
  return { action: match.action, reason: match.reason, ruleId: match.rule?.id, category: cls.category };
}

/**
 * onAgentToolUse listener. The bridge passes only a summary, so the call's id
 * and full input are read back from the transcript entry it just added.
 */
const seenToolUses = new Set<string>();

export function handleAgentToolUse(sessionId: string, toolName: string, summary: string): void {
  if (sessionId !== AGENT_SESSION_ID) return;
  const msgs = getSessionState(sessionId).messages;
  let toolUseId: string | undefined;
  let input: unknown = undefined;
  for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 50); i--) {
    const m = msgs[i]!;
    if (m.toolName !== toolName || m.isToolResult) continue;
    // The newest entry for this tool is the call being announced; if we've
    // logged it already this is a re-emission (provider replay), not a new call.
    if (seenToolUses.has(m.id)) return;
    toolUseId = m.id;
    input = m.toolInput;
    break;
  }
  if (toolUseId) {
    seenToolUses.add(toolUseId);
    if (seenToolUses.size > 1000) seenToolUses.delete(seenToolUses.values().next().value!);
  }
  if (input === undefined) input = inputFromSummary(toolName, summary);
  const { cls, match } = evaluateToolCall(toolName, input);
  if (cls.category === 'interaction') return;
  const session = sessions.get(sessionId);
  recordToolUse({
    sessionId,
    toolName,
    toolUseId,
    input,
    cls,
    preview: match,
    protectedPath: touchesProtectedPath(input),
    exactIds: session ? usesExactIds(session) : true,
  });
}

/** Best-effort input when the transcript entry can't be found (mirrors bridge.summariseToolInput). */
function inputFromSummary(toolName: string, summary: string): Record<string, unknown> {
  switch (toolName) {
    case 'Bash': return { command: summary };
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': return { file_path: summary };
    case 'Grep': case 'Glob': return { pattern: summary };
    case 'WebFetch': return { url: summary };
    case 'WebSearch': return { query: summary };
    default:
      try {
        const parsed = JSON.parse(summary);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
  }
}
