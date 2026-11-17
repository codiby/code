import { describe, expect, test } from 'bun:test';
import { parseUiBlock } from './ui-block';

describe('parseUiBlock', () => {
  test('markdown between components is kept as md nodes', () => {
    const nodes = parseUiBlock('Intro **text**\n<cx-callout tone="warn">Heads up</cx-callout>\nOutro');
    expect(nodes.map(n => n.kind)).toEqual(['md', 'callout', 'md']);
    expect(nodes[1]).toEqual({ kind: 'callout', tone: 'warn', text: 'Heads up' });
  });

  test('flow steps carry title, sub, hot and detail text', () => {
    const [flow] = parseUiBlock(`<cx-flow label="Path">
      <step title="FSEvents" sub="kernel">Cheap.</step>
      <step title="Glob filter" sub="micromatch" hot>Owns <b>63%</b> of CPU.</step>
    </cx-flow>`);
    expect(flow).toEqual({
      kind: 'flow',
      label: 'Path',
      steps: [
        { title: 'FSEvents', sub: 'kernel', hot: false, text: 'Cheap.' },
        { title: 'Glob filter', sub: 'micromatch', hot: true, text: 'Owns 63% of CPU.' },
      ],
    });
  });

  test('bars accept self-closing items and pad values to the view count', () => {
    const [bars] = parseUiBlock(`<cx-bars views="Before, After" unit="%">
      <bar label="Glob" tone="red" values="63,2"/>
      <bar label="Other" tone="neon" values="4"></bar>
    </cx-bars>`);
    expect(bars).toEqual({
      kind: 'bars', label: '', views: ['Before', 'After'], unit: '%',
      bars: [
        { label: 'Glob', tone: 'red', values: [63, 2] },
        { label: 'Other', tone: 'accent', values: [4, 0] },
      ],
    });
  });

  test('stats, files and choices', () => {
    const nodes = parseUiBlock(`
<cx-stats><stat label="CPU" value="38%" delta="→ 1.1%" good></stat></cx-stats>
<cx-files><file path="a/b.ts" status="m">skip set</file><file status="A">no path</file></cx-files>
<cx-choice label="Ignore list"><choice title="Hard-coded" recommended>Five lines.</choice><choice>Bare</choice></cx-choice>`);
    expect(nodes).toEqual([
      { kind: 'stats', label: '', stats: [{ label: 'CPU', value: '38%', delta: '→ 1.1%', trend: 'good' }] },
      { kind: 'files', label: '', files: [{ path: 'a/b.ts', status: 'M', note: 'skip set' }] },
      { kind: 'choice', label: 'Ignore list', choices: [
        { title: 'Hard-coded', recommended: true, text: 'Five lines.' },
        { title: 'Bare', recommended: false, text: '' },
      ] },
    ]);
  });

  test('cx-html keeps its body verbatim, including > inside attributes and scripts', () => {
    const body = '<style>.a>.b{color:var(--red)}</style><div data-x="1>0">hi</div><script>if (1 < 2) go()</script>';
    expect(parseUiBlock(`<cx-html>${body}</cx-html>`)).toEqual([{ kind: 'html', html: body }]);
  });

  test('unknown components and empty ones are dropped; entities decode', () => {
    const nodes = parseUiBlock('<cx-marquee>x</cx-marquee><cx-flow></cx-flow><cx-callout>a &amp; b &lt;c&gt;</cx-callout>');
    expect(nodes).toEqual([{ kind: 'callout', tone: 'info', text: 'a & b <c>' }]);
  });

  test('an unclosed component swallows the rest instead of leaking markup', () => {
    const nodes = parseUiBlock('Before\n<cx-callout tone="ok">Done');
    expect(nodes).toEqual([{ kind: 'md', text: 'Before' }, { kind: 'callout', tone: 'ok', text: 'Done' }]);
  });
});
