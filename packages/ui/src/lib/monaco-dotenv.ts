/**
 * A `dotenv` language for Monaco — `.env`, `.env.local`, `.env.production`, …
 *
 * Monaco ships no grammar for env files, so the file editor (which derives the
 * language from the model URI / filename) falls back to plaintext. We register
 * a small Monarch tokenizer plus filename associations so those files light up
 * everywhere Monaco is used: the open-file editor, Edit/Write previews, and
 * diffs.
 *
 * Registration is idempotent and fired once as soon as the shared Monaco
 * instance is ready (`loader.init()`), so associations exist before any model
 * is created. Editors can also call `registerDotenv` from `beforeMount` as a
 * belt-and-suspenders for first-mount timing.
 */
import { loader, type Monaco } from '@monaco-editor/react';

let registered = false;

export function registerDotenv(monaco: Monaco): void {
  if (registered) return;
  // Don't flip the flag until the (rare) failure path can't leave us
  // half-registered; the individual calls below are each idempotent in Monaco.
  const already = monaco.languages.getLanguages().some((l: { id: string }) => l.id === 'dotenv');
  if (!already) {
    monaco.languages.register({
      id: 'dotenv',
      extensions: ['.env'],
      filenames: ['.env'],
      filenamePatterns: ['.env.*', '*.env'],
      aliases: ['dotenv', 'DotEnv', 'env'],
    });
  }

  monaco.languages.setLanguageConfiguration('dotenv', {
    comments: { lineComment: '#' },
    brackets: [['{', '}']],
    autoClosingPairs: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: '{', close: '}' },
    ],
    surroundingPairs: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });

  monaco.languages.setMonarchTokensProvider('dotenv', {
    tokenizer: {
      root: [
        [/^\s*#.*$/, 'comment'],
        [/^\s*export\b/, 'keyword'],
        // KEY (up to the `=`)
        [/^\s*[\w.-]+(?=\s*=)/, 'variable'],
        [/=/, 'operator'],
        // quoted values
        [/"/, { token: 'string.quote', next: '@dqstring' }],
        [/'/, { token: 'string.quote', next: '@sqstring' }],
        // ${VAR} / $VAR interpolation in unquoted values
        [/\$\{[^}]*\}/, 'identifier'],
        [/\$[A-Za-z_]\w*/, 'identifier'],
        // trailing inline comment
        [/#.*$/, 'comment'],
        // unquoted value remainder (stop before an inline comment)
        [/[^#\s"'$][^#]*/, 'string'],
      ],
      dqstring: [
        [/\$\{[^}]*\}/, 'identifier'],
        [/\$[A-Za-z_]\w*/, 'identifier'],
        [/\\./, 'string.escape'],
        [/[^"\\$]+/, 'string'],
        [/"/, { token: 'string.quote', next: '@pop' }],
      ],
      sqstring: [
        [/[^']+/, 'string'],
        [/'/, { token: 'string.quote', next: '@pop' }],
      ],
    },
  });

  registered = true;
}

/** True for `.env`, `.env.<anything>`, and `<name>.env` paths. */
export function isDotenvPath(path: string): boolean {
  const name = (path.split(/[\\/]/).pop() || path).toLowerCase();
  return name === '.env' || name.startsWith('.env.') || name.endsWith('.env');
}

// Register as soon as the shared Monaco instance loads, so filename
// associations are in place before the first model is created.
loader.init().then(registerDotenv).catch(() => {});
