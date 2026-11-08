import { ZodError } from 'zod';
import { corsHeaders } from '../config/config';
import { sessions } from '../session/sessions';
import * as boards from '../boards/repository';
import {
  addSessionSchema,
  boardInputSchema,
  boardPatchSchema,
  BoardError,
  moveSessionSchema,
  setSessionStatusSchema,
  statusInputSchema,
  statusOrderSchema,
  statusPatchSchema,
  transitionInputSchema,
} from '../boards/types';

export function handleListBoards(): Response {
  return Response.json({ boards: boards.listBoards() }, { headers: corsHeaders });
}

export function handleGetBoard(id: string): Response {
  const detail = boards.getBoardDetail(id);
  if (!detail) return notFound('Board not found');
  // Placements outlive sessions that vanish without a purge (e.g. empty ones
  // pruned at boot), so only cards for sessions the server still knows are shown.
  return Response.json({ ...detail, sessions: detail.sessions.filter(s => sessions.has(s.sessionId)) }, { headers: corsHeaders });
}

export const handleCreateBoard = (req: Request) => withBody(req, body =>
  Response.json({ board: boards.createBoard(boardInputSchema.parse(body)) }, { status: 201, headers: corsHeaders }));

export const handleUpdateBoard = (id: string, req: Request) => withBody(req, body =>
  Response.json({ board: boards.updateBoard(id, boardPatchSchema.parse(body)) }, { headers: corsHeaders }));

export function handleDeleteBoard(id: string): Response {
  return boards.deleteBoard(id) ? ok() : notFound('Board not found');
}

// ── Statuses ────────────────────────────────────────────────────────────────

export const handleCreateStatus = (boardId: string, req: Request) => withBody(req, body =>
  Response.json({ status: boards.createStatus(boardId, statusInputSchema.parse(body)) }, { status: 201, headers: corsHeaders }));

export const handleUpdateStatus = (boardId: string, statusId: string, req: Request) => withBody(req, body =>
  Response.json({ status: boards.updateStatus(boardId, statusId, statusPatchSchema.parse(body)) }, { headers: corsHeaders }));

export const handleReorderStatuses = (boardId: string, req: Request) => withBody(req, body =>
  Response.json({ statuses: boards.reorderStatuses(boardId, statusOrderSchema.parse(body).statusIds) }, { headers: corsHeaders }));

export function handleDeleteStatus(boardId: string, statusId: string, req: Request): Response {
  const reassignTo = new URL(req.url).searchParams.get('reassignTo') || undefined;
  return guard(() => {
    boards.deleteStatus(boardId, statusId, reassignTo);
    return ok();
  });
}

// ── Transitions ─────────────────────────────────────────────────────────────

export const handleCreateTransition = (boardId: string, req: Request) => withBody(req, body =>
  Response.json({ transition: boards.createTransition(boardId, transitionInputSchema.parse(body)) }, { status: 201, headers: corsHeaders }));

export function handleDeleteTransition(boardId: string, transitionId: string): Response {
  return guard(() => boards.deleteTransition(boardId, transitionId) ? ok() : notFound('Transition not found'));
}

// ── Sessions on a board ─────────────────────────────────────────────────────

export const handleAddBoardSession = (boardId: string, req: Request) => withBody(req, body => {
  const input = addSessionSchema.parse(body);
  if (!sessions.has(input.sessionId)) return notFound('Session not found');
  return Response.json(boards.addSession(boardId, input), { status: 201, headers: corsHeaders });
});

export const handleMoveBoardSession = (boardId: string, sessionId: string, req: Request) => withBody(req, body =>
  Response.json(boards.moveSession(boardId, sessionId, moveSessionSchema.parse(body)), { headers: corsHeaders }));

export function handleRemoveBoardSession(boardId: string, sessionId: string): Response {
  return boards.removeSession(boardId, sessionId) ? ok() : notFound('Session is not on this board');
}

/** Poller entry point: set a session's status knowing only its id. 201 when it joined a board, 200 otherwise. */
export const handleSetSessionStatus = (sessionId: string, req: Request) => withBody(req, body => {
  const input = setSessionStatusSchema.parse(body);
  if (!sessions.has(sessionId)) return notFound('Session not found');
  const result = boards.setSessionStatus(sessionId, input);
  return Response.json(result, { status: result.added ? 201 : 200, headers: corsHeaders });
});

/** Which board and status a session is on — what the session drawer and an agent ask. */
export function handleGetSessionBoard(sessionId: string): Response {
  const placement = boards.getSessionPlacement(sessionId);
  if (!placement) return Response.json({ placement: null }, { headers: corsHeaders });
  const board = boards.getBoard(placement.boardId);
  const status = boards.listStatuses(placement.boardId).find(s => s.id === placement.statusId) ?? null;
  return Response.json({ placement, board, status, events: boards.listSessionEvents(sessionId) }, { headers: corsHeaders });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function withBody(req: Request, fn: (body: unknown) => Response): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: corsHeaders });
  }
  return guard(() => fn(body));
}

function guard(fn: () => Response): Response {
  try {
    return fn();
  } catch (error) {
    if (error instanceof BoardError) return Response.json({ error: error.message }, { status: error.status, headers: corsHeaders });
    if (error instanceof ZodError) {
      const message = error.issues.map(i => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message).join('; ');
      return Response.json({ error: message }, { status: 400, headers: corsHeaders });
    }
    throw error;
  }
}

const ok = () => Response.json({ ok: true }, { headers: corsHeaders });
const notFound = (error: string) => Response.json({ error }, { status: 404, headers: corsHeaders });
