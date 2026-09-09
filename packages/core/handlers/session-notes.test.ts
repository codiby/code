import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sessions } from '../session/sessions';
import type { Session } from '../types';
import { readSessionNotes, writeSessionNotes, appendSessionFollowUp, sessionNotesTool, handleSessionNotes, NotesConflict, MAX_NOTE_LENGTH, deleteSessionNotes } from './session-notes';

test('notes persist independently of the live session and remain isolated by session', () => {
  const id = randomUUID();
  const saved = writeSessionNotes(id, 'My decisions', 0);
  expect(readSessionNotes(id)).toEqual(saved);
  expect(readSessionNotes(randomUUID()).content).toBe('');
  expect(saved.revision).toBe(1);
  deleteSessionNotes(id);
  expect(readSessionNotes(id).content).toBe('');
});
test('follow-ups append and stale editor saves cannot erase them', () => {
  const id = randomUUID();
  const draft = writeSessionNotes(id, 'Personal notes', 0);
  appendSessionFollowUp(id, 'Verify the deployment');
  appendSessionFollowUp(id, 'Check remote sessions');
  expect(() => writeSessionNotes(id, 'Stale draft', draft.revision)).toThrow(NotesConflict);
  const latest = readSessionNotes(id);
  expect(latest.content).toStartWith('Personal notes');
  expect(latest.content).toContain('Verify the deployment');
  expect(latest.content).toContain('Check remote sessions');
  expect(latest.revision).toBe(3);
  expect(writeSessionNotes(id, '', latest.revision).content).toBe('');
});
test('invalid content and revision do not mutate notes', () => {
  const id = randomUUID();
  expect(() => appendSessionFollowUp(id, '  ')).toThrow();
  expect(() => writeSessionNotes(id, 'x'.repeat(MAX_NOTE_LENGTH + 1), 0)).toThrow();
  expect(() => writeSessionNotes(id, 'test', -1)).toThrow();
  expect(readSessionNotes(id).revision).toBe(0);
});
test('tools require an owning session and append only within it', () => {
  const id = randomUUID();
  expect(sessionNotesTool('').isError).toBe(true);
  expect(sessionNotesTool(id, 'test').isError).toBe(true);
  sessions.set(id, { id } as Session);
  try {
    expect(sessionNotesTool(id, 'Follow up').isError).toBeUndefined();
    const result = JSON.parse(sessionNotesTool(id).content[0]!.text);
    expect(result.content).toContain('Follow up');
    expect(result.sessionId).toBe(id);
    expect(sessionNotesTool(id, null).isError).toBe(true);
  } finally { sessions.delete(id); }
});
test('HTTP returns missing session, validation and conflict errors', async () => {
  const id = randomUUID();
  const request = (body: unknown) => new Request('http://localhost/notes', { method: 'PUT', body: JSON.stringify(body) });
  expect((await handleSessionNotes(id, request({}))).status).toBe(404);
  sessions.set(id, { id } as Session);
  try {
    expect((await handleSessionNotes(id, request({ content: 'Saved', revision: 0 }))).status).toBe(200);
    expect((await handleSessionNotes(id, request({ content: 'Old', revision: 0 }))).status).toBe(409);
    expect((await handleSessionNotes(id, request({ content: 123, revision: 1 }))).status).toBe(400);
    expect((await handleSessionNotes(id, request(null))).status).toBe(400);
    const response = await handleSessionNotes(id, new Request('http://localhost/notes'));
    expect((await response.json()).content).toBe('Saved');
  } finally { sessions.delete(id); }
});
