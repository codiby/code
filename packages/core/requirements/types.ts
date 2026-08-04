import { z } from 'zod';

/**
 * Lifecycle of a requirement.
 *   draft    — the agent just created it and can still edit or drop it.
 *   locked   — the user approved it. The agent may only propose changes.
 *   waived   — the user accepted an excuse. Stays visible, never counts as a pass.
 *   tampered — the signature chain doesn't verify. Counts as failing.
 */
export type RequirementState = 'draft' | 'locked' | 'waived' | 'tampered';

/** Result of the last run. Written by the runner only. */
export type RequirementStatus = 'pending' | 'running' | 'passing' | 'failing';

export type RequirementKind = 'command' | 'visual';
export type ProposalAction = 'edit' | 'delete' | 'waive';
export type ProposalStatus = 'pending' | 'approved' | 'rejected';
export type RequirementActor = 'agent' | 'user' | 'runner';

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_CHARS = 2_000;

export const commandCheckSchema = z.object({
  type: z.literal('command'),
  command: z.string().trim().min(1).max(2_000),
  timeoutMs: z.number().int().min(1_000).max(900_000).optional(),
});

export const visualCheckSchema = z.object({
  type: z.literal('visual'),
  prompt: z.string().trim().min(1).max(2_000),
  /** Absolute path to a PNG/JPEG, or a raw base64 payload. */
  image: z.string().trim().min(1),
  capture: z.object({
    browser: z.string().trim().min(1).optional(),
    url: z.url().optional(),
  }).optional(),
});

export const checkSchema = z.discriminatedUnion('type', [commandCheckSchema, visualCheckSchema]);

export const requirementInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  check: checkSchema,
});

export const requirementPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  check: checkSchema.optional(),
}).refine(v => Object.keys(v).length > 0, 'At least one field is required');

export const targetSchema = z.object({
  target: z.string().trim().min(1).max(2_000),
});

export const proposalInputSchema = z.object({
  action: z.enum(['edit', 'delete', 'waive']),
  reason: z.string().trim().min(1).max(1_000),
  payload: requirementPatchSchema.optional(),
});

export type CommandCheck = z.infer<typeof commandCheckSchema>;
export type VisualCheck = z.infer<typeof visualCheckSchema>;
export type RequirementCheck = z.infer<typeof checkSchema>;
export type RequirementInput = z.infer<typeof requirementInputSchema>;
export type RequirementPatch = z.infer<typeof requirementPatchSchema>;
export type ProposalInput = z.infer<typeof proposalInputSchema>;

/** Server-computed progress. The denominator is always the real one. */
export type RequirementProgress = {
  total: number;
  locked: number;
  draft: number;
  waived: number;
  tampered: number;
  passing: number;
  failing: number;
  pending: number;
  pendingProposals: number;
  /** True when there is at least one locked requirement and all of them pass. */
  complete: boolean;
};

/**
 * Shell commands that would make a requirement pass without proving anything.
 * Surfaced as a warning at approval time — the user is the only gate here, so
 * the least we can do is make the degenerate cases loud.
 */
const DEGENERATE_COMMANDS = [
  /^true$/i,
  /^:\s*$/,
  /^exit\s+0$/i,
  // A bare echo and nothing else. Anything chained after it (`;`, `&&`, `||`,
  // a newline) can still fail, so those are left alone — flagging them would
  // train the user to ignore the warning.
  /^echo\b[^;&|\n]*$/i,
  /\|\|\s*true\s*$/i,
  /\|\|\s*exit\s+0\s*$/i,
];

/** User-facing copy: this is rendered verbatim in the Requirements panel. */
export function degenerateCheckWarning(
  kind: RequirementKind,
  command: string | null,
  judgePrompt: string | null,
): string | null {
  if (kind === 'command') {
    const cmd = (command || '').trim();
    if (!cmd) return 'Comando vacío — nunca puede fallar.';
    if (DEGENERATE_COMMANDS.some(re => re.test(cmd))) {
      return 'Este comando siempre sale con 0, así que el requerimiento nunca puede fallar.';
    }
    return null;
  }
  const prompt = (judgePrompt || '').trim();
  if (prompt.length < 20) return 'El prompt del juez es demasiado vago para calificar algo verificable.';
  return null;
}
