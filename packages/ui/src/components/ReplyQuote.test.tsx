import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReplyQuote } from './ReplyQuote';

describe('reply quote rendering', () => {
  const reply = { id: 'original', role: 'assistant' as const, text: 'Primera línea\nSegunda línea' };

  test('shows the author, multiline excerpt and original message reference', () => {
    const html = renderToStaticMarkup(<ReplyQuote reply={reply} />);
    expect(html).toContain('data-reply-to="original"');
    expect(html).toContain('Codiby');
    expect(html).toContain('Primera línea\nSegunda línea');
    expect(html).not.toContain('codiby-reply');
    expect(html).not.toContain('Cancelar respuesta');
  });

  test('quotes are plain text and the composer variant can be cancelled', () => {
    const html = renderToStaticMarkup(<ReplyQuote reply={{ ...reply, role: 'user', text: '<script>alert(1)</script>' }} onCancel={() => {}} />);
    expect(html).toContain('Tú');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('aria-label="Cancelar respuesta"');
  });
});
