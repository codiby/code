/**
 * Typed client for the agent's policy routes: rules, the activity log,
 * pending approvals and approval settings (packages/core/agent/policy).
 */

import type { AgentApi } from './api';
import { CHANNEL_LABELS, type ChannelKind } from './channels';

export type RuleAction = 'allow' | 'ask' | 'deny';
export type RuleSource = 'default' | 'user' | 'always_allow';

export interface AgentRule {
  id: string;
  priority: number;
  toolGlob: string;
  pattern: string | null;
  category: string | null;
  action: RuleAction;
  note: string | null;
  source: RuleSource;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** Default deny rules that win over any allowing rule while enabled. */
  guardrail: boolean;
}

export interface RuleCategory {
  value: string;
  label: string;
}

export interface RulesPayload {
  rules: AgentRule[];
  categories: RuleCategory[];
  actions: RuleAction[];
}

export interface RuleDraft {
  toolGlob: string;
  category: string | null;
  pattern: string | null;
  action: RuleAction;
  priority: number;
  note: string | null;
}

export interface RuleTestResult {
  /** Null for tools that always go to the owner (questions, plan approval). */
  action: RuleAction | null;
  reason: string;
  rule: AgentRule | null;
  category: string;
  qualifier: string | null;
  summary: string;
  target: string | null;
  reasons: string[];
}

export type ActivityDecision = 'auto_allowed' | 'asked' | 'approved' | 'denied' | 'blocked' | 'expired';
export const ACTIVITY_DECISIONS: ActivityDecision[] = ['auto_allowed', 'asked', 'approved', 'denied', 'blocked', 'expired'];

export interface ActivityItem {
  id: string;
  sessionId: string;
  requestId: string | null;
  toolName: string;
  /** `category` or `category:qualifier`. */
  category: string;
  summary: string;
  /** Redacted, truncated JSON (may be cut mid-way). */
  input: string;
  decision: ActivityDecision;
  decidedVia: string | null;
  ruleId: string | null;
  reason: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface ActivityQuery {
  limit?: number;
  before?: number;
  category?: string;
  decision?: ActivityDecision;
}

export interface PendingApproval {
  requestId: string;
  code: string;
  toolName: string;
  title: string;
  summary: string;
  category: string;
  qualifier: string | null;
  target: string | null;
  sessionId: string;
  sessionName: string;
  createdAt: number;
  /** 0 = waits until answered. */
  expiresAt: number;
  canAlwaysAllow: boolean;
}

export interface PolicySettings {
  approvalsForAllSessions: boolean;
  approvalTimeoutMinutes: number;
  activityRetentionDays: number;
}

/** Coarse categories, for the Activity filter. */
export const ACTIVITY_CATEGORIES: { value: string; label: string }[] = [
  { value: 'read', label: 'Read' },
  { value: 'write', label: 'Write' },
  { value: 'shell', label: 'Shell' },
  { value: 'network', label: 'Network' },
  { value: 'send_external', label: 'Send to others' },
  { value: 'mail', label: 'Email' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'purchase', label: 'Purchase' },
  { value: 'credentials', label: 'Credentials' },
  { value: 'destructive', label: 'Destructive' },
  { value: 'interaction', label: 'Questions & plans' },
  { value: 'agent_internal', label: "Agent's own tools" },
  { value: 'other', label: 'Other' },
];

export const DECISION_LABELS: Record<ActivityDecision, string> = {
  auto_allowed: 'Auto-allowed',
  asked: 'Waiting',
  approved: 'Approved',
  denied: 'Denied',
  blocked: 'Blocked',
  expired: 'Expired',
};

/**
 * Where an answer came from, as a phrase for the Activity row — null when
 * the decision pill already says it ("Expired") or nobody was asked
 * (policy, provider).
 */
export function decidedViaText(via: string | null): string | null {
  if (!via || ['policy', 'provider', 'expired', 'cancelled'].includes(via)) return null;
  if (via === 'app' || via === 'desktop') return 'in the app';
  if (via === 'push') return 'from your phone';
  return `via ${CHANNEL_LABELS[via as ChannelKind] ?? via.replace(/_/g, ' ')}`;
}

/**
 * A rule's headline when the owner gave it no note: "Allow Bash calls
 * matching the pattern", "Block possible purchases". The row's detail line
 * still shows the exact tool, category and pattern.
 */
export function ruleTitle(rule: Pick<AgentRule, 'action' | 'toolGlob' | 'pattern' | 'note'>, categoryLabel: string | null): string {
  if (rule.note?.trim()) return rule.note.trim();
  const verb = { allow: 'Allow', ask: 'Ask before', deny: 'Block' }[rule.action];
  const tools = rule.toolGlob.split(',').map(t => shortToolName(t.trim())).filter(Boolean);
  const named = tools.length > 3 ? `${tools.slice(0, 2).join(', ')} and ${tools.length - 2} more` : tools.join(', ');
  const what = rule.toolGlob !== '*'
    ? `${named} calls`
    : categoryLabel
      ? categoryLabel.charAt(0).toLowerCase() + categoryLabel.slice(1)
      : 'every tool call';
  return `${verb} ${what}${rule.pattern ? ' matching the pattern' : ''}`;
}

export type ToolInputView =
  | { kind: 'fields'; fields: [string, string][] }
  | { kind: 'text'; text: string; truncated: boolean };

/**
 * A tool call's logged input as label/value pairs, so the Activity row reads
 * like a form instead of a JSON dump. The log keeps a truncated JSON string,
 * so input that no longer parses comes back as text, flagged when it was cut.
 */
export function toolInputView(raw: string): ToolInputView {
  const text = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'text', text, truncated: /^[{[]/.test(text) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'text', text: typeof parsed === 'string' ? parsed : text, truncated: false };
  }
  const show = (v: unknown): string => {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'string') return v;
    if (typeof v !== 'object') return String(v);
    if (Array.isArray(v) && v.every(x => x === null || typeof x !== 'object')) return v.map(x => String(x ?? '—')).join(', ');
    return JSON.stringify(v);
  };
  const fields = Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k.replace(/_/g, ' '), show(v)] as [string, string]);
  return fields.length ? { kind: 'fields', fields } : { kind: 'text', text: 'No input', truncated: false };
}

/** `mcp__codiby-code__gmail_send` → `gmail_send`. */
export function shortToolName(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  const rest = name.slice(5);
  const i = rest.indexOf('__');
  return i < 0 ? rest : rest.slice(i + 2);
}

const enc = encodeURIComponent;

export const agentPolicy = {
  rules: (api: AgentApi) => api.get<RulesPayload>('/agent/rules'),
  createRule: (api: AgentApi, draft: RuleDraft) => api.send<AgentRule>('POST', '/agent/rules', draft),
  updateRule: (api: AgentApi, id: string, patch: Partial<RuleDraft> & { enabled?: boolean }) => api.send<AgentRule>('PATCH', `/agent/rules/${enc(id)}`, patch),
  deleteRule: (api: AgentApi, id: string) => api.send<{ ok: true }>('DELETE', `/agent/rules/${enc(id)}`),
  resetDefaults: (api: AgentApi) => api.send<RulesPayload>('POST', '/agent/rules/reset-defaults'),
  testCall: (api: AgentApi, toolName: string, input: Record<string, unknown>) =>
    api.send<RuleTestResult>('POST', '/agent/rules/test', { toolName, input }),

  activity: (api: AgentApi, q: ActivityQuery = {}) => {
    const p = new URLSearchParams();
    if (q.limit) p.set('limit', String(q.limit));
    if (q.before) p.set('before', String(q.before));
    if (q.category) p.set('category', q.category);
    if (q.decision) p.set('decision', q.decision);
    return api.get<{ items: ActivityItem[] }>(`/agent/activity?${p}`);
  },

  approvals: (api: AgentApi) => api.get<{ approvals: PendingApproval[] }>('/agent/approvals'),
  answer: (api: AgentApi, requestId: string, body: { allow: boolean; always?: boolean }) =>
    api.send<{ ok: true; ruleId: string | null }>('POST', `/agent/approvals/${enc(requestId)}`, { ...body, via: 'app' }),

  settings: (api: AgentApi) => api.get<PolicySettings>('/agent/policy'),
  saveSettings: (api: AgentApi, patch: Partial<PolicySettings>) => api.send<PolicySettings>('PUT', '/agent/policy', patch),
};
