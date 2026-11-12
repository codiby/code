/* eslint-disable no-bitwise -- hex ↔ canales RGB */
/**
 * Equivalentes oscuros de la paleta clara. Lo usan `tailwind.config.js` (para
 * las clases) y `src/theme.ts` (para los colores que van por props, como los
 * de iconos), así que un cambio aquí repinta las dos cosas por igual.
 */
const colors = require('tailwindcss/colors');

/**
 * Grises neutros en vez de `slate`: el tinte azul del pizarra es lo que hacía
 * ver la app anticuada. Las clases siguen llamándose `slate-*`; solo cambian
 * los valores, en claro (`LIGHT_SLATE`) y en oscuro (`SLATE_*`).
 */
const LIGHT_SLATE = {
  50: '#f9fafb',
  100: '#f4f5f7',
  200: '#eceef1',
  300: '#d9dce1',
  400: '#a2a8b2',
  500: '#6a707a',
  600: '#555b64',
  700: '#3c414a',
  800: '#23272d',
  900: '#0d0f12',
  950: '#08090b',
};

/**
 * Página y superficie son el mismo tono, como en la app de chats: lo que
 * separa es la línea fina (`slate-200`) y el gris de selección (`slate-100`).
 */
const PAGE = '#0b0c0e';
const SURFACE = '#0b0c0e';

function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const channel = shift =>
    Math.round(((pa >> shift) & 255) * t + ((pb >> shift) & 255) * (1 - t));
  return `#${((channel(16) << 16) | (channel(8) << 8) | channel(0))
    .toString(16)
    .padStart(6, '0')}`;
}

const SLATE_BG = {
  50: '#111316',
  100: '#15181c',
  200: '#1b1e23',
  300: '#262a30',
  400: '#3a3f47',
  500: '#666c76',
  600: '#7d838d',
  700: '#262a30',
  800: '#1b1e23',
  // Botones principales: en oscuro se invierten (claro sobre la página), y
  // lo que va encima usa `text-slate-50`, que también se invierte.
  900: '#eef1f4',
  950: '#ffffff',
};
const SLATE_TEXT = {
  50: '#0b0c0e',
  100: '#15181c',
  200: '#1b1e23',
  300: '#4a5059',
  400: '#666c76',
  500: '#949aa4',
  600: '#aeb3bb',
  700: '#c8ccd2',
  800: '#dde0e4',
  900: '#eef1f4',
  950: '#f7f8f9',
};
const SLATE_BORDER = {
  50: '#111316',
  100: '#16191d',
  200: '#1b1e23',
  300: '#262a30',
  400: '#3a3f47',
  500: '#666c76',
  600: '#949aa4',
  700: '#949aa4',
  800: '#c8ccd2',
  900: '#eef1f4',
  950: '#f7f8f9',
};

/**
 * Colores con nombre propio (`bg-accent`, `text-on-accent`…). Mismos valores
 * que la app de chats: verde #0b7d5c en claro, #2bd49a en oscuro.
 */
const SEMANTIC = {
  accent: { light: '#0b7d5c', dark: '#2bd49a' },
  'on-accent': { light: '#ffffff', dark: '#0b0c0e' },
  tint: { light: '#e9f3ef', dark: '#15271f' },
  bubble: { light: '#0b7d5c', dark: '#1d4d3c' },
  'on-bubble': { light: '#ffffff', dark: '#eef1f4' },
  dock: { light: '#ffffff', dark: '#16191e' },
};

function DARK_BG(family, shade, hex) {
  if (family === 'white') {
    return SURFACE;
  }
  if (family === 'slate') {
    return SLATE_BG[shade];
  }
  const c = colors[family];
  return (
    {
      50: mix(c[900], SURFACE, 0.35),
      100: mix(c[900], SURFACE, 0.5),
      200: mix(c[800], SURFACE, 0.6),
      300: c[800],
    }[shade] ?? hex
  );
}

function DARK_TEXT(family, shade, hex) {
  if (family === 'white') {
    return hex;
  }
  if (family === 'slate') {
    return SLATE_TEXT[shade];
  }
  const c = colors[family];
  return (
    { 500: c[400], 600: c[400], 700: c[300], 800: c[200], 900: c[100] }[
      shade
    ] ?? hex
  );
}

function DARK_BORDER(family, shade, hex) {
  if (family === 'white') {
    return SURFACE;
  }
  if (family === 'slate') {
    return SLATE_BORDER[shade];
  }
  const c = colors[family];
  return (
    {
      50: mix(c[800], SURFACE, 0.4),
      100: mix(c[800], SURFACE, 0.5),
      200: mix(c[700], SURFACE, 0.6),
      300: c[700],
    }[shade] ?? hex
  );
}

/**
 * Colores sueltos (iconos, spinners, puntos de grupo) → su versión en cada
 * tema. El código sigue escribiendo hex de `slate`; aquí se traducen.
 */
const INK_LIGHT = {};
const INK_DARK = {};
for (const [shade, hex] of Object.entries(colors.slate)) {
  if (LIGHT_SLATE[shade]) {
    INK_LIGHT[hex] = LIGHT_SLATE[shade];
    INK_DARK[hex] = SLATE_TEXT[shade];
  }
}
for (const family of [
  'rose',
  'emerald',
  'amber',
  'indigo',
  'violet',
  'blue',
  'green',
  'red',
  'sky',
  'cyan',
  'pink',
  'purple',
  'teal',
  'orange',
  'fuchsia',
]) {
  for (const shade of [600, 700, 800]) {
    INK_DARK[colors[family][shade]] = colors[family][400];
  }
}
// El primero gana: `accent` y `bubble` comparten el verde en claro, y un
// icono con ese verde es un acento, no una burbuja.
for (const { light, dark } of Object.values(SEMANTIC)) {
  INK_DARK[light] = INK_DARK[light] ?? dark;
}

module.exports = {
  PAGE,
  SURFACE,
  LIGHT_SLATE,
  SEMANTIC,
  INK_LIGHT,
  INK_DARK,
  DARK_BG,
  DARK_TEXT,
  DARK_BORDER,
};
