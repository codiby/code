import { z } from 'zod';

const nullableString = z.string().trim().min(1).nullable().optional();

export const automationInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: nullableString,
  cronExpression: z.string().trim().min(1),
  timezone: z.string().trim().min(1).default('UTC'),
  enabled: z.boolean().default(true),
  prompt: z.string().trim().min(1),
  cwd: z.string().trim().min(1),
  provider: z.string().trim().min(1).default('claude'),
  model: nullableString,
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']).default('default'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
  concurrencyPolicy: z.literal('skip').default('skip'),
  maxRuntimeMs: z.number().int().min(1_000).max(86_400_000).nullable().optional(),
});

export const automationPatchSchema = automationInputSchema.partial().refine(
  value => Object.keys(value).length > 0,
  'At least one field is required',
);

export type AutomationInput = z.infer<typeof automationInputSchema>;
export type AutomationPatch = z.infer<typeof automationPatchSchema>;
export type AutomationRunStatus = 'scheduled' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'skipped';
export type AutomationRunTrigger = 'scheduled' | 'manual';
