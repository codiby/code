/**
 * Calendar tools for the agent: list, free/busy, create, update, delete,
 * against the Google Calendar v3 REST API. The model reads and writes times in
 * the owner's zone (persona.timezone); events written by other people
 * (invitations, shared calendars) come back under the UNTRUSTED banner.
 */

import type { AgentTool, CallToolResult } from '../types';
import { jsonResult } from '../tools';
import { requireCalendar } from './access';
import { ToolInputError, optEnum, optInt, optString, optStringList, reqId, reqString } from './args';
import { GoogleApiError, googleRequest } from './api';
import { googleDeps } from './deps';
import { htmlToText, parseAddressList } from './mime';
import {
  addDays,
  humanTime,
  isValidTimeZone,
  ownerTimeZone,
  parseTimeInput,
  toZonedIso,
  zonedDate,
  zonedToInstant,
  type ParsedTime,
} from './time';
import { CALENDAR_UNTRUSTED, untrustedResult } from './untrusted';

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

const DAY_MS = 86_400_000;
const MAX_LIST_SPAN_DAYS = 366;
/** Google rejects longer free/busy windows. */
const MAX_FREEBUSY_SPAN_DAYS = 62;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_ATTENDEES_SHOWN = 30;
const SEND_UPDATES = ['all', 'externalOnly', 'none'] as const;

interface EventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventTime;
  end?: EventTime;
  attendees?: { email?: string; displayName?: string; responseStatus?: string; self?: boolean; organizer?: boolean; optional?: boolean }[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  htmlLink?: string;
  hangoutLink?: string;
  recurringEventId?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
}

const eventsUrl = (calendarId: string) => `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;
const eventUrl = (calendarId: string, id: string) => `${eventsUrl(calendarId)}/${encodeURIComponent(id)}`;

function calendarIdArg(args: Record<string, unknown>): string {
  return optString(args, 'calendarId', { max: 300 }) || 'primary';
}

function timeZoneArg(args: Record<string, unknown>): string {
  const tz = optString(args, 'timezone', { max: 64 });
  if (!tz) return ownerTimeZone();
  if (!isValidTimeZone(tz)) throw new ToolInputError(`timezone must be an IANA zone such as America/Mexico_City (got "${tz}")`);
  return tz;
}

/** Wrap parse errors so the model sees them as fixable input problems. */
function parseTime(input: unknown, tz: string, field: string): ParsedTime {
  try {
    return parseTimeInput(input, tz, field);
  } catch (err) {
    throw new ToolInputError(err instanceof Error ? err.message : String(err));
  }
}

/** Date-only 'to' bounds mean "through the end of that day". */
function rangeEnd(p: ParsedTime, tz: string): number {
  if (!p.dateOnly) return p.instant;
  const [y, m, d] = addDays(p.date!, 1).split('-').map(Number) as [number, number, number];
  return zonedToInstant(y, m, d, 0, 0, 0, tz);
}

/**
 * Instant of an event's dateTime. Google sends RFC 3339 with an offset, but
 * an offset-less value (allowed on input, echoed by some clients) is local
 * to the event's own zone — never to this server's.
 */
function eventInstant(t: EventTime | undefined, tz: string): number {
  const v = t?.dateTime ?? '';
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(v)) return Date.parse(v);
  const zone = t?.timeZone && isValidTimeZone(t.timeZone) ? t.timeZone : tz;
  try { return parseTimeInput(v, zone, 'dateTime').instant; } catch { return Date.parse(v); }
}

function humanDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return humanTime(Date.UTC(y, m - 1, d, 12), 'UTC', { withTime: false });
}

function describeEvent(ev: CalendarEvent, tz: string) {
  const allDay = !!ev.start?.date;
  let when = '';
  let start = '';
  let end = '';
  if (allDay) {
    start = ev.start!.date!;
    // Google's all-day end date is exclusive.
    end = ev.end?.date ? addDays(ev.end.date, -1) : start;
    when = end === start ? `${humanDate(start)} (all day)` : `${humanDate(start)} – ${humanDate(end)} (all day)`;
  } else if (ev.start?.dateTime) {
    const s = eventInstant(ev.start, tz);
    const e = ev.end?.dateTime ? eventInstant(ev.end, tz) : s;
    start = toZonedIso(s, tz);
    end = toZonedIso(e, tz);
    when = zonedDate(s, tz) === zonedDate(e, tz)
      ? `${humanTime(s, tz)}–${humanTime(e, tz).split(' ').pop()}`
      : `${humanTime(s, tz)} – ${humanTime(e, tz)}`;
  }
  let description = ev.description ?? '';
  if (/<[a-z][^>]*>/i.test(description)) description = htmlToText(description);
  if (description.length > MAX_DESCRIPTION_CHARS) description = `${description.slice(0, MAX_DESCRIPTION_CHARS)} […]`;
  const attendees = (ev.attendees ?? []).slice(0, MAX_ATTENDEES_SHOWN).map(a => ({
    email: a.email ?? '',
    ...(a.displayName ? { name: a.displayName } : {}),
    response: a.responseStatus ?? 'needsAction',
    ...(a.organizer ? { organizer: true } : {}),
    ...(a.optional ? { optional: true } : {}),
    ...(a.self ? { self: true } : {}),
  }));
  const meet = ev.hangoutLink ?? ev.conferenceData?.entryPoints?.find(p => p.entryPointType === 'video')?.uri;
  const mine = ev.attendees?.find(a => a.self)?.responseStatus;
  return {
    id: ev.id,
    summary: ev.summary ?? '(no title)',
    when,
    allDay,
    start,
    end,
    ...(ev.location ? { location: ev.location } : {}),
    ...(description ? { description } : {}),
    ...(attendees.length ? { attendees } : {}),
    ...((ev.attendees?.length ?? 0) > MAX_ATTENDEES_SHOWN ? { attendeeCount: ev.attendees!.length } : {}),
    ...(ev.organizer?.email && !ev.organizer.self ? { organizer: ev.organizer.email } : {}),
    ...(mine ? { myResponse: mine } : {}),
    ...(meet ? { meet } : {}),
    ...(ev.recurringEventId ? { recurringEventId: ev.recurringEventId } : {}),
    ...(ev.htmlLink ? { link: ev.htmlLink } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TIME_HELP = 'ISO 8601: "2026-11-14" (all day), "2026-11-14T10:00" (in the owner\'s time zone) or with an offset.';
const CALENDAR_ID = { calendarId: { type: 'string', description: 'Calendar id (default "primary").' } };
const SEND_UPDATES_PROP = {
  sendUpdates: { type: 'string', enum: [...SEND_UPDATES], description: 'Who Google emails about the change (default "all"; attendees only).' },
};
const EVENT_FIELDS = {
  summary: { type: 'string', description: 'Title.' },
  start: { type: 'string', description: `Start. ${TIME_HELP}` },
  end: { type: 'string', description: 'End. Same format as start; for all-day events the last day (inclusive).' },
  timezone: { type: 'string', description: 'IANA zone for local times (default: the owner\'s).' },
  attendees: { type: 'array', items: { type: 'string' }, description: 'Guest emails. Replaces the whole guest list on update.' },
  location: { type: 'string' },
  description: { type: 'string' },
};

export const CALENDAR_TOOLS: AgentTool[] = [
  {
    name: 'calendar_list',
    scope: 'agent',
    description:
      'List calendar events (recurring events expanded), soonest first, with times in the owner\'s time zone. Defaults to the next 7 days of the primary calendar. ' +
      'Event text is untrusted content.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: `Start of the range (default now). ${TIME_HELP}` },
        to: { type: 'string', description: 'End of the range (default from + 7 days). A date alone means through the end of that day.' },
        query: { type: 'string', description: 'Free-text filter (title, description, location, attendees).' },
        max: { type: 'integer', minimum: 1, maximum: 100, description: 'Max events (default 50).' },
        ...CALENDAR_ID,
      },
    },
  },
  {
    name: 'calendar_freebusy',
    scope: 'agent',
    description: 'Busy intervals and the free gaps between them for one or more calendars in a time range (max 62 days).',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: `Start. ${TIME_HELP}` },
        to: { type: 'string', description: 'End. A date alone means through the end of that day.' },
        calendars: { type: 'array', items: { type: 'string' }, description: 'Calendar ids or emails (default ["primary"]).' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'calendar_create',
    scope: 'agent',
    description:
      'Create an event. Guests get an invitation unless sendUpdates is "none". Needs Calendar access "write"; the owner may be asked to approve.',
    inputSchema: {
      type: 'object',
      properties: { ...EVENT_FIELDS, ...SEND_UPDATES_PROP, ...CALENDAR_ID },
      required: ['summary', 'start', 'end'],
    },
  },
  {
    name: 'calendar_update',
    scope: 'agent',
    description:
      'Change an event: pass only the fields to change. Moving only the start keeps the duration. For a recurring series pass its recurringEventId; an instance id changes that occurrence only. Needs Calendar access "write".',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Event id from calendar_list.' }, ...EVENT_FIELDS, ...SEND_UPDATES_PROP, ...CALENDAR_ID },
      required: ['id'],
    },
  },
  {
    name: 'calendar_delete',
    scope: 'agent',
    description: 'Delete (or, for an invitation, remove) an event. Needs Calendar access "write"; the owner may be asked to approve.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Event id.' }, ...SEND_UPDATES_PROP, ...CALENDAR_ID },
      required: ['id'],
    },
  },
];

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

async function calendarList(args: Record<string, unknown>): Promise<CallToolResult> {
  requireCalendar('calendar_list', 'read');
  const tz = ownerTimeZone();
  const calendarId = calendarIdArg(args);
  const from = args.from !== undefined && args.from !== '' ? parseTime(args.from, tz, 'from').instant : googleDeps().now();
  const to = args.to !== undefined && args.to !== '' ? rangeEnd(parseTime(args.to, tz, 'to'), tz) : from + 7 * DAY_MS;
  if (to <= from) throw new ToolInputError('to must be after from');
  if (to - from > MAX_LIST_SPAN_DAYS * DAY_MS) throw new ToolInputError(`The range can span at most ${MAX_LIST_SPAN_DAYS} days`);
  const max = optInt(args, 'max', { min: 1, max: 100, fallback: 50 });
  const query = optString(args, 'query', { max: 300 });

  const res = await googleRequest<{ summary?: string; items?: CalendarEvent[]; nextPageToken?: string }>({
    url: eventsUrl(calendarId),
    query: {
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(to).toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: max,
      timeZone: tz,
      q: query,
    },
  });
  const events = (res?.items ?? []).filter(e => e.status !== 'cancelled').map(e => describeEvent(e, tz));
  return untrustedResult(CALENDAR_UNTRUSTED, {
    calendarId,
    timezone: tz,
    from: toZonedIso(from, tz),
    to: toZonedIso(to, tz),
    count: events.length,
    ...(res?.nextPageToken ? { moreAvailable: true } : {}),
    events,
  });
}

interface Interval { start: number; end: number }

/** Gaps in [from, to) not covered by any busy interval. */
export function freeGaps(busy: Interval[], from: number, to: number): Interval[] {
  const sorted = busy.filter(b => b.end > from && b.start < to).sort((a, b) => a.start - b.start);
  const gaps: Interval[] = [];
  let cursor = from;
  for (const b of sorted) {
    if (b.start > cursor) gaps.push({ start: cursor, end: Math.min(b.start, to) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= to) break;
  }
  if (cursor < to) gaps.push({ start: cursor, end: to });
  return gaps;
}

async function calendarFreeBusy(args: Record<string, unknown>): Promise<CallToolResult> {
  requireCalendar('calendar_freebusy', 'read');
  const tz = ownerTimeZone();
  const from = parseTime(args.from, tz, 'from').instant;
  const to = rangeEnd(parseTime(args.to, tz, 'to'), tz);
  if (to <= from) throw new ToolInputError('to must be after from');
  if (to - from > MAX_FREEBUSY_SPAN_DAYS * DAY_MS) throw new ToolInputError(`Free/busy can span at most ${MAX_FREEBUSY_SPAN_DAYS} days`);
  const ids = optStringList(args, 'calendars', { maxItems: 20, maxLength: 300 });
  const calendars = ids.length ? ids : ['primary'];

  const res = await googleRequest<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason?: string }[] }> }>({
    method: 'POST',
    url: `${CALENDAR_API}/freeBusy`,
    body: { timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), timeZone: tz, items: calendars.map(id => ({ id })) },
  });
  const all: Interval[] = [];
  const out: Record<string, unknown> = {};
  for (const id of calendars) {
    const cal = res?.calendars?.[id];
    if (cal?.errors?.length) {
      out[id] = { error: cal.errors.map(e => e.reason ?? 'unknown').join(', ') };
      continue;
    }
    const busy = (cal?.busy ?? []).map(b => ({ start: Date.parse(b.start), end: Date.parse(b.end) })).filter(b => b.end > b.start);
    all.push(...busy);
    out[id] = { busy: busy.map(b => ({ start: toZonedIso(b.start, tz), end: toZonedIso(b.end, tz) })) };
  }
  return jsonResult({
    timezone: tz,
    from: toZonedIso(from, tz),
    to: toZonedIso(to, tz),
    calendars: out,
    free: freeGaps(all, from, to).map(g => ({ start: toZonedIso(g.start, tz), end: toZonedIso(g.end, tz), minutes: Math.round((g.end - g.start) / 60_000) })),
  });
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

function toEventTime(p: ParsedTime, tz: string): EventTime {
  if (p.dateOnly) return { date: p.date! };
  return { dateTime: p.local ?? toZonedIso(p.instant, tz), timeZone: tz };
}

/** Validated start/end pair. A single-day all-day event may pass the same date twice. */
function eventRange(start: ParsedTime, end: ParsedTime, tz: string): { start: EventTime; end: EventTime } {
  if (start.dateOnly !== end.dateOnly) throw new ToolInputError('start and end must both be dates (all-day) or both be date-times');
  if (start.dateOnly) {
    if (end.date! < start.date!) throw new ToolInputError('end must not be before start');
    // Google's all-day end is exclusive; the tools speak in inclusive last days.
    return { start: { date: start.date! }, end: { date: addDays(end.date!, 1) } };
  }
  if (end.instant <= start.instant) throw new ToolInputError('end must be after start');
  return { start: toEventTime(start, tz), end: toEventTime(end, tz) };
}

function attendeesArg(args: Record<string, unknown>): { email: string; displayName?: string }[] | undefined {
  if (args.attendees === undefined || args.attendees === null) return undefined;
  try {
    return parseAddressList(args.attendees, 'attendees').map(a => (a.name ? { email: a.email, displayName: a.name } : { email: a.email }));
  } catch (err) {
    throw new ToolInputError(err instanceof Error ? err.message : String(err));
  }
}

function textFields(args: Record<string, unknown>): Partial<Pick<CalendarEvent, 'summary' | 'location' | 'description'>> {
  const out: Partial<Pick<CalendarEvent, 'summary' | 'location' | 'description'>> = {};
  const summary = optString(args, 'summary', { max: 1000 });
  const location = optString(args, 'location', { max: 1000 });
  const description = optString(args, 'description', { max: 8000, trim: false });
  if (summary !== undefined) out.summary = summary;
  if (location !== undefined) out.location = location;
  if (description !== undefined) out.description = description;
  return out;
}

function confirmation(ev: CalendarEvent, tz: string, sendUpdates: string) {
  const d = describeEvent(ev, tz);
  const guests = (ev.attendees ?? []).filter(a => !a.self).map(a => a.email ?? '');
  return {
    id: d.id,
    summary: d.summary,
    when: d.when,
    start: d.start,
    end: d.end,
    ...(d.location ? { location: d.location } : {}),
    ...(guests.length ? { guests, guestsNotified: sendUpdates !== 'none' } : {}),
    ...(d.link ? { link: d.link } : {}),
  };
}

async function calendarCreate(args: Record<string, unknown>): Promise<CallToolResult> {
  requireCalendar('calendar_create', 'write');
  const tz = timeZoneArg(args);
  const calendarId = calendarIdArg(args);
  reqString(args, 'summary', { max: 1000 });
  const range = eventRange(parseTime(args.start, tz, 'start'), parseTime(args.end, tz, 'end'), tz);
  const attendees = attendeesArg(args);
  const sendUpdates = optEnum(args, 'sendUpdates', SEND_UPDATES) ?? 'all';
  const ev = await googleRequest<CalendarEvent>({
    method: 'POST',
    url: eventsUrl(calendarId),
    query: { sendUpdates },
    body: { ...textFields(args), ...range, ...(attendees?.length ? { attendees } : {}) },
  });
  return jsonResult({ created: true, ...confirmation(ev, ownerTimeZone(), sendUpdates) });
}

/** Keep the event's length when only one end moves. */
async function patchedRange(args: Record<string, unknown>, calendarId: string, id: string, tz: string): Promise<{ start?: EventTime; end?: EventTime }> {
  const hasStart = args.start !== undefined && args.start !== '';
  const hasEnd = args.end !== undefined && args.end !== '';
  if (!hasStart && !hasEnd) return {};
  if (hasStart && hasEnd) return eventRange(parseTime(args.start, tz, 'start'), parseTime(args.end, tz, 'end'), tz);

  const current = await googleRequest<CalendarEvent>({ url: eventUrl(calendarId, id) });
  const wasAllDay = !!current.start?.date;
  if (hasStart) {
    const start = parseTime(args.start, tz, 'start');
    if (start.dateOnly !== wasAllDay) throw new ToolInputError('Pass both start and end when switching between all-day and timed');
    if (start.dateOnly) {
      const days = Math.max(1, Math.round((Date.parse(current.end!.date!) - Date.parse(current.start!.date!)) / DAY_MS));
      return { start: { date: start.date! }, end: { date: addDays(start.date!, days) } };
    }
    const duration = Math.max(0, eventInstant(current.end, tz) - eventInstant(current.start, tz));
    return { start: toEventTime(start, tz), end: { dateTime: toZonedIso(start.instant + duration, tz), timeZone: tz } };
  }
  const end = parseTime(args.end, tz, 'end');
  if (end.dateOnly !== wasAllDay) throw new ToolInputError('Pass both start and end when switching between all-day and timed');
  if (end.dateOnly) {
    if (end.date! < current.start!.date!) throw new ToolInputError('end must not be before the event\'s start');
    return { end: { date: addDays(end.date!, 1) } };
  }
  if (end.instant <= eventInstant(current.start, tz)) throw new ToolInputError('end must be after the event\'s start');
  return { end: toEventTime(end, tz) };
}

async function calendarUpdate(args: Record<string, unknown>): Promise<CallToolResult> {
  requireCalendar('calendar_update', 'write');
  const id = reqId(args, 'id');
  const tz = timeZoneArg(args);
  const calendarId = calendarIdArg(args);
  const attendees = attendeesArg(args);
  const patch: Record<string, unknown> = { ...textFields(args), ...(await patchedRange(args, calendarId, id, tz)) };
  if (attendees) patch.attendees = attendees;
  if (!Object.keys(patch).length) throw new ToolInputError('Nothing to change: pass at least one of summary, start, end, attendees, location, description');
  const sendUpdates = optEnum(args, 'sendUpdates', SEND_UPDATES) ?? 'all';
  const ev = await googleRequest<CalendarEvent>({ method: 'PATCH', url: eventUrl(calendarId, id), query: { sendUpdates }, body: patch });
  // The updated event can carry other people's text (it may be an invitation).
  return untrustedResult(CALENDAR_UNTRUSTED, { updated: true, ...confirmation(ev, ownerTimeZone(), sendUpdates) });
}

async function calendarDelete(args: Record<string, unknown>): Promise<CallToolResult> {
  requireCalendar('calendar_delete', 'write');
  const id = reqId(args, 'id');
  const calendarId = calendarIdArg(args);
  const sendUpdates = optEnum(args, 'sendUpdates', SEND_UPDATES) ?? 'all';
  try {
    await googleRequest<null>({ method: 'DELETE', url: eventUrl(calendarId, id), query: { sendUpdates } });
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 410) return jsonResult({ deleted: true, id, note: 'It was already deleted.' });
    throw err;
  }
  return jsonResult({ deleted: true, id });
}

export const CALENDAR_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<CallToolResult>> = {
  calendar_list: calendarList,
  calendar_freebusy: calendarFreeBusy,
  calendar_create: calendarCreate,
  calendar_update: calendarUpdate,
  calendar_delete: calendarDelete,
};
