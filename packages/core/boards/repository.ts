import { randomUUID } from 'crypto';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { database } from '../database';
import {
  boardSessionEvents,
  boardSessions,
  boardStatuses,
  boardTransitions,
  boards,
  type BoardRecord,
  type BoardSessionEventRecord,
  type BoardSessionRecord,
  type BoardStatusRecord,
  type BoardTransitionRecord,
} from '../database/schema';
import {
  BoardError,
  type AddSessionInput,
  type BoardActor,
  type BoardInput,
  type BoardPatch,
  type MoveSessionInput,
  type SetSessionStatusInput,
  type StatusCategory,
  type StatusInput,
  type StatusPatch,
  type TransitionInput,
  type WorkflowMode,
} from './types';
import { canMove } from './workflow';

const DEFAULT_STATUSES: StatusInput[] = [
  { name: 'To Do', category: 'todo' },
  { name: 'In Progress', category: 'in_progress' },
  { name: 'Done', category: 'done' },
];

const CATEGORY_COLORS: Record<StatusCategory, string> = {
  todo: '#71717a',
  in_progress: '#3b82f6',
  done: '#22c55e',
};

export type BoardDetail = {
  board: BoardRecord;
  statuses: BoardStatusRecord[];
  transitions: BoardTransitionRecord[];
  sessions: BoardSessionRecord[];
};

export type PlacementResult = {
  placement: BoardSessionRecord;
  /** True when the target column now holds more sessions than its WIP limit. */
  overWipLimit: boolean;
};

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

const activeBoard = isNull(boards.deletedAt);

export function listBoards(): BoardRecord[] {
  return database.select().from(boards).where(activeBoard).orderBy(asc(boards.createdAt)).all();
}

export function getBoard(id: string): BoardRecord | null {
  return database.select().from(boards).where(and(eq(boards.id, id), activeBoard)).get() ?? null;
}

export function getBoardDetail(id: string): BoardDetail | null {
  const board = getBoard(id);
  if (!board) return null;
  return {
    board,
    statuses: listStatuses(id),
    transitions: listTransitions(id),
    sessions: database.select().from(boardSessions).where(eq(boardSessions.boardId, id))
      .orderBy(asc(boardSessions.position)).all(),
  };
}

export function createBoard(input: BoardInput): BoardRecord {
  const statuses = input.statuses ?? DEFAULT_STATUSES;
  assertUniqueNames(statuses.map(s => s.name), 400);
  const initialCount = statuses.filter(s => s.isInitial).length;
  if (initialCount > 1) throw new BoardError('Only one status can be initial');
  const initialIndex = Math.max(0, statuses.findIndex(s => s.isInitial));

  const now = Date.now();
  const board = {
    id: `brd_${randomUUID()}`,
    name: input.name,
    description: input.description ?? null,
    workflowMode: input.workflowMode,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  database.transaction(() => {
    database.insert(boards).values(board).run();
    statuses.forEach((status, index) => {
      database.insert(boardStatuses).values(statusRow(board.id, status, index, index === initialIndex, now)).run();
    });
  });
  return getBoard(board.id)!;
}

export function updateBoard(id: string, patch: BoardPatch): BoardRecord {
  requireBoard(id);
  database.update(boards).set({ ...patch, updatedAt: Date.now() }).where(eq(boards.id, id)).run();
  return getBoard(id)!;
}

/** Soft delete, like automations — but its sessions are freed to join another board. */
export function deleteBoard(id: string): boolean {
  if (!getBoard(id)) return false;
  database.transaction(() => {
    database.update(boards).set({ deletedAt: Date.now() }).where(eq(boards.id, id)).run();
    database.delete(boardSessions).where(eq(boardSessions.boardId, id)).run();
  });
  return true;
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export function listStatuses(boardId: string): BoardStatusRecord[] {
  return database.select().from(boardStatuses).where(eq(boardStatuses.boardId, boardId))
    .orderBy(asc(boardStatuses.position)).all();
}

export function createStatus(boardId: string, input: StatusInput): BoardStatusRecord {
  requireBoard(boardId);
  const existing = listStatuses(boardId);
  assertUniqueNames([...existing.map(s => s.name), input.name], 409);
  const row = statusRow(boardId, input, (existing.at(-1)?.position ?? -1) + 1, !!input.isInitial, Date.now());
  database.transaction(() => {
    if (row.isInitial) clearInitial(boardId);
    database.insert(boardStatuses).values(row).run();
  });
  touchBoard(boardId);
  return getStatus(boardId, row.id)!;
}

export function updateStatus(boardId: string, statusId: string, patch: StatusPatch): BoardStatusRecord {
  requireBoard(boardId);
  const status = requireStatus(boardId, statusId);
  if (patch.name !== undefined) {
    const others = listStatuses(boardId).filter(s => s.id !== statusId).map(s => s.name);
    assertUniqueNames([...others, patch.name], 409);
  }
  // Exactly one initial status per board: the flag can only be handed over.
  if (patch.isInitial === false && status.isInitial) {
    throw new BoardError('A board needs an initial status — mark another status as initial instead');
  }
  database.transaction(() => {
    if (patch.isInitial && !status.isInitial) clearInitial(boardId);
    database.update(boardStatuses).set({ ...patch, updatedAt: Date.now() })
      .where(eq(boardStatuses.id, statusId)).run();
  });
  touchBoard(boardId);
  return getStatus(boardId, statusId)!;
}

/** `statusIds` must list every status of the board exactly once, in the new order. */
export function reorderStatuses(boardId: string, statusIds: string[]): BoardStatusRecord[] {
  requireBoard(boardId);
  const current = listStatuses(boardId).map(s => s.id);
  const same = statusIds.length === current.length && new Set(statusIds).size === current.length
    && statusIds.every(id => current.includes(id));
  if (!same) throw new BoardError('statusIds must contain every status of the board exactly once');
  database.transaction(() => {
    statusIds.forEach((id, position) => {
      database.update(boardStatuses).set({ position }).where(eq(boardStatuses.id, id)).run();
    });
  });
  touchBoard(boardId);
  return listStatuses(boardId);
}

/**
 * Deletes a column. Sessions in it must go somewhere: without `reassignTo` the
 * call is refused rather than silently dropping cards. Transitions touching the
 * status go with it (FK cascade).
 */
export function deleteStatus(boardId: string, statusId: string, reassignTo?: string): void {
  requireBoard(boardId);
  const status = requireStatus(boardId, statusId);
  const statuses = listStatuses(boardId);
  if (statuses.length === 1) throw new BoardError('A board needs at least one status', 409);

  const stranded = database.select().from(boardSessions).where(eq(boardSessions.statusId, statusId)).all();
  if (stranded.length > 0) {
    if (!reassignTo) {
      throw new BoardError(`${stranded.length} session(s) are in "${status.name}" — pass reassignTo to move them first`, 409);
    }
    if (reassignTo === statusId) throw new BoardError('reassignTo must be a different status');
    requireStatus(boardId, reassignTo);
  }

  database.transaction(() => {
    let position = nextPosition(boardId, reassignTo ?? statusId);
    for (const session of stranded) {
      database.update(boardSessions).set({ statusId: reassignTo!, position: position++, updatedAt: Date.now() })
        .where(eq(boardSessions.sessionId, session.sessionId)).run();
      recordEvent(boardId, session.sessionId, statusId, reassignTo!, 'user');
    }
    database.delete(boardStatuses).where(eq(boardStatuses.id, statusId)).run();
    if (status.isInitial) {
      const heir = statuses.find(s => s.id !== statusId)!;
      database.update(boardStatuses).set({ isInitial: true }).where(eq(boardStatuses.id, heir.id)).run();
    }
  });
  touchBoard(boardId);
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export function listTransitions(boardId: string): BoardTransitionRecord[] {
  return database.select().from(boardTransitions).where(eq(boardTransitions.boardId, boardId))
    .orderBy(asc(boardTransitions.createdAt)).all();
}

export function createTransition(boardId: string, input: TransitionInput): BoardTransitionRecord {
  requireBoard(boardId);
  if (input.fromStatusId !== null) requireStatus(boardId, input.fromStatusId);
  requireStatus(boardId, input.toStatusId);
  if (input.fromStatusId === input.toStatusId) throw new BoardError('A transition must go to a different status');
  // Checked here, not by the unique index: SQLite treats NULLs as distinct, so
  // two "from any" transitions to the same status would both get in.
  const duplicate = listTransitions(boardId)
    .some(t => t.fromStatusId === input.fromStatusId && t.toStatusId === input.toStatusId);
  if (duplicate) throw new BoardError('That transition already exists', 409);

  const row = {
    id: `btr_${randomUUID()}`,
    boardId,
    fromStatusId: input.fromStatusId,
    toStatusId: input.toStatusId,
    name: input.name ?? null,
    createdAt: Date.now(),
  };
  database.insert(boardTransitions).values(row).run();
  touchBoard(boardId);
  return row;
}

export function deleteTransition(boardId: string, transitionId: string): boolean {
  requireBoard(boardId);
  const match = and(eq(boardTransitions.id, transitionId), eq(boardTransitions.boardId, boardId));
  if (!database.select().from(boardTransitions).where(match).get()) return false;
  database.delete(boardTransitions).where(match).run();
  touchBoard(boardId);
  return true;
}

// ---------------------------------------------------------------------------
// Sessions on a board
// ---------------------------------------------------------------------------

export function getSessionPlacement(sessionId: string): BoardSessionRecord | null {
  return database.select().from(boardSessions).where(eq(boardSessions.sessionId, sessionId)).get() ?? null;
}

/**
 * Puts a session on a board. A session lives on one board only, so if it sits
 * on another one it is moved — `movedFromBoardId` says where from.
 */
export function addSession(boardId: string, input: AddSessionInput): PlacementResult & { movedFromBoardId: string | null } {
  const board = requireBoard(boardId);
  const statuses = listStatuses(boardId);
  const initial = statuses.find(s => s.isInitial)!;
  const target = input.statusId || input.status ? resolveStatus(statuses, input) : initial;

  const existing = getSessionPlacement(input.sessionId);
  if (existing?.boardId === boardId) throw new BoardError('Session is already on this board — move it instead', 409);
  // Joining is a move out of the initial column, so strict boards only let a
  // session start further along when the initial status could reach there.
  if (!canMove(board.workflowMode as WorkflowMode, listTransitions(boardId), initial.id, target.id)) {
    throw new BoardError(`Sessions cannot join "${board.name}" in "${target.name}" — no transition from "${initial.name}"`, 409);
  }

  const now = Date.now();
  const placement = {
    sessionId: input.sessionId,
    boardId,
    statusId: target.id,
    position: input.position ?? nextPosition(boardId, target.id),
    addedAt: now,
    updatedAt: now,
  };
  database.transaction(() => {
    if (existing) {
      database.delete(boardSessions).where(eq(boardSessions.sessionId, input.sessionId)).run();
      recordEvent(existing.boardId, input.sessionId, existing.statusId, null, input.actor);
    }
    database.insert(boardSessions).values(placement).run();
    recordEvent(boardId, input.sessionId, null, target.id, input.actor);
  });
  return { placement, overWipLimit: isOverWip(target), movedFromBoardId: existing?.boardId ?? null };
}

/** Changes a session's status and/or position. Reorders within a column are not logged. */
export function moveSession(boardId: string, sessionId: string, input: MoveSessionInput): PlacementResult {
  const board = requireBoard(boardId);
  const current = getSessionPlacement(sessionId);
  if (!current || current.boardId !== boardId) throw new BoardError('Session is not on this board', 404);
  const statuses = listStatuses(boardId);
  const target = resolveStatus(statuses, input);

  if (!canMove(board.workflowMode as WorkflowMode, listTransitions(boardId), current.statusId, target.id)) {
    const from = statuses.find(s => s.id === current.statusId)!;
    throw new BoardError(`No transition from "${from.name}" to "${target.name}"`, 409);
  }

  const changedStatus = current.statusId !== target.id;
  const position = input.position ?? (changedStatus ? nextPosition(boardId, target.id) : current.position);
  database.transaction(() => {
    database.update(boardSessions).set({ statusId: target.id, position, updatedAt: Date.now() })
      .where(eq(boardSessions.sessionId, sessionId)).run();
    if (changedStatus) recordEvent(boardId, sessionId, current.statusId, target.id, input.actor);
  });
  return { placement: getSessionPlacement(sessionId)!, overWipLimit: changedStatus && isOverWip(target) };
}

/**
 * Idempotent status write keyed by session — what a poller calls on every tick.
 * Posting the status the session already has is a no-op (`changed: false`, no
 * history event), so repeating the same state never floods the history.
 */
export function setSessionStatus(sessionId: string, input: SetSessionStatusInput): PlacementResult & { changed: boolean; added: boolean } {
  const current = getSessionPlacement(sessionId);
  if (!current) {
    if (!input.boardId) throw new BoardError('Session is not on a board — pass boardId to add it', 404);
    const result = addSession(input.boardId, { sessionId, statusId: input.statusId, status: input.status, actor: input.actor });
    return { placement: result.placement, overWipLimit: result.overWipLimit, changed: true, added: true };
  }
  if (input.boardId && input.boardId !== current.boardId) {
    throw new BoardError('Session is on another board — add it to this one first', 409);
  }
  const target = resolveStatus(listStatuses(current.boardId), input);
  if (target.id === current.statusId) return { placement: current, overWipLimit: false, changed: false, added: false };
  const result = moveSession(current.boardId, sessionId, { statusId: target.id, actor: input.actor });
  return { ...result, changed: true, added: false };
}

export function removeSession(boardId: string, sessionId: string, actor: BoardActor = 'user'): boolean {
  const current = getSessionPlacement(sessionId);
  if (!current || current.boardId !== boardId) return false;
  database.transaction(() => {
    database.delete(boardSessions).where(eq(boardSessions.sessionId, sessionId)).run();
    recordEvent(boardId, sessionId, current.statusId, null, actor);
  });
  return true;
}

/** For session deletion: the session is gone, so there is nobody left to read its history. */
export function removeSessionFromBoards(sessionId: string): void {
  database.delete(boardSessions).where(eq(boardSessions.sessionId, sessionId)).run();
}

/** Newest first. */
export function listSessionEvents(sessionId: string): BoardSessionEventRecord[] {
  return database.select().from(boardSessionEvents).where(eq(boardSessionEvents.sessionId, sessionId))
    .orderBy(desc(boardSessionEvents.createdAt), desc(sql`rowid`)).all();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireBoard(id: string): BoardRecord {
  const board = getBoard(id);
  if (!board) throw new BoardError('Board not found', 404);
  return board;
}

function getStatus(boardId: string, statusId: string): BoardStatusRecord | null {
  return database.select().from(boardStatuses)
    .where(and(eq(boardStatuses.id, statusId), eq(boardStatuses.boardId, boardId))).get() ?? null;
}

function requireStatus(boardId: string, statusId: string): BoardStatusRecord {
  const status = getStatus(boardId, statusId);
  if (!status) throw new BoardError('Status not found on this board', 404);
  return status;
}

/** By id, or by name case-insensitively — agents know "In Review", not `bst_…`. */
function resolveStatus(statuses: BoardStatusRecord[], target: { statusId?: string; status?: string }): BoardStatusRecord {
  const found = target.statusId
    ? statuses.find(s => s.id === target.statusId)
    : statuses.find(s => s.name.toLowerCase() === target.status!.toLowerCase());
  if (!found) {
    throw new BoardError(`Status not found on this board. Available: ${statuses.map(s => s.name).join(', ')}`, 404);
  }
  return found;
}

function statusRow(boardId: string, input: StatusInput, position: number, isInitial: boolean, now: number) {
  return {
    id: `bst_${randomUUID()}`,
    boardId,
    name: input.name,
    color: input.color ?? CATEGORY_COLORS[input.category],
    category: input.category,
    position,
    isInitial,
    wipLimit: input.wipLimit ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

function assertUniqueNames(names: string[], status: 400 | 409): void {
  const seen = new Set<string>();
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) throw new BoardError(`A status named "${name}" already exists on this board`, status);
    seen.add(key);
  }
}

function clearInitial(boardId: string): void {
  database.update(boardStatuses).set({ isInitial: false }).where(eq(boardStatuses.boardId, boardId)).run();
}

function nextPosition(boardId: string, statusId: string): number {
  const row = database.select({ max: sql<number | null>`max(${boardSessions.position})` }).from(boardSessions)
    .where(and(eq(boardSessions.boardId, boardId), eq(boardSessions.statusId, statusId))).get();
  return (row?.max ?? 0) + 1;
}

function isOverWip(status: BoardStatusRecord): boolean {
  if (status.wipLimit === null) return false;
  const row = database.select({ count: sql<number>`count(*)` }).from(boardSessions)
    .where(eq(boardSessions.statusId, status.id)).get();
  return (row?.count ?? 0) > status.wipLimit;
}

function recordEvent(boardId: string, sessionId: string, fromStatusId: string | null, toStatusId: string | null, actor: BoardActor): void {
  database.insert(boardSessionEvents).values({
    id: `bev_${randomUUID()}`,
    boardId,
    sessionId,
    fromStatusId,
    toStatusId,
    actor,
    createdAt: Date.now(),
  }).run();
}

function touchBoard(boardId: string): void {
  database.update(boards).set({ updatedAt: Date.now() }).where(eq(boards.id, boardId)).run();
}
