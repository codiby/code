/**
 * Gramática del bloque ```ui. Puerto directo de `packages/ui/src/lib/ui-block.ts`
 * del escritorio (texto puro, sin DOM): mismo catálogo `cx-*`, mismos nodos.
 * Solo cambia el renderizado (UiBlockView.tsx). Si cambias uno, cambia el otro.
 */

export type UiTone = 'accent' | 'red' | 'amber' | 'green' | 'blue' | 'muted';
export type CalloutTone = 'warn' | 'info' | 'ok';

export type UiNode =
  | { kind: 'md'; text: string }
  | { kind: 'callout'; tone: CalloutTone; text: string }
  | {
      kind: 'flow';
      label: string;
      steps: { title: string; sub: string; hot: boolean; text: string }[];
    }
  | {
      kind: 'bars';
      label: string;
      views: string[];
      unit: string;
      bars: { label: string; tone: UiTone; values: number[] }[];
    }
  | {
      kind: 'stats';
      label: string;
      stats: {
        label: string;
        value: string;
        delta: string;
        trend: 'good' | 'bad' | '';
      }[];
    }
  | {
      kind: 'files';
      label: string;
      files: { path: string; status: string; note: string }[];
    }
  | {
      kind: 'choice';
      label: string;
      choices: { title: string; recommended: boolean; text: string }[];
    }
  | { kind: 'html'; html: string };

const TONES: readonly UiTone[] = [
  'accent',
  'red',
  'amber',
  'green',
  'blue',
  'muted',
];
const CALLOUT_TONES: readonly CalloutTone[] = ['warn', 'info', 'ok'];

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (whole, name: string) => {
      if (name[0] === '#') {
        const code =
          name[1] === 'x' || name[1] === 'X'
            ? parseInt(name.slice(2), 16)
            : parseInt(name.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    },
  );
}

const ATTR_RE =
  /([a-zA-Z][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+)))?/g;

export function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** Inner text of an item: tags dropped, entities decoded, whitespace collapsed. */
function plain(inner: string): string {
  return decodeEntities(inner.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

interface Item {
  attrs: Record<string, string>;
  text: string;
}

function items(inner: string, tag: string): Item[] {
  const re = new RegExp(
    `<${tag}\\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\\/>|>([\\s\\S]*?)<\\/${tag}\\s*>)`,
    'gi',
  );
  return [...inner.matchAll(re)].map(m => ({
    attrs: parseAttrs(m[1]),
    text: plain(m[3] ?? ''),
  }));
}

const has = (attrs: Record<string, string>, name: string) =>
  name in attrs && attrs[name] !== 'false';

function tone(raw: string | undefined): UiTone {
  return TONES.includes(raw as UiTone) ? (raw as UiTone) : 'accent';
}

function build(
  name: string,
  attrs: Record<string, string>,
  inner: string,
): UiNode | null {
  const label = attrs.label || '';
  switch (name) {
    case 'callout': {
      const t = CALLOUT_TONES.includes(attrs.tone as CalloutTone)
        ? (attrs.tone as CalloutTone)
        : 'info';
      return { kind: 'callout', tone: t, text: plain(inner) };
    }
    case 'flow': {
      const steps = items(inner, 'step').map(({ attrs: a, text }) => ({
        title: a.title || '',
        sub: a.sub || '',
        hot: has(a, 'hot'),
        text,
      }));
      return steps.length ? { kind: 'flow', label, steps } : null;
    }
    case 'bars': {
      const views = (attrs.views || '')
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
      const bars = items(inner, 'bar').map(({ attrs: a }) => ({
        label: a.label || '',
        tone: tone(a.tone),
        values: (a.values ?? a.value ?? '')
          .split(',')
          .map(v => Number(v.trim()))
          .map(n => (Number.isFinite(n) ? n : 0)),
      }));
      if (!bars.length) return null;
      const width = Math.max(
        1,
        views.length,
        ...bars.map(b => b.values.length),
      );
      return {
        kind: 'bars',
        label,
        views: views.length > 1 ? views : [],
        unit: attrs.unit || '',
        bars: bars.map(b => ({
          ...b,
          values: Array.from({ length: width }, (_, i) => b.values[i] ?? 0),
        })),
      };
    }
    case 'stats': {
      const stats = items(inner, 'stat').map(({ attrs: a }) => ({
        label: a.label || '',
        value: a.value || '',
        delta: a.delta || '',
        trend: has(a, 'good')
          ? ('good' as const)
          : has(a, 'bad')
          ? ('bad' as const)
          : ('' as const),
      }));
      return stats.length ? { kind: 'stats', label, stats } : null;
    }
    case 'files': {
      const files = items(inner, 'file')
        .map(({ attrs: a, text }) => ({
          path: a.path || '',
          status: (a.status || '').toUpperCase().slice(0, 1),
          note: text,
        }))
        .filter(f => f.path);
      return files.length ? { kind: 'files', label, files } : null;
    }
    case 'choice': {
      const choices = items(inner, 'choice')
        .map(({ attrs: a, text }) => ({
          title: a.title || text,
          recommended: has(a, 'recommended'),
          text: a.title ? text : '',
        }))
        .filter(c => c.title);
      return choices.length ? { kind: 'choice', label, choices } : null;
    }
    case 'html':
      return inner.trim() ? { kind: 'html', html: inner } : null;
    default:
      return null;
  }
}

const OPEN_RE = /<cx-([a-z]+)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;

export function parseUiBlock(source: string): UiNode[] {
  const nodes: UiNode[] = [];
  const pushMd = (text: string) => {
    if (text.trim()) nodes.push({ kind: 'md', text: text.trim() });
  };

  let pos = 0;
  OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OPEN_RE.exec(source))) {
    const name = m[1].toLowerCase();
    const close = new RegExp(`</cx-${name}\\s*>`, 'i');
    const bodyStart = m.index + m[0].length;
    const rest = source.slice(bodyStart);
    const end = rest.search(close);
    // An unclosed component swallows the rest of the block, the way an
    // unclosed fence does — better than leaking its markup as text.
    const inner = end < 0 ? rest : rest.slice(0, end);
    const after =
      end < 0
        ? source.length
        : bodyStart + end + (rest.slice(end).match(close)?.[0].length ?? 0);

    pushMd(source.slice(pos, m.index));
    const node = build(name, parseAttrs(m[2]), inner);
    if (node) nodes.push(node);
    pos = after;
    OPEN_RE.lastIndex = after;
  }
  pushMd(source.slice(pos));
  return nodes;
}
