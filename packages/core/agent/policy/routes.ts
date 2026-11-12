/**
 * HTTP routes for rules, activity, approvals and policy settings. All of
 * them sit behind the bridge's normal auth (none is public).
 */

import { HttpError, json, readBody } from '../http';
import { registerRoutes } from '../registry';
import { AGENT_SESSION_ID } from '../session';
import type { AgentRoute } from '../types';
import { ACTIVITY_DECISIONS, listActivity } from './activity';
import {
  answerPendingApproval,
  createAlwaysAllowRule,
  getPendingApproval,
  listPendingApprovals,
  type PendingApproval,
} from './approvals';
import { RULE_CATEGORIES } from './classify';
import { evaluateToolCall } from './evaluate';
import {
  createRule,
  deleteRule,
  ensureDefaultRules,
  listRules,
  resetDefaultRules,
  RULE_ACTIONS,
  updateRule,
  type Rule,
  type RuleInput,
} from './rules';
import { loadPolicySettings, patchPolicySettings } from './settings';

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function rulesPayload(): { rules: Rule[]; categories: typeof RULE_CATEGORIES; actions: typeof RULE_ACTIONS } {
  return { rules: listRules(), categories: RULE_CATEGORIES, actions: RULE_ACTIONS };
}

function seedQuietly() {
  try { ensureDefaultRules(); } catch { /* listRules falls back to the in-code defaults */ }
}

function approvalView(a: PendingApproval) {
  return {
    requestId: a.requestId,
    code: a.code,
    toolName: a.toolName,
    title: a.title,
    summary: a.summary,
    category: a.category,
    qualifier: a.qualifier ?? null,
    target: a.target ?? null,
    sessionId: a.sessionId,
    sessionName: a.sessionName,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    canAlwaysAllow: a.pinnable && a.sessionId === AGENT_SESSION_ID && a.toolName !== 'AskUserQuestion' && a.toolName !== 'ExitPlanMode',
  };
}

function ruleInputFrom(body: Record<string, unknown>): RuleInput {
  const { toolGlob, pattern, category, action, note, priority, enabled } = body;
  return { toolGlob, pattern, category, action, note, priority, enabled };
}

function numberParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${name} must be a non-negative number`);
  return n;
}

export const policyRoutes: AgentRoute[] = [
  {
    method: 'GET',
    path: '/agent/rules',
    handler: () => {
      seedQuietly();
      return json(rulesPayload());
    },
  },
  {
    method: 'POST',
    path: '/agent/rules',
    handler: async (req) => {
      const body = await readBody(req);
      if (!isRecord(body)) throw new HttpError(400, 'Body must be a JSON object');
      return json(createRule(ruleInputFrom(body)), 201);
    },
  },
  {
    method: 'POST',
    path: '/agent/rules/reset-defaults',
    handler: () => {
      resetDefaultRules();
      return json(rulesPayload());
    },
  },
  {
    method: 'POST',
    path: '/agent/rules/test',
    handler: async (req) => {
      const body = await readBody(req);
      const toolName = isRecord(body) ? body.toolName : undefined;
      if (typeof toolName !== 'string' || !toolName.trim() || toolName.length > 200) throw new HttpError(400, 'toolName is required');
      const input = isRecord(body) ? body.input ?? {} : {};
      if (!isRecord(input)) throw new HttpError(400, 'input must be a JSON object');
      const { cls, match } = evaluateToolCall(toolName.trim(), input);
      return json({
        action: match?.action ?? null,
        reason: match ? match.reason : 'Always goes to the owner — never decided by rules',
        rule: match?.rule ?? null,
        category: cls.category,
        qualifier: cls.qualifier ?? null,
        summary: cls.summary,
        target: cls.target ?? null,
        reasons: cls.reasons,
      });
    },
  },
  {
    method: 'PATCH',
    path: '/agent/rules/:id',
    handler: async (req, params) => {
      const body = await readBody(req);
      if (!isRecord(body)) throw new HttpError(400, 'Body must be a JSON object');
      seedQuietly();
      return json(updateRule(params.id!, ruleInputFrom(body)));
    },
  },
  {
    method: 'DELETE',
    path: '/agent/rules/:id',
    handler: (_req, params) => {
      deleteRule(params.id!);
      return json({ ok: true });
    },
  },
  {
    method: 'GET',
    path: '/agent/activity',
    handler: (_req, _params, url) => {
      const decision = url.searchParams.get('decision') || undefined;
      if (decision && !(ACTIVITY_DECISIONS as readonly string[]).includes(decision)) throw new HttpError(400, `decision must be one of ${ACTIVITY_DECISIONS.join(', ')}`);
      const category = url.searchParams.get('category') || undefined;
      if (category && !/^[a-z_]{1,40}(:[a-z_]{1,40})?$/.test(category)) throw new HttpError(400, 'Invalid category');
      const items = listActivity({ limit: numberParam(url, 'limit'), before: numberParam(url, 'before'), category, decision });
      return json({ items });
    },
  },
  {
    method: 'GET',
    path: '/agent/approvals',
    handler: () => json({ approvals: listPendingApprovals().map(approvalView) }),
  },
  {
    method: 'POST',
    path: '/agent/approvals/:requestId',
    handler: async (req, params) => {
      const body = await readBody(req);
      if (!isRecord(body) || typeof body.allow !== 'boolean') throw new HttpError(400, 'allow (true/false) is required');
      const via = body.via === undefined ? 'app' : body.via;
      if (via !== 'app' && via !== 'push') throw new HttpError(400, "via must be 'app' or 'push'");
      const always = body.always === true;
      const entry = getPendingApproval(params.requestId!);
      if (always && body.allow && entry && !approvalView(entry).canAlwaysAllow) {
        throw new HttpError(400, entry.pinnable
          ? "Always allow only applies to the agent's own tool calls"
          : 'This call contains a secret or is too long to pin to a rule — approve it once instead');
      }
      const res = await answerPendingApproval({ requestId: params.requestId!, allow: body.allow, via });
      if (!res.ok) {
        // 409 only for a request that existed and is settled: a second phone, a
        // late tap. An id this bridge never saw (or forgot across a restart) is 404.
        const status = res.reason === 'question' || res.reason === 'invalid' ? 400 : res.reason === 'answered' ? 409 : 404;
        throw new HttpError(status, res.error ?? 'Approval not found');
      }
      // Only after the answer landed, so a stale request never leaves a rule behind.
      const rule = always && body.allow && entry ? createAlwaysAllowRule(entry) : null;
      return json({ ok: true, ruleId: rule?.id ?? null });
    },
  },
  {
    method: 'GET',
    path: '/agent/policy',
    handler: () => json(loadPolicySettings()),
  },
  {
    method: 'PUT',
    path: '/agent/policy',
    handler: async (req) => {
      const body = await readBody(req);
      if (!isRecord(body)) throw new HttpError(400, 'Body must be a JSON object');
      if ('approvalsForAllSessions' in body && typeof body.approvalsForAllSessions !== 'boolean') throw new HttpError(400, 'approvalsForAllSessions must be true or false');
      for (const k of ['approvalTimeoutMinutes', 'activityRetentionDays'] as const) {
        if (k in body && (typeof body[k] !== 'number' || !Number.isFinite(body[k]))) throw new HttpError(400, `${k} must be a number`);
      }
      return json(patchPolicySettings(body));
    },
  },
];

registerRoutes(policyRoutes);
