import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dir, 'global.css'), 'utf8');

/** Top-level rules of a stylesheet: each selector list outside any at-rule,
 *  and each at-rule block's prelude with its raw body. Comments and quoted
 *  strings are skipped so a brace inside either can't throw the depth off. */
function topLevel(source: string): { rules: string[][]; blocks: { prelude: string; body: string }[] } {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: string[][] = [];
  const blocks: { prelude: string; body: string }[] = [];
  let depth = 0;
  let prelude = '';
  let bodyStart = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      const end = text.indexOf(ch, i + 1);
      if (depth === 0) prelude += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) bodyStart = i + 1;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const head = prelude.trim();
        if (head.startsWith('@')) blocks.push({ prelude: head, body: text.slice(bodyStart, i) });
        else rules.push(head.split(',').map(s => s.trim()));
        prelude = '';
      }
    } else if (depth === 0) {
      // A statement at-rule (`@import "…";`) ends at its semicolon.
      prelude = ch === ';' ? '' : prelude + ch;
    }
  }
  return { rules, blocks };
}

describe('global.css <pre> rules', () => {
  const { rules, blocks } = topLevel(css);

  // Unlayered CSS beats every layered rule whatever its specificity, so an
  // unlayered `pre` rule silently overrides each Tailwind utility on a <pre>.
  test('no unlayered rule targets every <pre>', () => {
    expect(rules.filter(selectors => selectors.includes('pre'))).toEqual([]);
  });

  test('the bare <pre> defaults live in the base layer', () => {
    const base = blocks.filter(b => b.prelude === '@layer base').map(b => b.body).join('\n');
    expect(base).toMatch(/(^|[\s}])pre\s*\{/);
  });

  // Markdown's fenced blocks carry utilities that never applied; the rule
  // keeping their look has to stay unlayered to keep winning over them.
  test('chat code blocks keep an unlayered rule of their own', () => {
    expect(rules.some(selectors => selectors.includes('[data-code-block] pre'))).toBe(true);
  });
});
