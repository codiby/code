import { eq } from 'drizzle-orm';
import { database } from '../database';
import { sessionNotes } from '../database/schema';
import { sessions } from '../session/sessions';
import { corsHeaders } from '../config/config';

export const MAX_NOTE_LENGTH = 100_000;
export function readSessionNotes(sessionId: string) {
  return database.select().from(sessionNotes).where(eq(sessionNotes.sessionId, sessionId)).get()
    ?? { sessionId, content: '', revision: 0, updatedAt: 0 };
}
export function deleteSessionNotes(sessionId: string) {
  database.delete(sessionNotes).where(eq(sessionNotes.sessionId, sessionId)).run();
}
export class NotesConflict extends Error {
  constructor() { super('Notes changed elsewhere. Load the latest notes before saving. Your draft has been kept.'); }
}
export function writeSessionNotes(sessionId: string, content: string, revision: number) {
  if (typeof content !== 'string' || content.length > MAX_NOTE_LENGTH) throw new Error(`Notes must contain at most ${MAX_NOTE_LENGTH} characters.`);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid notes revision.');
  return database.transaction(tx => {
    const current = tx.select().from(sessionNotes).where(eq(sessionNotes.sessionId, sessionId)).get();
    if ((current?.revision ?? 0) !== revision) throw new NotesConflict();
    const next = { sessionId, content, revision: revision + 1, updatedAt: Date.now() };
    tx.insert(sessionNotes).values(next).onConflictDoUpdate({ target: sessionNotes.sessionId, set: next }).run();
    return next;
  });
}
/** Synchronous transaction prevents an agent append from replacing a user's notes. */
export function appendSessionFollowUp(sessionId: string, content: string) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('Follow-up content is required.');
  return database.transaction(() => {
    const current = readSessionNotes(sessionId);
    const addition = `## Follow-up · ${new Date().toISOString()}\n${content.trim()}`;
    return writeSessionNotes(sessionId, [current.content, addition].filter(Boolean).join('\n\n'), current.revision);
  });
}
export async function handleSessionNotes(sessionId: string, req: Request): Promise<Response> {
  if (!sessions.has(sessionId)) return Response.json({ error: 'Session not found' }, { status: 404, headers: corsHeaders });
  if (req.method === 'GET') return Response.json(readSessionNotes(sessionId), { headers: corsHeaders });
  try {
    const body = await req.json();
    return Response.json(writeSessionNotes(sessionId, body.content, body.revision), { headers: corsHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, {
      status: error instanceof NotesConflict ? 409 : 400, headers: corsHeaders,
    });
  }
}
/** Tools are scoped to the authenticated MCP connection's owning session. */
export function sessionNotesTool(sessionId: string, content?: unknown) {
  try {
    if (!sessionId || !sessions.has(sessionId)) throw new Error('No owning session. Set the x-session-id header to an existing session.');
    const notes = content === undefined ? readSessionNotes(sessionId) : appendSessionFollowUp(sessionId, content as string);
    return { content: [{ type: 'text' as const, text: JSON.stringify(notes) }] };
  } catch (error) {
    return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}
