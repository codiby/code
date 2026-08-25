/**
 * Splits a markdown document into plain-markdown runs and the fenced blocks
 * that render as real React components (```diffdoc, ```explain).
 *
 * Fence lengths are tracked properly — an opening ``` only closes on a fence at
 * least as long — so a block quoted *inside* a four-backtick block, which is
 * exactly how these formats get documented, stays ordinary markdown.
 */

export type BlockSegment =
  | { type: 'md'; text: string }
  | { type: 'block'; lang: string; source: string }
  /** An opening fence with no closing one yet — the block is still streaming. */
  | { type: 'pending'; lang: string };

const FENCE_RE = /^(`{3,})(.*)$/;

export function splitBlockSegments(source: string, langs: readonly string[]): BlockSegment[] {
  if (!langs.some(l => source.includes(l))) return [{ type: 'md', text: source }];

  const lines = source.split('\n');
  const segments: BlockSegment[] = [];
  let md: string[] = [];
  let body: string[] | null = null;
  let bodyLang = '';
  let fence = '';

  const flushMd = () => {
    if (md.length) segments.push({ type: 'md', text: md.join('\n') });
    md = [];
  };

  for (const line of lines) {
    const match = FENCE_RE.exec(line.trimStart());

    if (body !== null) {
      if (match && match[1].length >= fence.length && !match[2].trim()) {
        segments.push({ type: 'block', lang: bodyLang, source: body.join('\n') });
        body = null;
        fence = '';
      } else {
        body.push(line);
      }
      continue;
    }

    if (match) {
      const info = match[2].trim().split(/\s+/)[0].toLowerCase();
      if (fence) {
        // Inside an ordinary code block: only its own closing fence matters.
        if (match[1].length >= fence.length && !match[2].trim()) fence = '';
        md.push(line);
        continue;
      }
      if (langs.includes(info)) {
        flushMd();
        body = [];
        bodyLang = info;
        fence = match[1];
        continue;
      }
      fence = match[1];
      md.push(line);
      continue;
    }

    md.push(line);
  }

  flushMd();
  if (body !== null) segments.push({ type: 'pending', lang: bodyLang });

  return segments;
}
