/**
 * What the agent's transcript says about a calendar event's guests.
 *
 * calendar_update and calendar_delete only carry an event id, but whether
 * they reach other people depends on the event: the policy allows changing
 * the owner's own events and asks for ones with guests. The answer comes
 * from the last calendar_list / calendar_create / calendar_update result
 * that showed the event — the same results the agent took the id from.
 *
 * Read-only over in-memory session state; safe for the preview phase.
 */

import { getSessionState, type ChatMessage } from '../../session/state';
import type { CalendarLookup } from './classify';

const WINDOW = 400;
const RESULT_TOOLS = ['calendar_list', 'calendar_create', 'calendar_update'];

const isCalendarUse = (m: ChatMessage) =>
  !!m.toolName && !m.isToolResult && RESULT_TOOLS.some(t => m.toolName === t || m.toolName!.endsWith(`__${t}`));

interface ListedAttendee { email?: unknown; self?: unknown }
interface ListedEvent {
  id?: unknown;
  recurringEventId?: unknown;
  attendees?: ListedAttendee[];
  attendeeCount?: unknown;
  organizer?: unknown;
  guests?: unknown;
}

/** The JSON a calendar tool returned, after its untrusted-content banner if it has one. */
function payloadOf(content: string): Record<string, unknown> | null {
  const start = content.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(content.slice(start));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // A transcript that clipped the result can't vouch for anything.
    return null;
  }
}

/** Other people on one listed event: guests who aren't the owner, plus the organizer of an invitation. */
function othersOn(ev: ListedEvent): number {
  if (Array.isArray(ev.guests)) return ev.guests.length; // create/update confirmations list non-self guests only
  const attendees = Array.isArray(ev.attendees) ? ev.attendees : [];
  const self = attendees.some(a => a?.self === true) ? 1 : 0;
  const listed = attendees.length - self;
  const total = typeof ev.attendeeCount === 'number' ? Math.max(listed, ev.attendeeCount - self) : listed;
  return Math.max(total, typeof ev.organizer === 'string' && ev.organizer ? 1 : 0);
}

function guestsIn(payload: Record<string, unknown>, eventId: string): number | null {
  if (payload.id === eventId) return othersOn(payload as ListedEvent);
  const events = Array.isArray(payload.events) ? (payload.events as ListedEvent[]) : [];
  // A recurring series is addressed by recurringEventId; its instances share the guest list.
  const matches = events.filter(e => e && (e.id === eventId || e.recurringEventId === eventId));
  if (!matches.length) return null;
  return Math.max(...matches.map(othersOn));
}

export function calendarLookup(sessionId: string): CalendarLookup {
  return {
    eventGuests(eventId) {
      if (!eventId) return null;
      const msgs = getSessionState(sessionId).messages;
      const recent = msgs.slice(Math.max(0, msgs.length - WINDOW));
      const uses = new Set(recent.filter(isCalendarUse).map(m => m.id));
      for (let i = recent.length - 1; i >= 0; i--) {
        const m = recent[i]!;
        if (!m.isToolResult || !m.toolUseId || !uses.has(m.toolUseId) || !m.content?.includes(eventId)) continue;
        const payload = payloadOf(m.content);
        const guests = payload ? guestsIn(payload, eventId) : null;
        if (guests !== null) return guests;
      }
      return null;
    },
  };
}
