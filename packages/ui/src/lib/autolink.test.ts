import { describe, expect, test } from 'bun:test';
import { autolinkHtml, autolinkText } from './autolink';

const href = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);

describe('autolinkText', () => {
  test('links a bare url', () => {
    expect(autolinkText('mira https://claude.ai/code aqui')).toContain('href="https://claude.ai/code"');
  });

  test('links a www host without a scheme', () => {
    expect(href(autolinkText('vete a www.github.com/anthropics'))).toEqual(['https://www.github.com/anthropics']);
  });

  test('links a plain domain and keeps the visible text as written', () => {
    const html = autolinkText('el repo esta en github.com/anthropics/claude-code');
    expect(href(html)).toEqual(['https://github.com/anthropics/claude-code']);
    expect(html).toContain('>github.com/anthropics/claude-code</a>');
  });

  test('links an email through mailto', () => {
    expect(href(autolinkText('escribe a jovazxc@gmail.com hoy'))).toEqual(['mailto:jovazxc@gmail.com']);
  });

  test('leaves sentence punctuation out of the url', () => {
    const html = autolinkText('ve https://x.com/a.');
    expect(href(html)).toEqual(['https://x.com/a']);
    expect(html).toEndWith('.');
  });

  test('does not swallow a wrapping paren but keeps a url that opens its own', () => {
    expect(href(autolinkText('(github.com/a)'))).toEqual(['https://github.com/a']);
    expect(href(autolinkText('https://es.wikipedia.org/wiki/Foo_(bar)')))
      .toEqual(['https://es.wikipedia.org/wiki/Foo_(bar)']);
  });

  test('keeps query strings whose ampersands were html-escaped', () => {
    expect(href(autolinkText('https://x.com/s?a=1&amp;b=2'))).toEqual(['https://x.com/s?a=1&amp;b=2']);
  });

  // The renderer shows a lot of chat about source files. None of these are links.
  test('ignores filenames, paths and versions', () => {
    for (const text of [
      'revisa packages/core/mcp/mcp.ts hoy',
      'el bug esta en bridge.ts:251',
      'corre build.sh y main.rs',
      'lee README.md primero',
      'app.py, index.js, mod.rs',
      'la version 1.2.co no existe',
      'packages/ui/src/lib/store.io',
    ]) {
      expect(autolinkText(text)).toBe(text);
    }
  });

  test('does not link a domain that is part of an email', () => {
    expect(href(autolinkText('jova@codiby.com'))).toEqual(['mailto:jova@codiby.com']);
  });
});

describe('autolinkHtml', () => {
  test('leaves an existing anchor alone', () => {
    const html = '<a href="https://x.com" class="c">https://x.com</a>';
    expect(autolinkHtml(html)).toBe(html);
  });

  test('leaves urls inside code untouched', () => {
    const html = '<pre><code>curl https://x.com/api</code></pre>';
    expect(autolinkHtml(html)).toBe(html);
    const inline = '<code data-inline-code>www.x.com</code>';
    expect(autolinkHtml(inline)).toBe(inline);
  });

  test('does not rewrite urls sitting in attributes', () => {
    const html = '<img src="https://x.com/a.png" alt="mira github.com" />';
    expect(autolinkHtml(html)).toBe(html);
  });

  test('links prose that sits next to markup', () => {
    const out = autolinkHtml('<p class="my-0.5">abre www.claude.ai y <a href="https://x.com">esto</a></p>');
    expect(href(out)).toEqual(['https://www.claude.ai', 'https://x.com']);
  });

  test('links inside a snippet button label are left to the button', () => {
    const html = '<button type="button" data-snippet-path="/tmp/a">github.com/x</button>';
    expect(autolinkHtml(html)).toBe(html);
  });
});
