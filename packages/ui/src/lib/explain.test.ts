import { describe, expect, test } from 'bun:test';
import {
  collectExplainParts,
  explainBlockId,
  formatAnchor,
  isAnchoredMessage,
  isDecision,
  mergeExplain,
  parseAnchor,
  parseExplain,
} from './explain';

describe('parseExplain', () => {
  test('reads the goal and the steps', () => {
    const b = parseExplain('goal Bajar los watches\n# Un watch por carpeta\nPide un aviso por carpeta.');
    expect(b.error).toBeUndefined();
    expect(b.goal).toBe('Bajar los watches');
    expect(b.steps).toHaveLength(1);
    expect(b.steps[0]).toMatchObject({ title: 'Un watch por carpeta', body: ['Pide un aviso por carpeta.'] });
  });

  test('rejects a block with no steps', () => {
    expect(parseExplain('goal solo el objetivo').error).toBeTruthy();
  });

  test('rejects a block with neither goal nor continues', () => {
    expect(parseExplain('# un paso\ncuerpo').error).toBeTruthy();
  });

  test('rejects prose before the first step', () => {
    expect(parseExplain('goal g\nsuelto\n# paso').error).toBeTruthy();
  });

  test('a continuation needs no goal of its own', () => {
    const b = parseExplain('continues m1:0\n# sigue\ncuerpo');
    expect(b.error).toBeUndefined();
    expect(b.continues).toBe('m1:0');
  });

  test('collects code lines separately from prose', () => {
    const b = parseExplain("goal g\n# paso\ntexto\n|+const SKIP = new Set(['a'])\n|-  old line");
    expect(b.steps[0].body).toEqual(['texto']);
    expect(b.steps[0].code).toEqual(["+const SKIP = new Set(['a'])", '-  old line']);
  });

  test('an option splits label from description on the middle dot', () => {
    const b = parseExplain('goal g\n# ¿cuál?\n= Fija, en el código · Se versiona con el repo\n= Configurable');
    expect(b.steps[0].options).toEqual([
      { label: 'Fija, en el código', description: 'Se versiona con el repo' },
      { label: 'Configurable' },
    ]);
  });

  test('a step with options is a decision, one without is not', () => {
    const b = parseExplain('goal g\n# explica\ntexto\n# decide\n= A\n= B');
    expect(isDecision(b.steps[0])).toBe(false);
    expect(isDecision(b.steps[1])).toBe(true);
  });

  test('collects agent-authored extras for the "no entendí" panel', () => {
    const b = parseExplain('goal g\n# paso\ntexto\n? Explícame qué es FSEvents');
    expect(b.steps[0].asks).toEqual(['Explícame qué es FSEvents']);
  });

  test('a blank line separates paragraphs and never trails', () => {
    const b = parseExplain('goal g\n# paso\nuno\n\n\ndos\n\n');
    expect(b.steps[0].body).toEqual(['uno', '', 'dos']);
  });

  test('a title line inside the body still opens a new step', () => {
    const b = parseExplain('goal g\n# a\ncuerpo\n# b\notro');
    expect(b.steps.map(s => s.title)).toEqual(['a', 'b']);
  });
});

describe('mergeExplain', () => {
  const base = parseExplain('goal g\n# uno\ncuerpo');

  test('appends the continuation steps and keeps the original goal', () => {
    const part = parseExplain('continues m1:0\n# dos\ncuerpo');
    const merged = mergeExplain(base, [part]);
    expect(merged.goal).toBe('g');
    expect(merged.steps.map(s => s.title)).toEqual(['uno', 'dos']);
  });

  test('a continuation cannot repin the objective', () => {
    const part = parseExplain('goal OTRO\ncontinues m1:0\n# dos\ncuerpo');
    expect(mergeExplain(base, [part]).goal).toBe('g');
  });

  test('drops a malformed continuation instead of breaking the block', () => {
    const merged = mergeExplain(base, [parseExplain('basura')]);
    expect(merged.steps.map(s => s.title)).toEqual(['uno']);
  });

  test('with no parts it returns the block untouched', () => {
    expect(mergeExplain(base, [])).toBe(base);
  });
});

describe('collectExplainParts', () => {
  const owner = { id: 'm1', role: 'assistant', content: '```explain\ngoal g\n# decide\n= A\n= B\n```' };
  const answer = {
    id: 'm2',
    role: 'user',
    content: `A\n\n${formatAnchor({ blockId: 'm1:0', step: 0, kind: 'answer' })}`,
  };
  const continuation = {
    id: 'm3',
    role: 'assistant',
    content: '```explain\ncontinues m1:0\n# sigue\ncuerpo\n```',
  };

  test('records the picked label against its block and step', () => {
    const { parts } = collectExplainParts([owner, answer]);
    expect(parts.answers['m1:0']).toEqual({ 0: 'A' });
  });

  test('hides the answer message from the thread', () => {
    expect(collectExplainParts([owner, answer]).hidden).toEqual(new Set(['m2']));
  });

  test('hides a message that is nothing but a continuation, and keeps its source', () => {
    const { parts, hidden } = collectExplainParts([owner, answer, continuation]);
    expect(hidden.has('m3')).toBe(true);
    expect(parts.continuations['m1:0']).toEqual(['continues m1:0\n# sigue\ncuerpo']);
  });

  test('a continuation wrapped in real prose stays visible', () => {
    const chatty = { ...continuation, content: `Ojo con esto.\n${continuation.content}` };
    const { parts, hidden } = collectExplainParts([owner, chatty]);
    expect(hidden.has('m3')).toBe(false);
    expect(parts.continuations['m1:0']).toHaveLength(1);
  });

  test('a rewrite anchor hides the message without recording an answer', () => {
    const ask = { id: 'm4', role: 'user', content: `Con una analogía\n\n${formatAnchor({ blockId: 'm1:0', step: 0, kind: 'rewrite' })}` };
    const { parts, hidden } = collectExplainParts([owner, ask]);
    expect(hidden.has('m4')).toBe(true);
    expect(parts.answers['m1:0']).toBeUndefined();
  });

  test('hides the reasoning of the turn an anchored message opened', () => {
    const thought = { id: 'th', role: 'assistant', content: 'mmm', isThinking: true };
    const { hidden } = collectExplainParts([owner, answer, thought, continuation]);
    expect(hidden.has('th')).toBe(true);
  });

  test('keeps reasoning that belongs to an ordinary turn', () => {
    const thought = { id: 'th', role: 'assistant', content: 'mmm', isThinking: true };
    const { hidden } = collectExplainParts([owner, thought]);
    expect(hidden.has('th')).toBe(false);
  });

  test('a visible reply closes the anchored turn, so later reasoning shows again', () => {
    const { hidden } = collectExplainParts([
      owner,
      answer,
      { id: 'reply', role: 'assistant', content: 'listo' },
      { id: 'th2', role: 'assistant', content: 'mmm', isThinking: true },
    ]);
    expect(hidden.has('th2')).toBe(false);
  });

  test('leaves an ordinary conversation alone', () => {
    const { parts, hidden } = collectExplainParts([
      { id: 'a', role: 'user', content: 'hola' },
      { id: 'b', role: 'assistant', content: 'que tal' },
    ]);
    expect(hidden.size).toBe(0);
    expect(parts).toEqual({ continuations: {}, answers: {} });
  });
});

describe('anchors', () => {
  test('an id is the authoring message plus the block index', () => {
    expect(explainBlockId('msg_7', 2)).toBe('msg_7:2');
  });

  test('round-trips through the comment marker', () => {
    const anchor = { blockId: 'msg_7:2', step: 3, kind: 'answer' as const };
    expect(parseAnchor(formatAnchor(anchor))).toEqual(anchor);
  });

  test('finds the anchor with prose around it', () => {
    const text = `Elegí "Fija, en el código".\n\n${formatAnchor({ blockId: 'm:0', step: 1, kind: 'rewrite' })}`;
    expect(parseAnchor(text)).toEqual({ blockId: 'm:0', step: 1, kind: 'rewrite' });
    expect(isAnchoredMessage(text)).toBe(true);
  });

  test('an ordinary message is not anchored', () => {
    expect(parseAnchor('explain block=nope')).toBeNull();
    expect(isAnchoredMessage('hola')).toBe(false);
  });
});
