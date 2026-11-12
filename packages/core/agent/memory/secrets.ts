/**
 * Keeps secrets out of memory. Everything in memory is pasted into the
 * agent's system prompt and returned by `recall`, so a password saved here
 * would travel to the model provider on every turn. Secrets belong in the
 * encrypted vault (Agent → Connections).
 *
 * Deliberately conservative: it only flags labelled values ("password: …"),
 * well-known credential formats and card numbers, so ordinary facts that
 * merely mention a password ("changes his passwords every month", "the token
 * is valid until May") still save.
 */

// Bare "secret" and "clave" are left out on purpose: "secret: grandma's
// surprise party" and "clave: llegar temprano" are ordinary notes.
const SECRET_LABEL = String.raw`(?:passwords?|passwd|pwd|passcode|contrase(?:ñ|n)as?|clave\s+(?:de\s+acceso|secreta)|nip|pin|cvv|cvc|api[\s_-]?key|(?:client[\s_-]?)?secret[\s_-]?key|client[\s_-]?secret|access[\s_-]?token|auth[\s_-]?token|token|otp)`;

/** "password: hunter2", "PIN=4821", "api key = sk…" — a value assigned to a label is always a secret. */
const LABEL_ASSIGNED = new RegExp(String.raw`(?<![\p{L}\p{N}])${SECRET_LABEL}\s*[:=]\s*["'\x60]?[^\s"'\x60]{4,}`, 'iu');

/**
 * "my password is …", "el NIP de la tarjeta es …", "password for gmail: …" —
 * up to three words between label and value, so only a secret when the value
 * looks like one (see below).
 */
const LABEL_STATED = new RegExp(String.raw`(?<![\p{L}\p{N}])${SECRET_LABEL}(?:\s+[\p{L}\p{N}]{1,15}){0,3}?\s*(?:\s(?:is|was|es|era)\s|[:=])\s*(\S+)`, 'giu');

/**
 * A stated value is treated as a credential when it is quoted, or mixes
 * letters with digits/symbols ("hunter2", "4821", "p@ss") — plain words such
 * as "valid", "required" or "única" are what people write in notes.
 */
function looksLikeCredential(raw: string): boolean {
  if (/^["'\x60][^"'\x60\s]{4,}/.test(raw)) return true;
  const v = raw.replace(/[.,;:!?)\]]+$/u, '');
  if (v.length < 4) return false;
  return /\p{N}/u.test(v) || /[^\p{L}\p{N}]/u.test(v) || /\p{Ll}\p{Lu}/u.test(v);
}

function hasLabelledSecret(text: string): boolean {
  if (LABEL_ASSIGNED.test(text)) return true;
  for (const m of text.matchAll(LABEL_STATED)) {
    if (looksLikeCredential(m[1] ?? '')) return true;
  }
  return false;
}

const CREDENTIAL_FORMATS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, // Anthropic / OpenAI
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/, // Telegram bot token
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
];

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * 16-digit cards (Visa, Mastercard…) and 15-digit Amex only: 13-digit
 * Mexican WhatsApp numbers (521…) would pass Luhn one time in ten.
 */
function hasCardNumber(text: string): boolean {
  const candidates = text.match(/\b(?:\d[ -]?){14,15}\d\b/g) ?? [];
  return candidates.some(c => {
    const digits = c.replace(/\D/g, '');
    const shaped = (digits.length === 16 && /^[2-6]/.test(digits)) || (digits.length === 15 && /^3[47]/.test(digits));
    return shaped && luhnValid(digits);
  });
}

/** A short reason when `text` looks like it contains a secret, else null. */
export function detectSecret(text: string): string | null {
  if (hasLabelledSecret(text)) return 'it looks like a password, PIN or key';
  if (CREDENTIAL_FORMATS.some(re => re.test(text))) return 'it looks like an API key or token';
  if (hasCardNumber(text)) return 'it looks like a card number';
  return null;
}

export const VAULT_HINT =
  'Secrets never go in memory — memory is shown to the model on every turn. Ask the owner to save it in the Agent → Connections tab (encrypted vault).';
