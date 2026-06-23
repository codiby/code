/**
 * Heuristic language detection + "is this code?" classification for the chat
 * composer. Pure, dependency-free, and fast — runs on every paste and on
 * fenced blocks that omit a language tag.
 *
 * `detectLanguage` returns a Prism grammar key understood by
 * `src/lib/highlight.ts` (normalizeLang), or '' when nothing matches.
 * `isLikelyCode` decides whether pasted clipboard text should be treated as
 * code (wrapped in a fence / saved to a file) rather than prose.
 *
 * These are heuristics: they trade perfect accuracy for zero deps and instant
 * results. Callers always offer a "paste as text" escape hatch so a wrong
 * guess is one click to undo.
 */

/** Try to parse as JSON (object/array) — the strongest, cheapest signal. */
function looksLikeJson(t: string): boolean {
  const s = t.trim();
  if (!(s.startsWith('{') || s.startsWith('['))) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

interface Rule {
  lang: string;
  test: (t: string, lines: string[]) => boolean;
}

// Ordered most-specific → least. First match wins.
const RULES: Rule[] = [
  {
    lang: 'diff',
    test: (_t, lines) =>
      lines.length > 1 &&
      lines.filter(l => /^[+-] /.test(l) || /^@@ .* @@/.test(l) || /^diff --git/.test(l)).length >= 2,
  },
  {
    lang: 'python',
    test: t =>
      /^\s*(def|class)\s+\w+\s*[(:]/m.test(t) ||
      /^\s*(from\s+[\w.]+\s+)?import\s+\w+/m.test(t) ||
      /^\s*(if|elif|for|while|with)\b.*:\s*$/m.test(t) ||
      /\bprint\(/.test(t) && /:\s*$/m.test(t),
  },
  {
    lang: 'rust',
    test: t =>
      /\bfn\s+\w+\s*\(/.test(t) &&
      (/\blet\s+mut\b/.test(t) || /->\s*\w+/.test(t) || /\bimpl\b/.test(t) || /println!/.test(t) || /::/.test(t)),
  },
  {
    lang: 'go',
    test: t =>
      /^\s*package\s+\w+/m.test(t) ||
      (/\bfunc\s+\w*\s*\(/.test(t) && (/:=/.test(t) || /\bfmt\./.test(t) || /\bimport\s+\(/.test(t))),
  },
  {
    lang: 'sql',
    test: t =>
      /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|VIEW)|ALTER\s+TABLE|DROP\s+TABLE)\b/i.test(t) &&
      /\b(FROM|WHERE|VALUES|SET|JOIN)\b/i.test(t),
  },
  {
    lang: 'markup',
    test: t =>
      /^\s*<!doctype html>/i.test(t) ||
      /^\s*<(html|head|body|div|span|p|a|ul|li|table|svg|section|main|header|footer)\b/i.test(t.trim()) ||
      (/<\/[a-z][\w-]*>/i.test(t) && /<[a-z][\w-]*[\s>]/i.test(t)),
  },
  {
    lang: 'tsx',
    test: t =>
      /:\s*(string|number|boolean|void|any|unknown|never|[A-Z]\w*)\b/.test(t) &&
      /<[A-Z]\w*[\s/>]/.test(t),
  },
  {
    lang: 'jsx',
    test: t => /\breturn\s*\(/.test(t) && /<[A-Za-z][\w-]*[\s/>]/.test(t) && /(=>|\bfunction\b)/.test(t),
  },
  {
    lang: 'typescript',
    test: t =>
      /\b(interface|enum|namespace)\s+\w+/.test(t) ||
      /\btype\s+\w+\s*=/.test(t) ||
      /:\s*(string|number|boolean|void|any|unknown|never|Promise<|Record<|Array<)/.test(t) ||
      /\b(public|private|protected|readonly)\s+\w+/.test(t) ||
      /\bas\s+(const|\w+)\b/.test(t),
  },
  {
    lang: 'bash',
    test: t =>
      /^#!.*\b(ba|z)?sh\b/m.test(t) ||
      /^\s*(export|sudo|cd|echo|cat|grep|sed|awk|curl|chmod|mkdir|rm|cp|mv)\s+/m.test(t) ||
      /^\s*(npm|bun|yarn|pnpm|git|docker|kubectl|brew)\s+\w+/m.test(t) ||
      /\$\{?\w+\}?/.test(t) && /\b(then|fi|done|esac)\b/.test(t),
  },
  {
    lang: 'css',
    test: t => /[.#]?[\w-]+\s*\{[^}]*:[^}]*;[^}]*\}/.test(t.replace(/\n/g, ' ')),
  },
  {
    lang: 'javascript',
    test: t =>
      /\b(const|let|var)\s+\w+\s*=/.test(t) ||
      /\bfunction\b/.test(t) ||
      /=>/.test(t) ||
      /\b(import|export)\b.*\bfrom\b/.test(t) ||
      /\b(require|module\.exports)\b/.test(t),
  },
  {
    lang: 'yaml',
    test: (_t, lines) => {
      if (lines.some(l => /^---\s*$/.test(l))) return true;
      const kv = lines.filter(l => /^\s*[\w.-]+:\s*(.+)?$/.test(l) && !l.trim().endsWith('{'));
      return kv.length >= 2 && kv.length / lines.filter(l => l.trim()).length > 0.6;
    },
  },
];

/**
 * Best-guess Prism grammar key for a code snippet, or '' if undetermined.
 * Pass this to `normalizeLang`/`highlightCode` from highlight.ts.
 */
export function detectLanguage(code: string): string {
  const t = code.trim();
  if (!t) return '';
  if (looksLikeJson(t)) return 'json';
  const lines = code.split('\n');
  for (const rule of RULES) {
    try {
      if (rule.test(code, lines)) return rule.lang;
    } catch {
      // a bad regex match shouldn't break detection
    }
  }
  return '';
}

const EXT_BY_LANG: Record<string, string> = {
  typescript: 'ts', javascript: 'js', tsx: 'tsx', jsx: 'jsx', json: 'json',
  python: 'py', bash: 'sh', yaml: 'yml', sql: 'sql', go: 'go', rust: 'rs',
  markup: 'html', css: 'css', markdown: 'md', diff: 'diff',
};

const DISPLAY_BY_LANG: Record<string, string> = {
  typescript: 'TypeScript', javascript: 'JavaScript', tsx: 'TSX', jsx: 'JSX',
  json: 'JSON', python: 'Python', bash: 'Bash', yaml: 'YAML', sql: 'SQL',
  go: 'Go', rust: 'Rust', markup: 'HTML', css: 'CSS', markdown: 'Markdown', diff: 'Diff',
};

/** File extension for a detected language (no leading dot), or '' if unknown. */
export function extForLang(lang: string): string {
  return EXT_BY_LANG[lang] || '';
}

/** Human-readable name for a language key, falling back to the key itself. */
export function displayLang(lang: string): string {
  return DISPLAY_BY_LANG[lang] || lang;
}

const CODE_SYMBOLS = /[{}()[\];]|=>|::|==|!=|&&|\|\||<\/|\/>/g;

/**
 * Decide whether pasted text should be treated as code. Conservative for short
 * prose, generous once there's a clear language hit or strong structural
 * signals (indentation + code punctuation across multiple lines).
 */
export function isLikelyCode(text: string): boolean {
  const t = text.trim();
  if (!t) return false;

  // A confident language detection is signal enough on its own — except YAML,
  // which overlaps with "key: value" prose, so it needs corroboration below.
  const lang = detectLanguage(t);
  if (lang && lang !== 'yaml') return true;

  const lines = t.split('\n');
  const nonEmpty = lines.filter(l => l.trim());
  const indented = lines.filter(l => /^([ ]{2,}|\t)/.test(l)).length;
  const symbols = (t.match(CODE_SYMBOLS) || []).length;
  const symbolDensity = symbols / Math.max(t.length, 1);

  // Single line: only code if it's punctuation-dense (e.g. a one-liner fn).
  if (lines.length < 2) return symbols >= 3 && symbolDensity > 0.03;

  // Multi-line: needs either real indentation or a healthy symbol density,
  // plus at least a couple of code-ish punctuation marks total.
  const structural = indented >= 1 || symbolDensity > 0.02;
  return structural && symbols >= 3 && nonEmpty.length >= 2;
}
