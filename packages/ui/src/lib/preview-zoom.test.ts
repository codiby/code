import { expect, test } from 'bun:test';
import { zoomAt } from './preview-zoom';

test('zoom keeps the tapped image point under the finger, including after panning', () => {
  const start = { scale: 2, x: 40, y: -30 };
  const anchor = { x: 100, y: 80 };
  const next = zoomAt(start, 4, anchor);
  expect((anchor.x - next.x) / next.scale).toBe((anchor.x - start.x) / start.scale);
  expect((anchor.y - next.y) / next.scale).toBe((anchor.y - start.y) / start.scale);
  expect(zoomAt(next, 2, anchor)).toEqual(start);
});

test('zoom is limited to the supported range', () => {
  expect(zoomAt({ scale: 1, x: 0, y: 0 }, 20, { x: 0, y: 0 }).scale).toBe(6);
  expect(zoomAt({ scale: 1, x: 0, y: 0 }, 0.1, { x: 0, y: 0 }).scale).toBe(1);
});
