/**
 * Wall-clock times in an IANA zone without a date library: the daily
 * rotation runs at "04:00 in the owner's timezone", which is a different
 * instant on either side of a DST change.
 */

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `tz` if Intl knows it, else UTC — a typo in the persona must not stop the scheduler. */
export function safeTimeZone(tz: string | null | undefined): string {
  return tz && isValidTimeZone(tz) ? tz : 'UTC';
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function localParts(epochMs: number, tz: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { year: out.year!, month: out.month!, day: out.day!, hour: out.hour! % 24, minute: out.minute!, second: out.second! };
}

/** Offset of `tz` from UTC at `epochMs`, in ms (UTC-7 → -25 200 000). */
function offsetAt(epochMs: number, tz: string): number {
  const p = localParts(epochMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * The instant when the wall clock in `tz` reads `y-m-d hh:mm`. In a DST gap
 * (02:30 on a spring-forward night) this lands just after the jump, which is
 * what a "run at 02:30" schedule should do.
 */
export function zonedEpoch(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // The zone's offset at the guess can differ from the one at the answer near
  // a DST change, so try both and keep the one whose wall clock matches.
  const first = guess - offsetAt(guess, tz);
  const second = guess - offsetAt(first, tz);
  for (const ts of [first, second]) {
    const p = localParts(ts, tz);
    if (p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute) return ts;
  }
  // Neither matches: the time falls in a spring-forward gap. Take the later candidate (after the jump).
  return Math.max(first, second);
}

function parseHHMM(time: string): { hour: number; minute: number } {
  const [h, m] = time.split(':').map(Number);
  return { hour: h ?? 0, minute: m ?? 0 };
}

/** Calendar day `delta` days from the given local date (handles month/year rollover). */
function shiftDay(p: { year: number; month: number; day: number }, delta: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + delta));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Today's (or yesterday's) `time` in `tz` — the most recent occurrence at or before `now`. */
export function latestSlot(now: number, time: string, tz: string): number {
  const { hour, minute } = parseHHMM(time);
  const today = localParts(now, tz);
  const slot = zonedEpoch(today.year, today.month, today.day, hour, minute, tz);
  if (slot <= now) return slot;
  const y = shiftDay(today, -1);
  return zonedEpoch(y.year, y.month, y.day, hour, minute, tz);
}

/** The next occurrence of `time` in `tz` strictly after `now`. */
export function nextSlot(now: number, time: string, tz: string): number {
  const { hour, minute } = parseHHMM(time);
  const today = localParts(now, tz);
  const slot = zonedEpoch(today.year, today.month, today.day, hour, minute, tz);
  if (slot > now) return slot;
  const t = shiftDay(today, 1);
  return zonedEpoch(t.year, t.month, t.day, hour, minute, tz);
}
