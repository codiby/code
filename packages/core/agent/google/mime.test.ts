import { describe, expect, test } from 'bun:test';
import {
  base64UrlEncode,
  buildMimeMessage,
  decodeEncodedWords,
  encodeHeaderValue,
  extractMessageBody,
  htmlToText,
  parseAddressList,
  replySubject,
  type GmailPart,
} from './mime';

const b64u = (s: string, encoding: BufferEncoding = 'utf8') => Buffer.from(s, encoding).toString('base64url');

function headersOf(mime: string): Record<string, string> {
  const head = mime.split('\r\n\r\n')[0]!.replace(/\r\n[ \t]+/g, ' ');
  const out: Record<string, string> = {};
  for (const line of head.split('\r\n')) {
    const i = line.indexOf(':');
    out[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function bodyOf(mime: string): string {
  return Buffer.from(mime.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8');
}

describe('MIME building', () => {
  test('reply headers thread the message', () => {
    const mime = buildMimeMessage({
      to: [{ email: 'ana@example.com', name: 'Ana' }],
      subject: 'Re: Lunch',
      body: 'See you\nthere',
      inReplyTo: '<msg-2@mail.example.com>',
      references: ['<msg-1@mail.example.com>'],
    });
    const h = headersOf(mime);
    expect(h['in-reply-to']).toBe('<msg-2@mail.example.com>');
    expect(h.references).toBe('<msg-1@mail.example.com> <msg-2@mail.example.com>');
    expect(h.to).toBe('Ana <ana@example.com>');
    expect(h['content-type']).toBe('text/plain; charset="UTF-8"');
    expect(h['content-transfer-encoding']).toBe('base64');
    expect(bodyOf(mime)).toBe('See you\r\nthere');
    // CRLF only: no bare LF anywhere.
    expect(/[^\r]\n/.test(mime)).toBe(false);
  });

  test('UTF-8 subjects are RFC 2047 encoded and short lines are kept', () => {
    const subject = 'Reunión mañana — ¿confirmas? '.repeat(4).trim();
    const encoded = encodeHeaderValue(subject);
    expect(encoded.startsWith('=?UTF-8?B?')).toBe(true);
    for (const line of encoded.split('\r\n')) expect(line.trim().length).toBeLessThanOrEqual(75);
    expect(decodeEncodedWords(encoded.replace(/\r\n /g, ' '))).toBe(subject);
    const mime = buildMimeMessage({ to: [{ email: 'a@example.com' }], subject, body: 'x' });
    expect(decodeEncodedWords(headersOf(mime).subject!)).toBe(subject);
    expect(encodeHeaderValue('Plain ASCII')).toBe('Plain ASCII');
  });

  test('header injection through any model-written field is rejected', () => {
    expect(() => buildMimeMessage({ to: [{ email: 'a@example.com' }], subject: 'Hi\r\nBcc: evil@example.com', body: 'x' })).toThrow(/single line/);
    expect(() => parseAddressList('a@example.com\nBcc: evil@example.com', 'to')).toThrow(/single line/);
    expect(() => parseAddressList('not an address', 'to')).toThrow(/valid email/);
  });

  test('address lists respect quoted commas', () => {
    expect(parseAddressList('"Doe, Jane" <jane@example.com>, bob@example.com', 'to')).toEqual([
      { name: 'Doe, Jane', email: 'jane@example.com' },
      { email: 'bob@example.com' },
    ]);
    expect(parseAddressList(['a@example.com', 'B <b@example.com>'], 'cc')).toHaveLength(2);
  });

  test('base64url output has no +, / or padding', () => {
    const out = base64UrlEncode('subjects?>>>~~~ and ÿÿÿ');
    expect(out).not.toMatch(/[+/=]/);
    expect(Buffer.from(out, 'base64url').toString('utf8')).toBe('subjects?>>>~~~ and ÿÿÿ');
  });

  test('replySubject does not stack prefixes', () => {
    expect(replySubject('Lunch')).toBe('Re: Lunch');
    expect(replySubject('RE: Lunch')).toBe('RE: Lunch');
  });
});

describe('body extraction', () => {
  test('prefers text/plain inside multipart/alternative and lists attachments', () => {
    const payload: GmailPart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }], body: { data: b64u('Hola Jova,\r\nel informe va adjunto.') } },
            { mimeType: 'text/html', body: { data: b64u('<p>Hola <b>Jova</b></p>') } },
          ],
        },
        { mimeType: 'application/pdf', filename: 'informe.pdf', body: { size: 48213, attachmentId: 'att-1' } },
      ],
    };
    const out = extractMessageBody(payload);
    expect(out.format).toBe('plain');
    expect(out.text).toBe('Hola Jova,\nel informe va adjunto.');
    expect(out.attachments).toEqual([{ name: 'informe.pdf', mimeType: 'application/pdf', size: 48213 }]);
  });

  test('falls back to HTML stripped to text', () => {
    const html = '<html><head><style>p{color:red}</style><script>alert(1)</script></head><body>' +
      '<p>Your order&nbsp;<b>#42</b> shipped.</p><ul><li>Track it <a href="https://ship.example.com/t/42">here</a></li></ul></body></html>';
    const out = extractMessageBody({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64u(html) } }] });
    expect(out.format).toBe('html');
    expect(out.text).toContain('Your order #42 shipped.');
    expect(out.text).toContain('• Track it here (https://ship.example.com/t/42)');
    expect(out.text).not.toContain('alert');
    expect(out.text).not.toContain('color:red');
  });

  test('decodes non-UTF-8 charsets', () => {
    const out = extractMessageBody({
      mimeType: 'text/plain',
      headers: [{ name: 'Content-Type', value: 'text/plain; charset="iso-8859-1"' }],
      body: { data: b64u('Año nuevo', 'latin1') },
    });
    expect(out.text).toBe('Año nuevo');
  });

  test('caps long bodies', () => {
    const out = extractMessageBody({ mimeType: 'text/plain', body: { data: b64u('a'.repeat(25_000)) } }, 20_000);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThan(20_100);
  });

  test('decodes encoded-word headers', () => {
    expect(decodeEncodedWords('=?UTF-8?Q?Caf=C3=A9_ma=C3=B1ana?=')).toBe('Café mañana');
  });

  test('htmlToText keeps paragraphs apart', () => {
    expect(htmlToText('<div>One</div><div>Two<br>Three</div>')).toBe('One\n\nTwo\nThree');
    expect(htmlToText('<p>a</p>\n\n\n\n<p>b</p>')).toBe('a\n\nb');
  });
});
