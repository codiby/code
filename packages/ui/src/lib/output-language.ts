/**
 * Which language, if any, a tool's output is written in — so the output
 * window can colour it the way the editor would.
 *
 * Signals, strongest first:
 *   1. The command that produced it. `cat tsconfig.json`, `sed -n 1,80p a.tsx`,
 *      `git diff` say exactly what comes back; no guessing needed.
 *   2. Valid JSON.
 *   3. highlight.js auto-detection, which scores the text against every
 *      grammar and reports how confident it is. Only a confident result
 *      counts — test-runner chatter and error logs must stay plain.
 *
 * The result is a Prism grammar key (see `highlight.ts`), because the rest of
 * the app renders code with Prism; highlight.js is only the detector.
 */

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const HLJS_LANGS = { bash, css, diff, go, javascript, json, markdown, python, rust, sql, typescript, xml, yaml };
for (const [name, lang] of Object.entries(HLJS_LANGS)) hljs.registerLanguage(name, lang);

/** highlight.js name → Prism grammar key. */
const TO_PRISM: Record<string, string> = {
  bash: 'bash', css: 'css', diff: 'diff', go: 'go', javascript: 'javascript', json: 'json',
  markdown: 'markdown', python: 'python', rust: 'rust', sql: 'sql', typescript: 'typescript',
  xml: 'markup', yaml: 'yaml',
};

/** File extension → Prism grammar key. */
const BY_EXT: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', jsonc: 'json', json5: 'json', lock: '',
  py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash', env: 'bash',
  yml: 'yaml', yaml: 'yaml', sql: 'sql', go: 'go', rs: 'rust',
  md: 'markdown', mdx: 'markdown', css: 'css', scss: 'css',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', plist: 'markup',
  diff: 'diff', patch: 'diff',
};

/** Commands whose output is the content of the file(s) they are given. */
const FILE_PRINTERS = new Set(['cat', 'sed', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'awk', 'batcat']);

const PATH_WITH_EXT = /(?:^|[\s'"=])((?:[\w.@~-]*\/)*[\w@-][\w.@-]*\.([A-Za-z0-9]+))(?=$|[\s'";|&)])/g;

/** Grammars so alike that a near-tie between them is still a confident answer. */
const CLOSE_PAIRS = new Set(['javascript|typescript', 'typescript|javascript', 'css|scss', 'xml|markdown']);
const MIN_MARGIN = 3;

/** Largest slice handed to the auto-detector; more text doesn't change its mind. */
const SAMPLE_CHARS = 20_000;

/** Language the command's output will be in, when the command makes it certain. */
export function languageFromCommand(command: string): string {
  // Each `;`/`&&`-separated segment is its own command; the first one that
  // prints a known file decides (`sed … a.tsx; cat tsconfig.json` → tsx).
  for (const segment of command.split(/&&|\|\||;|\n/)) {
    const words = segment.trim().split(/\s+/);
    const tool = words[0]?.replace(/^.*\//, '') ?? '';
    if (tool === 'git' && /^(diff|show)$/.test(words[1] ?? '')) return 'diff';
    if (tool === 'jq') return 'json';
    if (!FILE_PRINTERS.has(tool)) continue;
    // `sed -i` edits the file in place; whatever it prints isn't the file.
    if (tool === 'sed' && words.some(w => /^-[a-zA-Z]*i/.test(w) || w === '--in-place')) continue;
    // Only the part before a pipe is the printer's own argument list.
    const args = segment.split('|')[0]!;
    for (const m of args.matchAll(PATH_WITH_EXT)) {
      const lang = BY_EXT[m[2]!.toLowerCase()];
      if (lang) return lang;
    }
  }
  return '';
}

function looksLikeJson(text: string): boolean {
  const s = text.trim();
  if (!(s.startsWith('{') || s.startsWith('['))) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prism key for `output`, or '' to show it as plain text. Output that already
 * carries ANSI colours keeps them — the program coloured it on purpose.
 */
export function detectOutputLanguage(output: string, command?: string): string {
  if (!output.trim()) return '';
  // eslint-disable-next-line no-control-regex
  if (/\x1b\[[0-9;]*m/.test(output)) return '';

  if (command) {
    const fromCommand = languageFromCommand(command);
    if (fromCommand) return fromCommand;
  }
  if (looksLikeJson(output)) return 'json';

  const lines = output.split('\n').filter(l => l.trim()).length;
  if (lines < 3) return '';

  const sample = output.length > SAMPLE_CHARS ? output.slice(0, SAMPLE_CHARS) : output;
  const result = hljs.highlightAuto(sample, Object.keys(HLJS_LANGS));
  if (!result.language) return '';
  // Relevance is a sum of keyword/pattern hits. Prose and logs pick up a few
  // by accident; real code racks them up on nearly every line.
  const needed = Math.max(10, Math.min(lines, 60) * 0.5);
  if (result.relevance < needed) return '';
  // Code also wins clearly. Compiler errors and logs score about the same in
  // two unrelated grammars (tsc output ties bash and python) — that tie is
  // the tell that nothing actually matched. JS vs TS is a real near-tie.
  const second = result.secondBest;
  const siblings = second?.language && CLOSE_PAIRS.has(`${result.language}|${second.language}`);
  if (second?.language && !siblings && result.relevance - second.relevance < MIN_MARGIN) return '';
  return TO_PRISM[result.language] ?? '';
}

/** Prism key for a file path, or ''. */
export function languageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return BY_EXT[ext] ?? '';
}
