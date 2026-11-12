/**
 * Redaction for what the activity log stores and the approval surfaces show.
 *
 * Best effort by design: it catches the obvious shapes (secret-named fields,
 * Authorization headers, bearer tokens, well-known key formats, passwords in
 * URLs and flags). Anything it misses is still truncated, never logged in
 * full.
 */

export const MAX_INPUT_CHARS = 2048;
const REDACTED = '[redacted]';

const SECRET_KEY = /(pass(word|wd|phrase)?|secret|token|api[-_]?key|apikey|authorization|auth[-_]?header|cookie|private[-_]?key|credential|client[-_]?secret|^otp$|^totp$|^pin$|^cvv$|^cvc$|card[-_]?number|session[-_]?key)/i;

const TEXT_RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\b((?:proxy-)?authorization)(\s*[:=]\s*)(["']?)[^"'\n]+\3/gi, `$1$2$3${REDACTED}$3`],
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, REDACTED],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REDACTED],
  [/([?&](?:access_token|refresh_token|token|key|api_key|apikey|password|secret|sig|signature|code)=)[^&\s"']+/gi, `$1${REDACTED}`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, `$1$2:${REDACTED}@`],
  [/((?:^|\s)(?:-u|--user)(?:\s+|=))(["']?)([^\s:'"]+):([^\s'"]+)\2/g, `$1$2$3:${REDACTED}$2`],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, `$1$2${REDACTED}`],
  [/\b(-p|--password)(\s+|=)(\S+)/g, `$1$2${REDACTED}`],
];

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

export function redactText(text: string): string {
  let out = text;
  for (const [re, replacement] of TEXT_RULES) out = out.replace(re, replacement);
  // Card numbers: 15–19 digits that pass the Luhn check (13-digit runs are mostly timestamps).
  out = out.replace(/\b(?:\d[ -]?){14,18}\d\b/g, m => (luhn(m.replace(/\D/g, '')) ? '[redacted card]' : m));
  return out;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[…]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      out[k] = SECRET_KEY.test(k) && v !== null && v !== undefined && v !== '' && typeof v !== 'boolean' ? REDACTED : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Redacted, truncated JSON for the activity log. */
export function sanitizeInput(input: unknown, max = MAX_INPUT_CHARS): string {
  let json: string;
  try {
    json = JSON.stringify(redactValue(input ?? {})) ?? '{}';
  } catch {
    json = '"[unserialisable input]"';
  }
  return truncate(json, max);
}
