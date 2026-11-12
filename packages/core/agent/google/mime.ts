/**
 * Email plumbing for the Gmail tools: building RFC 2822 messages (with RFC
 * 2047 encoded headers and threading headers for replies), parsing address
 * lists, and turning Gmail's MIME payload trees back into readable text.
 *
 * Everything that ends up in a header is checked for CR/LF first — the model
 * writes these fields, and a stray newline would let it (or an email it read)
 * smuggle in extra headers such as a Bcc.
 */

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

export function base64UrlEncode(input: string | Uint8Array): string {
  return Buffer.from(input).toString('base64url');
}

export function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * RFC 2047 "B" encoding for a header value that isn't plain ASCII. Each
 * encoded word stays within 75 characters and never splits a UTF-8 sequence,
 * so mail clients can decode every word on its own.
 */
export function encodeHeaderValue(value: string): string {
  if (PRINTABLE_ASCII.test(value) && !value.includes('=?')) return value;
  const MAX_BYTES = 45; // 45 bytes → 60 base64 chars → 72-char encoded word
  const words: string[] = [];
  let chunk: number[] = [];
  for (const ch of value) {
    const bytes = Buffer.from(ch, 'utf8');
    if (chunk.length + bytes.length > MAX_BYTES) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
      chunk = [];
    }
    chunk.push(...bytes);
  }
  if (chunk.length) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
  return words.join('\r\n ');
}

/** Decode RFC 2047 encoded words (B and Q) if a header still carries them. */
export function decodeEncodedWords(value: string): string {
  if (!value.includes('=?')) return value;
  return value
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, enc: string, text: string) => {
      try {
        const bytes = enc.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(
              text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
              'latin1',
            );
        return decodeBytes(bytes, charset);
      } catch {
        return whole;
      }
    });
}

export function decodeBytes(bytes: Uint8Array, charset: string | null | undefined): string {
  const label = (charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Reject anything that could end a header line. */
function assertSingleLine(field: string, value: string): void {
  if (/[\r\n\0]/.test(value)) throw new Error(`${field} must be a single line`);
}

/** Join items into one header, folding between items to keep lines short. */
function foldHeader(name: string, items: string[], separator: string): string {
  let line = `${name}: `;
  const lines: string[] = [];
  items.forEach((item, i) => {
    const piece = i < items.length - 1 ? `${item}${separator}` : item;
    if (line.length + piece.length > 76 && line.trim() !== `${name}:`) {
      lines.push(line.trimEnd());
      line = ' ';
    }
    line += piece;
  });
  lines.push(line);
  return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export interface EmailAddress {
  name?: string;
  email: string;
}

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** Split "a@x.com, "Doe, Jane" <j@y.com>" on commas outside quotes and angle brackets. */
function splitAddressList(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (const ch of input) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<' && !quoted) angle = true;
    else if (ch === '>' && !quoted) angle = false;
    if ((ch === ',' || ch === ';') && !quoted && !angle) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function parseAddress(raw: string): EmailAddress {
  const s = raw.trim();
  const angled = s.match(/^(.*?)\s*<([^<>]+)>$/);
  if (angled) {
    const email = angled[2]!.trim();
    if (!EMAIL_RE.test(email)) throw new Error(`Not a valid email address: ${email}`);
    const name = angled[1]!.trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1').trim();
    return name ? { name, email } : { email };
  }
  if (!EMAIL_RE.test(s)) throw new Error(`Not a valid email address: ${s}`);
  return { email: s };
}

/** Accepts a comma-separated string or an array of strings. */
export function parseAddressList(input: unknown, field: string): EmailAddress[] {
  if (input === undefined || input === null || input === '') return [];
  const parts = Array.isArray(input) ? input : [input];
  const out: EmailAddress[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') throw new Error(`${field} must be a string or a list of strings`);
    assertSingleLine(field, part);
    for (const item of splitAddressList(part)) out.push(parseAddress(item));
  }
  if (out.length > 50) throw new Error(`${field}: at most 50 recipients`);
  return out;
}

export function formatAddress(a: EmailAddress): string {
  if (!a.name) return a.email;
  if (!PRINTABLE_ASCII.test(a.name)) return `${encodeHeaderValue(a.name)} <${a.email}>`;
  // RFC 5322 specials force a quoted string.
  const needsQuotes = /[()<>[\]:;@\\,."]/.test(a.name);
  const name = needsQuotes ? `"${a.name.replace(/(["\\])/g, '\\$1')}"` : a.name;
  return `${name} <${a.email}>`;
}

// ---------------------------------------------------------------------------
// Message building
// ---------------------------------------------------------------------------

export interface OutgoingEmail {
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  body: string;
  /** Message-ID of the message being answered, angle brackets included. */
  inReplyTo?: string;
  /** Full reference chain of the thread, oldest first. */
  references?: string[];
}

const MESSAGE_ID_RE = /^<[^<>\s]+>$/;

/** Build an RFC 2822 message: UTF-8 text/plain, base64 body, CRLF line ends. */
export function buildMimeMessage(msg: OutgoingEmail): string {
  assertSingleLine('Subject', msg.subject);
  const headers: string[] = [];
  if (msg.to.length) headers.push(foldHeader('To', msg.to.map(formatAddress), ', '));
  if (msg.cc?.length) headers.push(foldHeader('Cc', msg.cc.map(formatAddress), ', '));
  if (msg.bcc?.length) headers.push(foldHeader('Bcc', msg.bcc.map(formatAddress), ', '));
  headers.push(`Subject: ${encodeHeaderValue(msg.subject)}`);
  if (msg.inReplyTo && MESSAGE_ID_RE.test(msg.inReplyTo)) {
    headers.push(`In-Reply-To: ${msg.inReplyTo}`);
    const refs = (msg.references ?? []).filter(r => MESSAGE_ID_RE.test(r));
    if (!refs.includes(msg.inReplyTo)) refs.push(msg.inReplyTo);
    // Long threads: keep the root and the most recent ids, as RFC 5322 §3.6.4 suggests.
    const trimmed = refs.length > 20 ? [refs[0]!, ...refs.slice(-19)] : refs;
    headers.push(foldHeader('References', trimmed, ' '));
  }
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push('Content-Transfer-Encoding: base64');

  const body = msg.body.replace(/\r?\n/g, '\r\n');
  const encoded = (Buffer.from(body, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${encoded}\r\n`;
}

/** "Re: <subject>" without stacking prefixes. */
export function replySubject(original: string): string {
  const s = original.trim();
  return /^(re|aw|sv|antw)\s*:/i.test(s) ? s : `Re: ${s}`;
}

/** Message-IDs in a References / In-Reply-To header value. */
export function parseMessageIds(value: string | undefined | null): string[] {
  return value ? value.match(/<[^<>\s]+>/g) ?? [] : [];
}

// ---------------------------------------------------------------------------
// HTML → text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü',
  iexcl: '¡', iquest: '¿', zwnj: '', zwj: '', shy: '',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ent] ?? NAMED_ENTITIES[ent.toLowerCase()] ?? whole;
  });
}

/** Good-enough HTML → text for reading email: keeps paragraphs, list items and link targets. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a\b[^>]*?href\s*=\s*(["'])(https?:[^"']+)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, _q, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, '').trim();
      const target = decodeEntities(href);
      return label && decodeEntities(label) !== target ? `${label} (${target})` : target;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|tr|li|ul|ol|table|h[1-6]|blockquote|section|article|header|footer)\s*>/gi, '\n')
    .replace(/<(p|div|tr|table|h[1-6]|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s)
    .replace(/[\u00a0\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// ---------------------------------------------------------------------------
// Gmail payload → text
// ---------------------------------------------------------------------------

export interface GmailHeader { name: string; value: string }

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  const h = headers?.find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? decodeEncodedWords(h.value) : '';
}

function charsetOf(part: GmailPart): string | null {
  const ct = headerValue(part.headers, 'Content-Type');
  const m = ct.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return m ? m[1]! : null;
}

function isAttachment(part: GmailPart): boolean {
  if (part.filename) return true;
  return /^\s*attachment\b/i.test(headerValue(part.headers, 'Content-Disposition'));
}

function partText(part: GmailPart): string {
  const data = part.body?.data;
  return data ? decodeBytes(base64UrlDecode(data), charsetOf(part)) : '';
}

export interface AttachmentInfo {
  name: string;
  mimeType: string;
  size: number;
}

interface Collected {
  plain: string[];
  html: string[];
}

function collect(part: GmailPart, attachments: AttachmentInfo[]): Collected {
  const type = (part.mimeType ?? '').toLowerCase();
  if (part.parts?.length) {
    const children = part.parts.map(p => ({ part: p, got: collect(p, attachments) }));
    if (type === 'multipart/alternative') {
      // One rendering of the same content: the plain one if any, else the richest (last) HTML.
      const plain = children.find(c => c.got.plain.some(t => t.trim()));
      if (plain) return { plain: plain.got.plain, html: [] };
      const html = [...children].reverse().find(c => c.got.html.some(t => t.trim()));
      return { plain: [], html: html ? html.got.html : [] };
    }
    return {
      plain: children.flatMap(c => c.got.plain),
      html: children.flatMap(c => c.got.html),
    };
  }
  if (isAttachment(part)) {
    attachments.push({
      name: part.filename || '(unnamed)',
      mimeType: part.mimeType || 'application/octet-stream',
      size: part.body?.size ?? 0,
    });
    return { plain: [], html: [] };
  }
  if (type === 'text/plain') return { plain: [partText(part)], html: [] };
  if (type === 'text/html') return { plain: [], html: [partText(part)] };
  return { plain: [], html: [] };
}

export interface ExtractedBody {
  text: string;
  format: 'plain' | 'html' | 'none';
  truncated: boolean;
  attachments: AttachmentInfo[];
}

/** Readable body of a Gmail message: text/plain preferred, else HTML stripped to text. */
export function extractMessageBody(payload: GmailPart | undefined, maxChars = 20_000): ExtractedBody {
  const attachments: AttachmentInfo[] = [];
  if (!payload) return { text: '', format: 'none', truncated: false, attachments };
  const got = collect(payload, attachments);
  const plain = got.plain.map(t => t.replace(/\r\n/g, '\n').trim()).filter(Boolean);
  let text = '';
  let format: ExtractedBody['format'] = 'none';
  if (plain.length) {
    text = plain.join('\n\n');
    format = 'plain';
  } else if (got.html.some(h => h.trim())) {
    text = htmlToText(got.html.join('\n'));
    format = 'html';
  }
  const truncated = text.length > maxChars;
  return { text: truncated ? `${text.slice(0, maxChars)}\n[… truncated]` : text, format, truncated, attachments };
}
