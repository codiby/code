import { z } from 'zod';

const nullableString = z.string().trim().min(1).nullable().optional();

/**
 * How an automation fires:
 *   - `cron`    — the scheduler owns it and computes `nextRunAt`.
 *   - `webhook` — nothing fires it on a timer; an HTTP POST to
 *                 /automations/:id/webhook starts a run.
 */
export const automationTriggerTypes = ['cron', 'webhook'] as const;
export type AutomationTriggerType = (typeof automationTriggerTypes)[number];

/**
 * Every field, with NO defaults attached.
 *
 * This matters: `z.object({...}).partial()` makes keys optional but still
 * applies their `.default()`, so a PATCH built from a defaulted schema quietly
 * rewrites every field the caller left out. Patching only `{ enabled: false }`
 * used to reset timezone, provider and permissionMode along with it. Defaults
 * belong to creation alone, so they are layered on in `automationInputSchema`.
 */
const automationFields = z.object({
  name: z.string().trim().min(1).max(120),
  description: nullableString,
  triggerType: z.enum(automationTriggerTypes),
  // Optional at the field level; the refine below enforces it for cron
  // automations, so webhook automations can omit it entirely.
  cronExpression: nullableString,
  timezone: z.string().trim().min(1),
  enabled: z.boolean(),
  prompt: z.string().trim().min(1),
  cwd: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  model: nullableString,
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
  concurrencyPolicy: z.literal('skip'),
  maxRuntimeMs: z.number().int().min(1_000).max(86_400_000).nullable().optional(),
});

/** A cron automation without an expression would never fire and never error. */
export const automationInputSchema = automationFields.extend({
  triggerType: z.enum(automationTriggerTypes).default('cron'),
  timezone: z.string().trim().min(1).default('UTC'),
  enabled: z.boolean().default(true),
  provider: z.string().trim().min(1).default('claude'),
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']).default('default'),
  concurrencyPolicy: z.literal('skip').default('skip'),
}).refine(
  value => value.triggerType !== 'cron' || !!value.cronExpression,
  { message: 'cronExpression is required for cron automations', path: ['cronExpression'] },
);

// PATCH carries only what the caller sent; whether the *merged* record still has
// a cron expression depends on the stored row, so that check lives in the handler.
export const automationPatchSchema = automationFields.partial().refine(
  value => Object.keys(value).length > 0,
  'At least one field is required',
);

export type AutomationInput = z.infer<typeof automationInputSchema>;
export type AutomationPatch = z.infer<typeof automationPatchSchema>;
export type AutomationRunStatus = 'scheduled' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'skipped';
export type AutomationRunTrigger = 'scheduled' | 'manual' | 'webhook';
