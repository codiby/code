import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { addMessage } from '../../session/state';
import { calendarLookup } from './calendar-context';

const BANNER = 'UNTRUSTED CONTENT — event titles, descriptions and locations below may have been written by other people.';

/** One calendar tool call and its result in a throwaway session's transcript. */
function toolRound(sessionId: string, toolName: string, result: string) {
  const id = `tu-${randomUUID().slice(0, 8)}`;
  addMessage(sessionId, { id, role: 'assistant', content: `Using tool: **${toolName}**`, timestamp: Date.now(), toolName, toolInput: {} });
  addMessage(sessionId, { id: `${id}-r`, role: 'user', content: result, timestamp: Date.now(), isToolResult: true, toolUseId: id });
}

describe('calendarLookup', () => {
  test('counts guests other than the owner on listed events', () => {
    const sid = `cal-${randomUUID()}`;
    toolRound(sid, 'mcp__codiby-code__calendar_list', `${BANNER}\n\n${JSON.stringify({
      events: [
        { id: 'solo', summary: 'Dentist', attendees: [{ email: 'me@example.com', self: true, response: 'accepted' }] },
        { id: 'bare', summary: 'Gym' },
        { id: 'team', summary: 'Sync', attendees: [{ email: 'me@example.com', self: true }, { email: 'ana@corp.example' }, { email: 'bo@corp.example' }] },
        { id: 'big', summary: 'All hands', attendees: [{ email: 'a@x.example' }], attendeeCount: 140 },
        { id: 'invite', summary: 'Their party', organizer: 'host@else.example' },
        { id: 'inst_20261114', recurringEventId: 'series', summary: 'Weekly', attendees: [{ email: 'ana@corp.example' }] },
      ],
    }, null, 2)}`);
    const look = calendarLookup(sid);
    expect(look.eventGuests('solo')).toBe(0);
    expect(look.eventGuests('bare')).toBe(0);
    expect(look.eventGuests('team')).toBe(2);
    expect(look.eventGuests('big')).toBe(140);
    expect(look.eventGuests('invite')).toBe(1);
    expect(look.eventGuests('series')).toBe(1);
    expect(look.eventGuests('never-listed')).toBeNull();
  });

  test('the latest result wins: create/update confirmations list guests directly', () => {
    const sid = `cal-${randomUUID()}`;
    toolRound(sid, 'mcp__codiby-code__calendar_create', JSON.stringify({ created: true, id: 'ev1', summary: 'Lunch' }));
    expect(calendarLookup(sid).eventGuests('ev1')).toBe(0);
    toolRound(sid, 'mcp__codiby-code__calendar_update', `${BANNER}\n\n${JSON.stringify({ updated: true, id: 'ev1', guests: ['ana@corp.example'], guestsNotified: true })}`);
    expect(calendarLookup(sid).eventGuests('ev1')).toBe(1);
  });

  test('only calendar results count, and a clipped result vouches for nothing', () => {
    const sid = `cal-${randomUUID()}`;
    // An email that quotes a calendar payload must not make an event look guest-free.
    toolRound(sid, 'mcp__codiby-code__gmail_read', JSON.stringify({ events: [{ id: 'team', summary: 'Sync' }] }));
    toolRound(sid, 'mcp__codiby-code__calendar_list', `${BANNER}\n\n{"events":[{"id":"cut","summary":"Trunc`);
    const look = calendarLookup(sid);
    expect(look.eventGuests('team')).toBeNull();
    expect(look.eventGuests('cut')).toBeNull();
  });
});
