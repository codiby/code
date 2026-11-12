/**
 * Phone numbers and WhatsApp JIDs.
 *
 * The owner is in Mexico, so a bare 10-digit number is Mexican unless it
 * starts with `+`/`00` and a country code. WhatsApp keeps the legacy mobile
 * `1` in Mexican JIDs (`52 1 6677805604`), while E.164 phone numbers drop it
 * (`+52 6677805604`) — both forms of the same number must normalise to one
 * canonical value, or lookups by handle miss and the owner gets paired twice.
 *
 * packages/ui/src/lib/agent/memory.ts carries a copy of `phoneToWhatsAppJid`
 * for the Persona form; memory.test.ts checks the two agree.
 */

export const DEFAULT_COUNTRY_CODE = '52';
const MEXICO = '52';

/** E.164 allows at most 15 digits; anything under 8 is not a dialable number. */
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

interface ParsedNumber {
  country: string;
  national: string;
}

/**
 * Split a typed number into country code + national number. Only Mexico's
 * shape is known precisely; other countries keep their digits as typed.
 */
function parseNumber(input: string, defaultCountry: string): ParsedNumber | null {
  const trimmed = input.trim();
  if (!trimmed || /[a-z@]/i.test(trimmed)) return null;
  let digits = trimmed.replace(/\D/g, '');
  let international = trimmed.startsWith('+');
  if (!international && digits.startsWith('00')) {
    digits = digits.slice(2);
    international = true;
  }
  if (!digits) return null;

  if (!international) {
    // Pre-2019 Mexican dialling prefixes: 044/045 (mobile) and 01 (long distance).
    if (digits.length === 13 && /^04[45]/.test(digits)) digits = digits.slice(3);
    else if (digits.length === 12 && digits.startsWith('01')) digits = digits.slice(2);
    if (digits.length === 10) return { country: defaultCountry, national: digits };
  }

  if (digits.startsWith(MEXICO)) {
    const rest = digits.slice(MEXICO.length);
    if (rest.length === 11 && rest.startsWith('1')) return { country: MEXICO, national: rest.slice(1) };
    if (rest.length === 10) return { country: MEXICO, national: rest };
  }
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;
  // Unknown country layout: keep the full international number as one unit.
  return { country: '', national: digits };
}

/** E.164 (`+526677805604`), or null when `input` isn't a phone number. */
export function normalizePhone(input: string, defaultCountry = DEFAULT_COUNTRY_CODE): string | null {
  const p = parseNumber(input, defaultCountry);
  if (!p) return null;
  const full = `${p.country}${p.national}`;
  if (full.length < MIN_DIGITS || full.length > MAX_DIGITS) return null;
  return `+${full}`;
}

/** WhatsApp user JID for a phone number: `6677805604` → `5216677805604@s.whatsapp.net`. */
export function phoneToWhatsAppJid(input: string, defaultCountry = DEFAULT_COUNTRY_CODE): string | null {
  const p = parseNumber(input, defaultCountry);
  if (!p) return null;
  const user = p.country === MEXICO ? `${MEXICO}1${p.national}` : `${p.country}${p.national}`;
  if (user.length < MIN_DIGITS || user.length > MAX_DIGITS + 1) return null;
  return `${user}@s.whatsapp.net`;
}

/**
 * Canonical WhatsApp handle: phone numbers and `@s.whatsapp.net` / `@c.us`
 * JIDs become `<digits>@s.whatsapp.net` (device suffixes like `:12` dropped);
 * privacy ids (`@lid`) and groups (`@g.us`) are kept as they are.
 */
export function normalizeWhatsAppHandle(input: string, defaultCountry = DEFAULT_COUNTRY_CODE): string | null {
  const s = input.trim().toLowerCase();
  const jid = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|c\.us)$/.exec(s);
  if (jid) return phoneToWhatsAppJid(`+${jid[1]}`, defaultCountry);
  if (/^\d+(?::\d+)?@lid$/.test(s)) return s.replace(/:\d+@/, '@');
  if (/^[\d-]+@g\.us$/.test(s)) return s;
  return phoneToWhatsAppJid(input, defaultCountry);
}

/** Last 10 digits — enough to match the same number written with or without country code. */
export function phoneTail(input: string): string {
  const digits = input.replace(/@.*$/, '').replace(/\D/g, '');
  return digits.slice(-10);
}
