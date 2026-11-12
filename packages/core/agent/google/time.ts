/**
 * Time-zone arithmetic for the Calendar tools. The model speaks in the
 * owner's local time ("2026-11-14T10:00"), Google wants instants or
 * (local time + zone) pairs, and Bun has no Temporal yet — so this converts
 * with Intl only, handling DST gaps and overlaps the way Google does.
 */

import { loadAgentConfig } from '../config';

/** The owner's zone (persona.timezone), or UTC when it was hand-edited into something invalid. */
export function ownerTimeZone(): string {
  const tz = loadAgentConfig().persona.timezone;
  return tz && isValidTimeZone(tz) ? tz : 'UTC';
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

/** Wall-clock fields of `instant` in `tz`. */
export function zonedParts(instant: number, tz: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const map: Record<string, number> = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(instant))) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  return { year: map.year!, month: map.month!, day: map.day!, hour: map.hour! % 24, minute: map.minute!, second: map.second! };
}

/** Offset of `tz` from UTC at `instant`, in ms (positive east of Greenwich). */
export function zoneOffsetMs(instant: number, tz: string): number {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time in `tz` refers to. An ambiguous time (DST
 * fall-back) resolves to its first occurrence; a time that doesn't exist
 * (spring-forward gap) moves forward, as Google Calendar does.
 */
export function zonedToInstant(year: number, month: number, day: number, hour: number, minute: number, second: number, tz: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const guessOffset = zoneOffsetMs(wall, tz);
  const t1 = wall - guessOffset;
  const t1Offset = zoneOffsetMs(t1, tz);
  if (t1Offset === guessOffset) return t1;
  const t2 = wall - t1Offset;
  if (zoneOffsetMs(t2, tz) === t1Offset) return t2;
  return Math.max(t1, t2);
}

export interface ParsedTime {
  /** Absolute instant (start of day in `tz` for date-only input). */
  instant: number;
  dateOnly: boolean;
  /** 'YYYY-MM-DD' when dateOnly. */
  date?: string;
  /** Local wall-clock 'YYYY-MM-DDTHH:mm:ss' when the input had no offset. */
  local?: string;
  /** The input carried Z or ±HH:MM. */
  hasOffset: boolean;
}

const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Parse 'YYYY-MM-DD', 'YYYY-MM-DDTHH:mm[:ss]' (local to `tz`) or a full ISO 8601 timestamp. */
export function parseTimeInput(input: unknown, tz: string, field: string): ParsedTime {
  if (typeof input !== 'string' || !input.trim()) throw new Error(`${field} is required (e.g. 2026-11-14 or 2026-11-14T10:00)`);
  const m = input.trim().match(TIME_RE);
  if (!m) throw new Error(`${field} must be ISO 8601, e.g. 2026-11-14 or 2026-11-14T10:00 (got "${input.slice(0, 40)}")`);
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`${field} is not a real date: ${input}`);
  }
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (m[4] === undefined) {
    return { instant: zonedToInstant(year, month, day, 0, 0, 0, tz), dateOnly: true, date, hasOffset: false };
  }
  const [hour, minute, second] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (hour > 23 || minute > 59 || second > 59) throw new Error(`${field} has an invalid time: ${input}`);
  const offset = m[7];
  if (offset) {
    let offsetMs = 0;
    if (offset.toUpperCase() !== 'Z') {
      const om = offset.match(/^([+-])(\d{2}):?(\d{2})$/)!;
      offsetMs = (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3])) * 60_000;
    }
    return { instant: Date.UTC(year, month - 1, day, hour, minute, second) - offsetMs, dateOnly: false, hasOffset: true };
  }
  const local = `${date}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
  return { instant: zonedToInstant(year, month, day, hour, minute, second, tz), dateOnly: false, local, hasOffset: false };
}

/** 'YYYY-MM-DD' of `instant` in `tz`. */
export function zonedDate(instant: number, tz: string): string {
  const p = zonedParts(instant, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** Add whole days to a 'YYYY-MM-DD' date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** RFC 3339 with the zone's offset, e.g. '2026-11-14T10:00:00-06:00'. */
export function toZonedIso(instant: number, tz: string): string {
  const p = zonedParts(instant, tz);
  const off = Math.round(zoneOffsetMs(instant, tz) / 60_000);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const humanFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * 'Fri 14 Nov 10:00' in `tz`. Assembled from parts because the locale's own
 * pattern differs between ICU versions ("Fri 14 Nov, 10:00" vs "… at 10:00").
 */
export function humanTime(instant: number, tz: string, opts: { withTime?: boolean } = {}): string {
  let f = humanFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    humanFormatters.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(instant))) p[part.type] = part.value;
  const date = `${p.weekday} ${p.day} ${p.month}`;
  return opts.withTime === false ? date : `${date} ${p.hour}:${p.minute}`;
}
