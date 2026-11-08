import { z } from 'zod';

export const workflowModes = ['free', 'strict'] as const;
export type WorkflowMode = (typeof workflowModes)[number];

/** What the rest of the app reads from a status, whatever the board calls it. */
export const statusCategories = ['todo', 'in_progress', 'done'] as const;
export type StatusCategory = (typeof statusCategories)[number];

export const boardActors = ['user', 'agent', 'automation'] as const;
export type BoardActor = (typeof boardActors)[number];

const name = z.string().trim().min(1).max(80);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be a #rrggbb hex value');
const id = z.string().trim().min(1);

// Like the automation schemas, PATCH variants are built from fields WITHOUT
// defaults — `.partial()` would otherwise fill in every omitted key.
const statusFields = z.object({
  name,
  color,
  category: z.enum(statusCategories),
  wipLimit: z.number().int().min(1).nullable(),
  isInitial: z.boolean(),
});

export const statusInputSchema = statusFields.extend({
  color: color.optional(),
  category: z.enum(statusCategories).default('todo'),
  wipLimit: z.number().int().min(1).nullable().optional(),
  isInitial: z.boolean().optional(),
});

export const statusPatchSchema = statusFields.partial().refine(
  value => Object.keys(value).length > 0,
  'At least one field is required',
);

const boardFields = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).nullable(),
  workflowMode: z.enum(workflowModes),
});

export const boardInputSchema = boardFields.extend({
  description: z.string().trim().min(1).nullable().optional(),
  workflowMode: z.enum(workflowModes).default('free'),
  /** Columns in display order; the first is initial unless another says so. Defaults to To Do / In Progress / Done. */
  statuses: z.array(statusInputSchema).min(1).optional(),
});

export const boardPatchSchema = boardFields.partial().refine(
  value => Object.keys(value).length > 0,
  'At least one field is required',
);

export const statusOrderSchema = z.object({ statusIds: z.array(id).min(1) });

export const transitionInputSchema = z.object({
  /** null = from any status. */
  fromStatusId: id.nullable(),
  toStatusId: id,
  name: z.string().trim().min(1).max(80).nullable().optional(),
});

/** Target status by id, or by name (case-insensitive) — the form an agent knows. */
const statusTarget = {
  statusId: id.optional(),
  status: z.string().trim().min(1).optional(),
};

export const addSessionSchema = z.object({
  sessionId: id,
  ...statusTarget,
  position: z.number().optional(),
  actor: z.enum(boardActors).default('user'),
});

export const moveSessionSchema = z.object({
  ...statusTarget,
  position: z.number().optional(),
  actor: z.enum(boardActors).default('user'),
}).refine(value => !!value.statusId || !!value.status, 'statusId or status is required');

/**
 * Set a session's status by session id alone — for external pollers that only
 * know the session and the status name. `boardId` is only read when the session
 * is not on a board yet, to put it there.
 */
export const setSessionStatusSchema = z.object({
  ...statusTarget,
  boardId: id.optional(),
  actor: z.enum(boardActors).default('automation'),
}).refine(value => !!value.statusId || !!value.status, 'statusId or status is required');

export type BoardInput = z.infer<typeof boardInputSchema>;
export type BoardPatch = z.infer<typeof boardPatchSchema>;
export type StatusInput = z.infer<typeof statusInputSchema>;
export type StatusPatch = z.infer<typeof statusPatchSchema>;
export type TransitionInput = z.infer<typeof transitionInputSchema>;
export type AddSessionInput = z.infer<typeof addSessionSchema>;
export type MoveSessionInput = z.infer<typeof moveSessionSchema>;
export type SetSessionStatusInput = z.infer<typeof setSessionStatusSchema>;

/** Rule violations carry the HTTP status the handler should answer with. */
export class BoardError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
  }
}
