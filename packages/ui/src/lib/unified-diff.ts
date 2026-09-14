/**
 * Minimal unified-diff parser for the PR panel's Files tab.
 *
 * It exists because `gh pr diff` hands back one blob and the panel needs three
 * things the blob doesn't offer directly: per-file grouping (so files can
 * collapse), real line numbers on both sides (so a review comment left on
 * `foo.ts:42` can be anchored to the row that *is* line 42), and add/del counts
 * for the per-file header.
 */

export type DiffRowKind = 'add' | 'del' | 'ctx' | 'hunk';

export type DiffRow = {
  kind: DiffRowKind;
  /** Text without the leading +/-/space sigil. Hunk rows keep their `@@` line. */
  text: string;
  /** 1-based line number on the left (pre-image); null for additions. */
  oldLine: number | null;
  /** 1-based line number on the right (post-image); null for deletions. */
  newLine: number | null;
};

export type DiffFile = {
  /** Post-image path, or the pre-image path for a deletion. */
  path: string;
  oldPath: string;
  status: 'added' | 'deleted' | 'renamed' | 'modified';
  /** True for binary files, where there are no rows to show. */
  binary: boolean;
  additions: number;
  deletions: number;
  rows: DiffRow[];
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Strip git's `a/` / `b/` prefix, leaving the repo-relative path. */
function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, '');
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      // `diff --git a/x b/x` — split on ' b/' so paths containing spaces still
      // land correctly, which a naive whitespace split gets wrong.
      const rest = raw.slice('diff --git '.length);
      const at = rest.lastIndexOf(' b/');
      const a = at === -1 ? rest : rest.slice(0, at);
      const b = at === -1 ? rest : rest.slice(at + 1);
      file = {
        path: stripPrefix(b), oldPath: stripPrefix(a),
        status: 'modified', binary: false, additions: 0, deletions: 0, rows: [],
      };
      files.push(file);
      continue;
    }
    if (!file) continue;

    if (raw.startsWith('new file mode')) { file.status = 'added'; continue; }
    if (raw.startsWith('deleted file mode')) { file.status = 'deleted'; continue; }
    if (raw.startsWith('rename from ')) { file.oldPath = raw.slice('rename from '.length); file.status = 'renamed'; continue; }
    if (raw.startsWith('rename to ')) { file.path = raw.slice('rename to '.length); file.status = 'renamed'; continue; }
    if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) { file.binary = true; continue; }
    // Header noise that carries no rows.
    if (raw.startsWith('index ') || raw.startsWith('similarity index ')
      || raw.startsWith('old mode ') || raw.startsWith('new mode ')
      || raw.startsWith('--- ') || raw.startsWith('+++ ')) continue;

    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldLine = parseInt(hunk[1]!, 10);
      newLine = parseInt(hunk[3]!, 10);
      file.rows.push({ kind: 'hunk', text: raw, oldLine: null, newLine: null });
      continue;
    }

    // "\ No newline at end of file" annotates the previous row; it is not a
    // line of either side and must not advance the counters.
    if (raw.startsWith('\\')) continue;

    if (raw.startsWith('+')) {
      file.additions++;
      file.rows.push({ kind: 'add', text: raw.slice(1), oldLine: null, newLine: newLine++ });
    } else if (raw.startsWith('-')) {
      file.deletions++;
      file.rows.push({ kind: 'del', text: raw.slice(1), oldLine: oldLine++, newLine: null });
    } else if (raw.startsWith(' ')) {
      file.rows.push({ kind: 'ctx', text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
    // Anything else between hunks (a trailing empty line at the end of the
    // blob, say) is not part of the patch body and is skipped.
  }
  return files;
}

/** Language hint for the highlighter, derived from the file extension. */
export function langForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
    json: 'json', md: 'markdown', css: 'css', scss: 'scss', html: 'html', yml: 'yaml', yaml: 'yaml',
    sh: 'bash', bash: 'bash', zsh: 'bash', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
    sql: 'sql', toml: 'toml', php: 'php',
  };
  return map[ext] || 'plaintext';
}
