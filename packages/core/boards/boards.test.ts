import { describe, expect, test } from 'bun:test';
import * as boards from './repository';
import { canMove } from './workflow';
import { BoardError } from './types';

// Sandbox database comes from scripts/test-preload.ts, like every other suite.

let seq = 0;
const sid = () => `board-test-session-${++seq}`;

function statusByName(boardId: string, name: string) {
  return boards.getBoardDetail(boardId)!.statuses.find(s => s.name === name)!;
}

describe('board creation', () => {
  test('seeds To Do / In Progress / Done with the first one initial', () => {
    const board = boards.createBoard({ name: 'Default', workflowMode: 'free' });
    const { statuses } = boards.getBoardDetail(board.id)!;
    expect(statuses.map(s => [s.name, s.category, s.isInitial])).toEqual([
      ['To Do', 'todo', true],
      ['In Progress', 'in_progress', false],
      ['Done', 'done', false],
    ]);
  });

  test('takes custom statuses and honours an explicit initial', () => {
    const board = boards.createBoard({
      name: 'Custom', workflowMode: 'strict',
      statuses: [
        { name: 'Backlog', category: 'todo' },
        { name: 'Ready', category: 'todo', isInitial: true },
        { name: 'Shipped', category: 'done', color: '#22c55e' },
      ],
    });
    const { statuses } = boards.getBoardDetail(board.id)!;
    expect(statuses.filter(s => s.isInitial).map(s => s.name)).toEqual(['Ready']);
    expect(statuses.find(s => s.name === 'Shipped')!.color).toBe('#22c55e');
  });

  test('rejects duplicate status names, case-insensitively', () => {
    expect(() => boards.createBoard({
      name: 'Dupes', workflowMode: 'free',
      statuses: [{ name: 'QA', category: 'todo' }, { name: 'qa', category: 'done' }],
    })).toThrow(BoardError);
  });
});

describe('initial status', () => {
  test('marking another status initial moves the flag, never duplicates it', () => {
    const board = boards.createBoard({ name: 'Initial', workflowMode: 'free' });
    const doing = statusByName(board.id, 'In Progress');
    boards.updateStatus(board.id, doing.id, { isInitial: true });
    const initial = boards.getBoardDetail(board.id)!.statuses.filter(s => s.isInitial);
    expect(initial.map(s => s.name)).toEqual(['In Progress']);
  });

  test('cannot clear the flag directly', () => {
    const board = boards.createBoard({ name: 'Initial 2', workflowMode: 'free' });
    const todo = statusByName(board.id, 'To Do');
    expect(() => boards.updateStatus(board.id, todo.id, { isInitial: false })).toThrow(BoardError);
  });

  test('deleting the initial status hands the flag to the first remaining one', () => {
    const board = boards.createBoard({ name: 'Initial 3', workflowMode: 'free' });
    boards.deleteStatus(board.id, statusByName(board.id, 'To Do').id);
    expect(statusByName(board.id, 'In Progress').isInitial).toBe(true);
  });

  test('the last status cannot be deleted', () => {
    const board = boards.createBoard({ name: 'Last', workflowMode: 'free', statuses: [{ name: 'Only', category: 'todo' }] });
    expect(() => boards.deleteStatus(board.id, statusByName(board.id, 'Only').id)).toThrow(BoardError);
  });
});

describe('workflow rules', () => {
  const transitions = [
    { fromStatusId: 'a', toStatusId: 'b' },
    { fromStatusId: null, toStatusId: 'c' },
  ];

  test('free boards allow any move', () => {
    expect(canMove('free', transitions, 'b', 'a')).toBe(true);
  });

  test('strict boards allow only declared moves, with null meaning "from any"', () => {
    expect(canMove('strict', transitions, 'a', 'b')).toBe(true);
    expect(canMove('strict', transitions, 'b', 'a')).toBe(false);
    expect(canMove('strict', transitions, 'b', 'c')).toBe(true);
  });

  test('staying in the same status (a reorder) is always allowed', () => {
    expect(canMove('strict', [], 'a', 'a')).toBe(true);
  });
});

describe('sessions on a board', () => {
  function strictBoard() {
    const board = boards.createBoard({ name: 'Strict', workflowMode: 'strict' });
    const todo = statusByName(board.id, 'To Do');
    const doing = statusByName(board.id, 'In Progress');
    const done = statusByName(board.id, 'Done');
    boards.createTransition(board.id, { fromStatusId: todo.id, toStatusId: doing.id });
    boards.createTransition(board.id, { fromStatusId: doing.id, toStatusId: done.id });
    return { board, todo, doing, done };
  }

  test('a new session lands on the initial status', () => {
    const { board, todo } = strictBoard();
    const { placement } = boards.addSession(board.id, { sessionId: sid(), actor: 'user' });
    expect(placement.statusId).toBe(todo.id);
  });

  test('strict boards enforce transitions on move and accept status names', () => {
    const { board, doing, done } = strictBoard();
    const sessionId = sid();
    boards.addSession(board.id, { sessionId, actor: 'user' });
    expect(() => boards.moveSession(board.id, sessionId, { statusId: done.id, actor: 'user' })).toThrow(BoardError);
    expect(boards.moveSession(board.id, sessionId, { status: 'in progress', actor: 'agent' }).placement.statusId).toBe(doing.id);
    expect(boards.moveSession(board.id, sessionId, { statusId: done.id, actor: 'user' }).placement.statusId).toBe(done.id);
  });

  test('joining straight into a non-initial column needs a transition from the initial one', () => {
    const { board, doing, done } = strictBoard();
    expect(() => boards.addSession(board.id, { sessionId: sid(), statusId: done.id, actor: 'user' })).toThrow(BoardError);
    expect(boards.addSession(board.id, { sessionId: sid(), statusId: doing.id, actor: 'user' }).placement.statusId).toBe(doing.id);
  });

  test('a session lives on one board: adding it elsewhere moves it', () => {
    const first = boards.createBoard({ name: 'First', workflowMode: 'free' });
    const second = boards.createBoard({ name: 'Second', workflowMode: 'free' });
    const sessionId = sid();
    boards.addSession(first.id, { sessionId, actor: 'user' });
    const { movedFromBoardId } = boards.addSession(second.id, { sessionId, actor: 'user' });
    expect(movedFromBoardId).toBe(first.id);
    expect(boards.getSessionPlacement(sessionId)!.boardId).toBe(second.id);
    expect(boards.getBoardDetail(first.id)!.sessions).toHaveLength(0);
  });

  test('new cards append to the end of their column', () => {
    const board = boards.createBoard({ name: 'Order', workflowMode: 'free' });
    const a = boards.addSession(board.id, { sessionId: sid(), actor: 'user' }).placement;
    const b = boards.addSession(board.id, { sessionId: sid(), actor: 'user' }).placement;
    expect(b.position).toBeGreaterThan(a.position);
  });

  test('exceeding the WIP limit is reported, not blocked', () => {
    const board = boards.createBoard({ name: 'WIP', workflowMode: 'free', statuses: [{ name: 'Doing', category: 'in_progress', wipLimit: 1 }] });
    expect(boards.addSession(board.id, { sessionId: sid(), actor: 'user' }).overWipLimit).toBe(false);
    expect(boards.addSession(board.id, { sessionId: sid(), actor: 'user' }).overWipLimit).toBe(true);
  });

  test('deleting a status with sessions requires a reassignment target', () => {
    const board = boards.createBoard({ name: 'Reassign', workflowMode: 'free' });
    const todo = statusByName(board.id, 'To Do');
    const done = statusByName(board.id, 'Done');
    const sessionId = sid();
    boards.addSession(board.id, { sessionId, actor: 'user' });
    expect(() => boards.deleteStatus(board.id, todo.id)).toThrow(BoardError);
    boards.deleteStatus(board.id, todo.id, done.id);
    expect(boards.getSessionPlacement(sessionId)!.statusId).toBe(done.id);
  });

  test('every move is recorded with its actor', () => {
    const board = boards.createBoard({ name: 'History', workflowMode: 'free' });
    const sessionId = sid();
    boards.addSession(board.id, { sessionId, actor: 'user' });
    boards.moveSession(board.id, sessionId, { status: 'Done', actor: 'agent' });
    const events = boards.listSessionEvents(sessionId);
    expect(events.map(e => e.actor)).toEqual(['agent', 'user']);
    expect(events[1].fromStatusId).toBeNull();
  });

  test('deleting a board frees its sessions', () => {
    const board = boards.createBoard({ name: 'Gone', workflowMode: 'free' });
    const sessionId = sid();
    boards.addSession(board.id, { sessionId, actor: 'user' });
    expect(boards.deleteBoard(board.id)).toBe(true);
    expect(boards.getSessionPlacement(sessionId)).toBeNull();
    expect(boards.getBoard(board.id)).toBeNull();
  });

  test('removeSessionFromBoards drops a deleted session', () => {
    const board = boards.createBoard({ name: 'Cleanup', workflowMode: 'free' });
    const sessionId = sid();
    boards.addSession(board.id, { sessionId, actor: 'user' });
    boards.removeSessionFromBoards(sessionId);
    expect(boards.getSessionPlacement(sessionId)).toBeNull();
  });
});

describe('setSessionStatus (poller API)', () => {
  test('moves by session id and status name, and logs the automation actor', () => {
    const board = boards.createBoard({ name: 'Poll', workflowMode: 'free' });
    const sessionId = sid();
    boards.addSession(board.id, { sessionId, actor: 'user' });
    const result = boards.setSessionStatus(sessionId, { status: 'done', actor: 'automation' });
    expect(result.changed).toBe(true);
    expect(result.placement.statusId).toBe(statusByName(board.id, 'Done').id);
    expect(boards.listSessionEvents(sessionId)[0].actor).toBe('automation');
  });

  test('posting the current status again is a no-op without a history event', () => {
    const board = boards.createBoard({ name: 'Poll idempotent', workflowMode: 'free' });
    const sessionId = sid();
    boards.addSession(board.id, { sessionId, actor: 'user' });
    boards.setSessionStatus(sessionId, { status: 'In Progress', actor: 'automation' });
    const before = boards.listSessionEvents(sessionId).length;
    expect(boards.setSessionStatus(sessionId, { status: 'In Progress', actor: 'automation' }).changed).toBe(false);
    expect(boards.listSessionEvents(sessionId)).toHaveLength(before);
  });

  test('a session off any board needs boardId, and is added with it', () => {
    const board = boards.createBoard({ name: 'Poll add', workflowMode: 'free' });
    const sessionId = sid();
    expect(() => boards.setSessionStatus(sessionId, { status: 'Done', actor: 'automation' })).toThrow(BoardError);
    const result = boards.setSessionStatus(sessionId, { status: 'Done', boardId: board.id, actor: 'automation' });
    expect(result.added).toBe(true);
    expect(result.placement.statusId).toBe(statusByName(board.id, 'Done').id);
  });

  test('strict boards still enforce transitions', () => {
    const board = boards.createBoard({ name: 'Poll strict', workflowMode: 'strict' });
    const sessionId = sid();
    boards.addSession(board.id, { sessionId, actor: 'user' });
    expect(() => boards.setSessionStatus(sessionId, { status: 'Done', actor: 'automation' })).toThrow(BoardError);
  });

  test('a boardId that is not the session\'s board is refused', () => {
    const first = boards.createBoard({ name: 'Poll A', workflowMode: 'free' });
    const second = boards.createBoard({ name: 'Poll B', workflowMode: 'free' });
    const sessionId = sid();
    boards.addSession(first.id, { sessionId, actor: 'user' });
    expect(() => boards.setSessionStatus(sessionId, { status: 'Done', boardId: second.id, actor: 'automation' })).toThrow(BoardError);
  });
});

describe('transitions', () => {
  test('rejects self-loops, foreign statuses, and duplicates', () => {
    const board = boards.createBoard({ name: 'Transitions', workflowMode: 'strict' });
    const other = boards.createBoard({ name: 'Other', workflowMode: 'strict' });
    const todo = statusByName(board.id, 'To Do');
    const done = statusByName(board.id, 'Done');
    expect(() => boards.createTransition(board.id, { fromStatusId: todo.id, toStatusId: todo.id })).toThrow(BoardError);
    expect(() => boards.createTransition(board.id, { fromStatusId: todo.id, toStatusId: statusByName(other.id, 'Done').id })).toThrow(BoardError);
    boards.createTransition(board.id, { fromStatusId: null, toStatusId: done.id });
    expect(() => boards.createTransition(board.id, { fromStatusId: null, toStatusId: done.id })).toThrow(BoardError);
  });
});
