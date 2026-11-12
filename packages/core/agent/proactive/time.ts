/**
 * Wall-clock arithmetic in an IANA zone, with nothing but Intl — quiet
 * hours, "today" for the daily message cap, and local reminder times all
 * have to agree with the owner's clock, not the host's.
 */

import type { QuietHours } from '../config';

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(timezone, f);
  }
  return f;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    formatter(timezone);
    return true;
  } catch {
    return false;
  }
}

export function localParts(ts: number, timezone: string): LocalParts {
  const out: Record<string, number> = {};
  for (const part of formatter(timezone).formatToParts(new Date(ts))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out.year!, month: out.month!, day: out.day!,
    // Some engines render midnight as "24" even with h23.
    hour: out.hour === 24 ? 0 : out.hour!, minute: out.minute!, second: out.second!,
  };
}

/** "YYYY-MM-DD" of `ts` on the owner's calendar. */
export function localDayKey(ts: number, timezone: string): string {
  const p = localParts(ts, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Offset of `timezone` from UTC at instant `ts`, in ms (positive east of Greenwich). */
function offsetAt(ts: number, timezone: string): number {
  const p = localParts(ts, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/**
 * The instant a local wall-clock time names in `timezone`. Two passes cover
 * DST: the first guess's offset can be the other side of a transition.
 */
export function zonedTimeToUtc(
  local: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
  timezone: string,
): number {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second ?? 0);
  let ts = naive - offsetAt(naive, timezone);
  ts = naive - offsetAt(ts, timezone);
  return ts;
}

const LOCAL_ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** "2026-11-12T09:30" (no offset) read as local time in `timezone`, or null. */
export function parseLocalIso(value: string, timezone: string): number | null {
  const m = LOCAL_ISO.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ts = zonedTimeToUtc({ year: +y!, month: +mo!, day: +d!, hour: +h!, minute: +mi!, second: s ? +s : 0 }, timezone);
  return Number.isFinite(ts) ? ts : null;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h! % 24) * 60 + (m! % 60);
}

/**
 * Inside quiet hours at `ts`? The window may wrap midnight (23:00–07:00);
 * a window that starts and ends at the same minute is empty, not all day.
 */
export function isQuietTime(quiet: QuietHours, timezone: string, ts: number): boolean {
  if (!quiet.enabled) return false;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === end) return false;
  const p = localParts(ts, timezone);
  const now = p.hour * 60 + p.minute;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** When the quiet window containing `ts` ends, or null when `ts` is not in one. */
export function quietEndsAt(quiet: QuietHours, timezone: string, ts: number): number | null {
  if (!isQuietTime(quiet, timezone, ts)) return null;
  const p = localParts(ts, timezone);
  const now = p.hour * 60 + p.minute;
  const end = minutesOf(quiet.end);
  const minutesLeft = (end - now + 1440) % 1440 || 1440;
  // Step from the start of the current minute; then snap to the zone's own
  // reading of the end time so a DST change inside the window can't skew it.
  const approx = ts - p.second * 1000 - (ts % 1000) + minutesLeft * 60_000;
  const q = localParts(approx, timezone);
  const snapped = zonedTimeToUtc({ year: q.year, month: q.month, day: q.day, hour: Math.floor(end / 60), minute: end % 60 }, timezone);
  // In the hour a fall-back repeats, the end's wall time names two instants
  // and the snap takes the first — already past on the second pass, which
  // re-armed the held-notification flush every second until the real end.
  // No transition lies ahead then, so the straight step is exact.
  return snapped > ts ? snapped : approx;
}

/** "Wed 12 Nov 09:30" in `timezone`, for the model and for run summaries. */
export function formatLocal(ts: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ts)).replace(',', '');
  } catch {
    return new Date(ts).toISOString();
  }
}

/** ISO-8601 with the zone's own offset, e.g. "2026-11-12T09:30:00-06:00". */
export function isoInZone(ts: number, timezone: string): string {
  const p = localParts(ts, timezone);
  const offsetMin = Math.round(offsetAt(ts, timezone) / 60_000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
