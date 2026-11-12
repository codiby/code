/**
 * A small POSIX-ish shell lexer — just enough structure for the policy
 * classifier: commands split on `; && || | &`, quotes removed, redirections
 * pulled out, and the bodies of `$(…)`, backticks, `<(…)` and heredocs kept
 * so they can be classified as scripts of their own.
 *
 * It never evaluates anything. When it cannot make sense of the input
 * (unbalanced quotes), it throws, and the caller treats the command as
 * unknown rather than guessing it is safe.
 */

export interface Redirect {
  /** `>`, `>>`, `<`, `<<`, `<<<`, `>&`, `&>`… */
  op: string;
  /** File descriptor written before the operator (`2>`), if any. */
  fd?: string;
  target: string;
}

export interface Segment {
  words: string[];
  redirects: Redirect[];
  /** Inner scripts of command/process substitutions found in this command. */
  substitutions: string[];
  /** Heredoc bodies fed to this command. */
  heredocs: string[];
  /** This command's stdout feeds the next segment. */
  pipeToNext: boolean;
}

export class ShellParseError extends Error {}

function newSegment(): Segment {
  return { words: [], redirects: [], substitutions: [], heredocs: [], pipeToNext: false };
}

/** Index of the `)` that closes the `(` at `open`, honouring quotes and nesting. */
function closingParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new ShellParseError('Unbalanced single quote');
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      if (j >= src.length) throw new ShellParseError('Unbalanced double quote');
      i = j;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new ShellParseError('Unbalanced parenthesis');
}

const REDIRECT_OPS = ['<<<', '<<-', '&>>', '>>', '>|', '>&', '<&', '<>', '<<', '&>', '>', '<'];

export function parseShell(src: string): Segment[] {
  const segments: Segment[] = [];
  let seg = newSegment();
  let cur = '';
  let has = false;
  let pendingRedirect: { op: string; fd?: string } | null = null;
  const pendingHeredocs: { delim: string; strip: boolean; seg: Segment }[] = [];

  const pushWord = () => {
    if (!has) return;
    if (pendingRedirect) {
      seg.redirects.push({ ...pendingRedirect, target: cur });
      if (pendingRedirect.op === '<<' || pendingRedirect.op === '<<-') {
        pendingHeredocs.push({ delim: cur, strip: pendingRedirect.op === '<<-', seg });
      }
      pendingRedirect = null;
    } else {
      seg.words.push(cur);
    }
    cur = '';
    has = false;
  };

  const endSegment = (pipe: boolean) => {
    pushWord();
    if (pendingRedirect) {
      seg.redirects.push({ ...pendingRedirect, target: '' });
      pendingRedirect = null;
    }
    const empty = !seg.words.length && !seg.redirects.length && !seg.substitutions.length;
    if (!empty) {
      seg.pipeToNext = pipe;
      segments.push(seg);
    } else if (pipe && segments.length) {
      segments[segments.length - 1]!.pipeToNext = true;
    }
    seg = newSegment();
  };

  /** After a newline, consume the bodies of heredocs opened on that line. */
  const consumeHeredocs = (from: number): number => {
    let i = from;
    while (pendingHeredocs.length) {
      const { delim, strip, seg: owner } = pendingHeredocs.shift()!;
      const body: string[] = [];
      while (i <= src.length) {
        const nl = src.indexOf('\n', i);
        const line = nl < 0 ? src.slice(i) : src.slice(i, nl);
        i = nl < 0 ? src.length + 1 : nl + 1;
        if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
        body.push(line);
        if (nl < 0) break;
      }
      owner.heredocs.push(body.join('\n'));
    }
    return Math.min(i, src.length);
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];

    if (c === '\\') {
      if (next === '\n') { i += 2; continue; }
      if (next !== undefined) { cur += next; has = true; }
      i += 2;
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new ShellParseError('Unbalanced single quote');
      cur += src.slice(i + 1, j);
      has = true;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let k = i + 1;
      while (k < src.length && src[k] !== '"') {
        const d = src[k]!;
        if (d === '\\' && k + 1 < src.length) { cur += src[k + 1]; k += 2; continue; }
        if (d === '$' && src[k + 1] === '(') {
          const end = closingParen(src, k + 1);
          const inner = src.slice(k + 2, end);
          if (!inner.startsWith('(')) seg.substitutions.push(inner);
          cur += `$(${inner})`;
          k = end + 1;
          continue;
        }
        if (d === '`') {
          const end = src.indexOf('`', k + 1);
          if (end < 0) throw new ShellParseError('Unbalanced backtick');
          seg.substitutions.push(src.slice(k + 1, end));
          cur += src.slice(k, end + 1);
          k = end + 1;
          continue;
        }
        cur += d;
        k++;
      }
      if (k >= src.length) throw new ShellParseError('Unbalanced double quote');
      has = true;
      i = k + 1;
      continue;
    }
    if (c === '$' && next === '(') {
      const end = closingParen(src, i + 1);
      const inner = src.slice(i + 2, end);
      // `$((…))` is arithmetic, not a command.
      if (!inner.startsWith('(')) seg.substitutions.push(inner);
      cur += `$(${inner})`;
      has = true;
      i = end + 1;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end < 0) throw new ShellParseError('Unbalanced backtick');
      seg.substitutions.push(src.slice(i + 1, end));
      cur += src.slice(i, end + 1);
      has = true;
      i = end + 1;
      continue;
    }
    if ((c === '<' || c === '>') && next === '(') {
      pushWord();
      const end = closingParen(src, i + 1);
      seg.substitutions.push(src.slice(i + 2, end));
      seg.words.push(`${c}(…)`);
      i = end + 1;
      continue;
    }
    if (c === '#' && !has) {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { pushWord(); i++; continue; }
    if (c === '\n') { endSegment(false); i = consumeHeredocs(i + 1); continue; }
    if (c === ';') { endSegment(false); i++; continue; }
    if (c === '(' || c === ')') { endSegment(false); i++; continue; }
    if (c === '&') {
      if (next === '&') { endSegment(false); i += 2; continue; }
      if (next !== '>') { endSegment(false); i++; continue; }
    }
    if (c === '|') {
      if (next === '|') { endSegment(false); i += 2; continue; }
      endSegment(true);
      i += next === '&' ? 2 : 1;
      continue;
    }
    if (c === '>' || c === '<' || (c === '&' && next === '>')) {
      let fd: string | undefined;
      if (has && /^\d+$/.test(cur)) { fd = cur; cur = ''; has = false; } else pushWord();
      if (pendingRedirect) seg.redirects.push({ ...pendingRedirect, target: '' });
      const op = REDIRECT_OPS.find(o => src.startsWith(o, i))!;
      pendingRedirect = fd ? { op, fd } : { op };
      i += op.length;
      // `2>&1` / `>&2`: the target is glued to the operator.
      if ((op === '>&' || op === '<&') && /[\d-]/.test(src[i] ?? '')) {
        let t = '';
        while (i < src.length && /[\d-]/.test(src[i]!)) t += src[i++];
        seg.redirects.push({ ...pendingRedirect, target: t });
        pendingRedirect = null;
      }
      continue;
    }
    cur += c;
    has = true;
    i++;
  }
  endSegment(false);
  return segments;
}
