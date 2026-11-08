import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const sessionNotes = sqliteTable('session_notes', {
  sessionId: text('session_id').primaryKey(),
  content: text('content').notNull(),
  revision: integer('revision').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const automations = sqliteTable('automations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  /** How the automation fires: 'cron' (the scheduler) or 'webhook' (an HTTP call). */
  triggerType: text('trigger_type').notNull().default('cron'),
  /** Null for webhook automations, which have no schedule of their own. */
  cronExpression: text('cron_expression'),
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

// ---------------------------------------------------------------------------
// Boards — Jira-style boards whose cards are sessions. Each board defines its
// own statuses (columns) and, in `strict` mode, which moves between them are
// allowed. A session sits on at most one board at a time.
// ---------------------------------------------------------------------------

export const boards = sqliteTable('boards', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  /** 'free' — any move is allowed; 'strict' — only moves in board_transitions. */
  workflowMode: text('workflow_mode').notNull().default('free'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
});

/**
 * A column. `category` is what the rest of the app reads ("is this done?"),
 * so each board can name its statuses freely. Exactly one per board is
 * `isInitial` — where sessions land when they join the board.
 */
export const boardStatuses = sqliteTable('board_statuses', {
  id: text('id').primaryKey(),
  boardId: text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull(),
  category: text('category').notNull(),
  position: integer('position').notNull(),
  isInitial: integer('is_initial', { mode: 'boolean' }).notNull().default(false),
  /** Soft limit: exceeding it is reported, never blocked. */
  wipLimit: integer('wip_limit'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [
  uniqueIndex('board_statuses_board_name_idx').on(table.boardId, table.name),
  index('board_statuses_board_position_idx').on(table.boardId, table.position),
]);

/** An allowed move in a `strict` board. A null `fromStatusId` means "from any status". */
export const boardTransitions = sqliteTable('board_transitions', {
  id: text('id').primaryKey(),
  boardId: text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  fromStatusId: text('from_status_id').references(() => boardStatuses.id, { onDelete: 'cascade' }),
  toStatusId: text('to_status_id').notNull().references(() => boardStatuses.id, { onDelete: 'cascade' }),
  name: text('name'),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  uniqueIndex('board_transitions_move_idx').on(table.boardId, table.fromStatusId, table.toStatusId),
]);

/**
 * Where a session sits. `sessionId` is the primary key, which is what keeps a
 * session on a single board. No FK to sessions: they live on disk, not here.
 * `position` is fractional so a drag rewrites one row, not the whole column.
 */
export const boardSessions = sqliteTable('board_sessions', {
  sessionId: text('session_id').primaryKey(),
  boardId: text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  statusId: text('status_id').notNull().references(() => boardStatuses.id),
  position: real('position').notNull(),
  addedAt: integer('added_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [
  index('board_sessions_board_status_idx').on(table.boardId, table.statusId, table.position),
]);

/** Append-only move history. No FKs, so it outlives deleted statuses and boards. */
export const boardSessionEvents = sqliteTable('board_session_events', {
  id: text('id').primaryKey(),
  boardId: text('board_id').notNull(),
  sessionId: text('session_id').notNull(),
  fromStatusId: text('from_status_id'),
  toStatusId: text('to_status_id'),
  actor: text('actor').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('board_session_events_session_idx').on(table.sessionId, table.createdAt),
]);

export type AutomationRecord = typeof automations.$inferSelect;
export type AutomationRunRecord = typeof automationRuns.$inferSelect;
export type SessionTargetRecord = typeof sessionTargets.$inferSelect;
export type RequirementRecord = typeof sessionRequirements.$inferSelect;
export type RequirementProposalRecord = typeof requirementProposals.$inferSelect;
export type RequirementEventRecord = typeof requirementEvents.$inferSelect;
export type BoardRecord = typeof boards.$inferSelect;
export type BoardStatusRecord = typeof boardStatuses.$inferSelect;
export type BoardTransitionRecord = typeof boardTransitions.$inferSelect;
export type BoardSessionRecord = typeof boardSessions.$inferSelect;
export type BoardSessionEventRecord = typeof boardSessionEvents.$inferSelect;

// ---------------------------------------------------------------------------
// Inbox — things outside a session that wait on the user (Slack mentions and
// DMs, pull requests). Session items are derived live in the frontend and
// never stored here. `id` is the source's own key (e.g. `slack:<ch>:<ts>`), so
// a backfill that sees an item the realtime feed already delivered is a no-op.
// ---------------------------------------------------------------------------

export const inboxItems = sqliteTable('inbox_items', {
  id: text('id').primaryKey(),
  /** 'slack' | 'pr' */
  source: text('source').notNull(),
  /** slack: 'mention' | 'dm' | 'thread_reply' — pr: 'review_requested' | 'checks_failing' */
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  /** Source-specific fields (channel, thread ts, author, repo…), JSON. */
  context: text('context').notNull().default('{}'),
  url: text('url'),
  /** When it happened at the source. */
  occurredAt: integer('occurred_at').notNull(),
  createdAt: integer('created_at').notNull(),
  readAt: integer('read_at'),
  doneAt: integer('done_at'),
}, (table) => [
  index('inbox_items_open_idx').on(table.doneAt, table.occurredAt),
]);

export type InboxItemRecord = typeof inboxItems.$inferSelect;
