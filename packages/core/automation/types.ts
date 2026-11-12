import { z } from 'zod';

const nullableString = z.string().trim().min(1).nullable().optional();

/**
 * How an automation fires:
 *   - `cron`    — the scheduler owns it and computes `nextRunAt`.
 *   - `webhook` — nothing fires it on a timer; an HTTP POST to
 *                 /automations/:id/webhook starts a run.
 *   - `once`    — fires a single time at `runAt`, then disables itself (the row
 *                 stays for its history).
 */
export const automationTriggerTypes = ['cron', 'webhook', 'once'] as const;
export type AutomationTriggerType = (typeof automationTriggerTypes)[number];

/** An explicit UTC offset (`Z`, `+02:00`, `-0600`) at the end of an ISO-8601 stamp. */
const ISO_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Epoch millis from an ISO-8601 string that names its offset, or null.
 * A bare local time is refused: the bridge may run in another zone than the
 * person who wrote it, and guessing turns "09:00" into the wrong hour.
 */
export function parseInstant(value: string): number | null {
  const text = value.trim();
  if (!ISO_OFFSET.test(text)) return null;
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? ts : null;
}

/** `runAt`: epoch millis, or an ISO-8601 string with an offset. */
const runAtField = z.union([
  z.number().int().positive(),
  z.string().trim().min(1).transform((value, ctx) => {
    const ts = parseInstant(value);
    if (ts === null) {
      ctx.addIssue({ code: 'custom', message: 'runAt must be epoch millis or ISO-8601 with an offset, e.g. 2026-11-12T09:00:00-06:00' });
      return z.NEVER;
    }
    return ts;
  }),
]).nullable().optional();

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
  // Optional at the field level; the refines below enforce it per trigger, so
  // webhook and one-shot automations can omit it entirely.
  cronExpression: nullableString,
  /** One-shot automations: when to fire. */
  runAt: runAtField,
  timezone: z.string().trim().min(1),
  enabled: z.boolean(),
  prompt: z.string().trim().min(1),
  /**
   * Run inside this existing session instead of spawning a new one. The
   * session keeps its own folder, provider, model, permission mode and effort,
   * so those fields are ignored for a targeted automation.
   */
  targetSessionId: nullableString,
  cwd: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  model: nullableString,
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
  concurrencyPolicy: z.literal('skip'),
  maxRuntimeMs: z.number().int().min(1_000).max(86_400_000).nullable().optional(),
});

/**
 * A cron automation without an expression (or a one-shot one without a time)
 * would never fire and never error, so creation refuses both. The folder is
 * only optional when the run happens in a target session that has its own.
 */
export const automationInputSchema = automationFields.extend({
  triggerType: z.enum(automationTriggerTypes).default('cron'),
  timezone: z.string().trim().min(1).default('UTC'),
  enabled: z.boolean().default(true),
  cwd: z.string().trim().min(1).optional(),
  provider: z.string().trim().min(1).default('claude'),
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']).default('default'),
  concurrencyPolicy: z.literal('skip').default('skip'),
}).refine(
  value => value.triggerType !== 'cron' || !!value.cronExpression,
  { message: 'cronExpression is required for cron automations', path: ['cronExpression'] },
).refine(
  value => value.triggerType !== 'once' || !!value.runAt,
  { message: 'runAt is required for one-shot automations', path: ['runAt'] },
).refine(
  value => !!value.cwd || !!value.targetSessionId,
  { message: 'cwd is required unless the automation runs in a targetSessionId', path: ['cwd'] },
);

// PATCH carries only what the caller sent; whether the *merged* record still has
// a cron expression or a run time depends on the stored row, so that check
// lives in the handler.
export const automationPatchSchema = automationFields.partial().refine(
  value => Object.keys(value).length > 0,
  'At least one field is required',
);

export type AutomationInput = z.infer<typeof automationInputSchema>;
/** What the repository stores: the folder is resolved (from the target session when omitted). */
export type AutomationCreate = Omit<AutomationInput, 'cwd'> & { cwd: string };
export type AutomationPatch = z.infer<typeof automationPatchSchema>;
export type AutomationRunStatus = 'scheduled' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'skipped';
export type AutomationRunTrigger = 'scheduled' | 'manual' | 'webhook';
