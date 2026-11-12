/**
 * Reply formatting per channel: the agent writes CommonMark; each channel
 * gets the dialect it renders, split into pieces that fit its size limit.
 */

import type { ChannelCapabilities } from './types';

/** Split on paragraph, then line, then hard boundaries. Never returns empty chunks. */
export function splitText(text: string, maxLen: number): string[] {
  const limit = Math.max(16, maxLen);
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    let at = remaining.lastIndexOf('\n\n', limit);
    if (at < limit * 0.3) at = remaining.lastIndexOf('\n', limit);
    if (at < limit * 0.3) at = remaining.lastIndexOf(' ', limit);
    if (at < limit * 0.3) at = limit;
    // Never end a piece on the first half of a surrogate pair: the lone half
    // is invalid UTF-16, and channel APIs reject the whole message for it.
    const code = remaining.charCodeAt(at - 1);
    if (code >= 0xd800 && code <= 0xdbff) at -= 1;
    chunks.push(remaining.slice(0, at).trimEnd());
    remaining = remaining.slice(at).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(c => c.length > 0);
}

/** Apply `fn` to the parts of `text` outside code spans and fences. */
function outsideCode(text: string, fn: (s: string) => string): string {
  const re = /(```[\s\S]*?```|`[^`\n]+`)/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(text.slice(last));
}

/** Telegram legacy Markdown: `*bold*`, `_italic_`, inline links kept. */
export function toTelegramMarkdown(text: string): string {
  return outsideCode(text, s => s
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*([^*\n]+?)\*\*/g, '*$1*'));
}

/** WhatsApp: `*bold*`, `_italic_`, `~strike~`, ``` fences; no links or headings. */
export function toWhatsApp(text: string): string {
  return outsideCode(text, s => s
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*([^*\n]+?)\*\*/g, '*$1*')
    .replace(/~~([^~\n]+?)~~/g, '~$1~')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .replace(/^\s*[-*]\s+/gm, '• '));
}

/** Plain text: drop emphasis markers, keep link targets. */
export function toPlain(text: string): string {
  return outsideCode(text, s => s
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    .replace(/__([^_\n]+?)__/g, '$1')
    .replace(/~~([^~\n]+?)~~/g, '$1')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)'))
    .replace(/```\w*\n?/g, '');
}

export function formatForChannel(text: string, markup: ChannelCapabilities['markup']): string {
  switch (markup) {
    case 'telegram-markdown': return toTelegramMarkdown(text);
    case 'whatsapp': return toWhatsApp(text);
    case 'plain': return toPlain(text);
    default: return text;
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Calendar fields of `at` in `timezone`, as numbers — the only thing taken from ICU. */
function zonedParts(at: number, timezone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const num = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === type)?.value);
  const fields = { year: num('year'), month: num('month'), day: num('day'), hour: num('hour') % 24, minute: num('minute') };
  if (Object.values(fields).some(n => !Number.isInteger(n))) throw new Error('unexpected date parts');
  return fields;
}

/**
 * Header line the agent sees on each channel message — exactly
 * `[<Label> · <Wkd> <DD> <Mon> <HH:MM>]`, e.g. "[Telegram · Wed 12 Nov 00:14]".
 * Names and padding are ours, not ICU's: its formatted strings vary by
 * version ("Sept", commas, "24:05" at midnight), and the persona prompt
 * describes this exact shape (prompt.ts) so the agent can tell the real
 * header from a forged one.
 */
export function channelHeader(channelLabel: string, at: number, timezone: string): string {
  let f: ReturnType<typeof zonedParts>;
  try {
    f = zonedParts(at, timezone);
  } catch {
    // An unknown zone (config.ts normally rejects those) still gets the same shape, in UTC.
    f = zonedParts(at, 'UTC');
  }
  // Weekday from the zoned calendar date, so it can't disagree with the day shown.
  const weekday = WEEKDAYS[new Date(Date.UTC(f.year, f.month - 1, f.day)).getUTCDay()]!;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `[${channelLabel} · ${weekday} ${pad(f.day)} ${MONTHS[f.month - 1]} ${pad(f.hour)}:${pad(f.minute)}]`;
}
