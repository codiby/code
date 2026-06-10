/**
 * Synchronous syntax highlighting for fenced markdown code blocks.
 *
 * Uses Prism because it tokenizes synchronously and returns an HTML string,
 * which fits the string-based `renderMarkdown` pipeline (shiki is async and
 * would force the whole renderer to become asynchronous).
 *
 * The component grammars below are imported in dependency order — Prism's ESM
 * component files do NOT auto-load their prerequisites, so e.g. `tsx` must come
 * after both `jsx` and `typescript`.
 */

import Prism from 'prismjs';

// Core already ships markup/css/clike/javascript; these add the rest.
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-diff';
import 'prismjs/components/prism-markdown';

// Map common fence aliases to the canonical Prism grammar key.
const ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  tsx: 'tsx',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  py: 'python',
  yml: 'yaml',
  html: 'markup',
  xml: 'markup',
  md: 'markdown',
  golang: 'go',
  rs: 'rust',
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Returns highlighted HTML (Prism `<span class="token …">` markup) for the
 * given code. The output is already HTML-escaped by Prism, so callers must NOT
 * escape it again. When the language is unknown or empty, falls back to plain
 * escaped text so untagged blocks still render safely.
 */
export function highlightCode(code: string, lang: string): string {
  const key = ALIASES[lang] || lang;
  const grammar = key ? Prism.languages[key] : undefined;
  if (grammar) {
    try {
      return Prism.highlight(code, grammar, key);
    } catch {
      // fall through to plain escaping on any tokenizer error
    }
  }
  return escapeHtml(code);
}

/** Canonical grammar key for a fence language, or '' if none recognised. */
export function normalizeLang(lang: string): string {
  const key = ALIASES[lang] || lang;
  return key && Prism.languages[key] ? key : '';
}
