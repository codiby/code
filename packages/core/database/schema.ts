import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const automations = sqliteTable('automations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  cronExpression: text('cron_expression').notNull(),
  timezone: text('timezone').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  prompt: text('prompt').notNull(),
  cwd: text('cwd').notNull(),
  provider: text('provider').notNull(),
  model: text('model'),
  permissionMode: text('permission_mode').notNull(),
  effort: text('effort'),
  concurrencyPolicy: text('concurrency_policy').notNull().default('skip'),
  maxRuntimeMs: integer('max_runtime_ms'),
  nextRunAt: integer('next_run_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
}, (table) => [index('automations_enabled_next_run_idx').on(table.enabled, table.nextRunAt)]);

export const automationRuns = sqliteTable('automation_runs', {
  id: text('id').primaryKey(),
  automationId: text('automation_id').notNull(),
  automationName: text('automation_name').notNull(),
  sessionId: text('session_id'),
  trigger: text('trigger').notNull(),
  scheduledFor: integer('scheduled_for'),
  status: text('status').notNull(),
  startedAt: integer('started_at'),
  finishedAt: integer('finished_at'),
  durationMs: integer('duration_ms'),
  resultText: text('result_text'),
  error: text('error'),
  stopReason: text('stop_reason'),
  costUsd: real('cost_usd'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('automation_runs_automation_created_idx').on(table.automationId, table.createdAt),
  index('automation_runs_session_idx').on(table.sessionId),
  uniqueIndex('automation_runs_scheduled_once_idx').on(table.automationId, table.scheduledFor),
]);

// ---------------------------------------------------------------------------
// Session requirements — the verifiable acceptance criteria of a session.
// The agent declares them, the server verifies them, the user approves them.
// ---------------------------------------------------------------------------

/** One-line, user-readable description of what the session is trying to build. */
export const sessionTargets = sqliteTable('session_targets', {
  sessionId: text('session_id').primaryKey(),
  target: text('target').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * A single requirement. Two verification kinds:
 *   - `command` — shell command; exit 0 means it passes.
 *   - `visual`  — screenshot + prompt, graded by a separate one-shot judge.
 *
 * `signature` covers the *definition* (title, check, state, position) chained
 * through `prevHash`; `resultSignature` covers the *outcome* fields the runner
 * writes. Both are HMACs keyed by a file the session can't read, so editing
 * the sqlite file by hand is detectable — see requirements/signing.ts.
 */
export const sessionRequirements = sqliteTable('session_requirements', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  position: integer('position').notNull(),
  title: text('title').notNull(),
  kind: text('kind').notNull(),
  // kind = 'command'
  command: text('command'),
  timeoutMs: integer('timeout_ms'),
  // kind = 'visual'
  judgePrompt: text('judge_prompt'),
  imagePath: text('image_path'),
  captureBrowser: text('capture_browser'),
  captureUrl: text('capture_url'),
  // lifecycle
  state: text('state').notNull().default('draft'),
  status: text('status').notNull().default('pending'),
  waiverReason: text('waiver_reason'),
  // last run
  lastExitCode: integer('last_exit_code'),
  lastOutput: text('last_output'),
  lastVerdict: text('last_verdict'),
  lastImagePath: text('last_image_path'),
  lastRunAt: integer('last_run_at'),
  // tamper detection
  prevHash: text('prev_hash'),
  signature: text('signature').notNull(),
  resultSignature: text('result_signature'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [
  index('session_requirements_session_idx').on(table.sessionId, table.position),
]);

/**
 * A change the agent wants but cannot make itself (edit/delete/waive on a
 * locked requirement). Sits here until the user approves or rejects it.
 */
export const requirementProposals = sqliteTable('requirement_proposals', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  requirementId: text('requirement_id').notNull(),
  action: text('action').notNull(),
  payload: text('payload'),
  reason: text('reason').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: integer('created_at').notNull(),
  resolvedAt: integer('resolved_at'),
}, (table) => [
  index('requirement_proposals_session_idx').on(table.sessionId, table.status),
]);

/** Append-only audit trail. Never updated, never deleted. */
export const requirementEvents = sqliteTable('requirement_events', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  requirementId: text('requirement_id'),
  event: text('event').notNull(),
  actor: text('actor').notNull(),
  detail: text('detail'),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('requirement_events_session_idx').on(table.sessionId, table.createdAt),
]);

export type AutomationRecord = typeof automations.$inferSelect;
export type AutomationRunRecord = typeof automationRuns.$inferSelect;
export type SessionTargetRecord = typeof sessionTargets.$inferSelect;
export type RequirementRecord = typeof sessionRequirements.$inferSelect;
export type RequirementProposalRecord = typeof requirementProposals.$inferSelect;
export type RequirementEventRecord = typeof requirementEvents.$inferSelect;
