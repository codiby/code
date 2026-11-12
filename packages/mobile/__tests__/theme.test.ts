import { DARK_PAGE, DARK_SURFACE, INK_DARK, INK_LIGHT } from '../src/themeInk';

const palette = require('../theme.palette');

test('las tablas de colores del bundle coinciden con la paleta de Tailwind', () => {
  expect(INK_LIGHT).toEqual(palette.INK_LIGHT);
  expect(INK_DARK).toEqual(palette.INK_DARK);
  expect(DARK_PAGE).toBe(palette.PAGE);
  expect(DARK_SURFACE).toBe(palette.SURFACE);
});

test('los grises de iconos pierden el tinte azul en los dos temas', () => {
  expect(INK_LIGHT['#0f172a']).toBe('#0d0f12');
  expect(INK_DARK['#0f172a']).toBe('#eef1f4');
  expect(INK_DARK['#0b7d5c']).toBe('#2bd49a');
});
