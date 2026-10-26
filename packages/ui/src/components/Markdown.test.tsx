import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './Markdown';

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />);
const items = (html: string) => [...html.matchAll(/<li\b[^>]*>(.*?)<\/li>/gs)].map(match => match[1]);

describe('Markdown lists copied to rich text editors', () => {
  test('ordered markers are semantic, not extra text or flex children', () => {
    const html = render('1. First **step**\n2. Second step');
    expect(items(html)).toEqual([
      'First <strong class="text-zinc-200 font-semibold">step</strong>',
      'Second step',
    ]);
    expect(html).not.toMatch(/<li[^>]*\bflex\b/);
    expect(html).toContain('list-decimal');
  });

  test('bullets are native markers and inline formatting survives', () => {
    const html = render('- First **bullet**\n- Second bullet');
    expect(items(html)).toEqual([
      'First <strong class="text-zinc-200 font-semibold">bullet</strong>',
      'Second bullet',
    ]);
    expect(html).not.toContain('•');
    expect(html).toContain('list-disc');
  });

  test('numbering survives interruptions and explicit nonsequential values', () => {
    const html = render('3. Third\n- Detail\n4. Fourth\n\n8. Eighth\n10. Tenth');
    expect([...html.matchAll(/<ol start="(\d+)"/g)].map(match => match[1])).toEqual(['3', '4', '8']);
    expect([...html.matchAll(/<li value="(\d+)"/g)].map(match => match[1])).toEqual(['3', '4', '8', '10']);
  });

  test('task lists retain checked state without splitting marker and content', () => {
    const html = render('- [x] Done\n- [ ] Pending\n- Normal bullet');
    expect(items(html)).toEqual([
      '<span class="text-zinc-500 line-through">☑ Done</span>',
      '<span class="">☐ Pending</span>',
      'Normal bullet',
    ]);
    expect(html).not.toMatch(/<li[^>]*\bflex\b/);
    expect(html).toContain('list-disc');
  });
});
