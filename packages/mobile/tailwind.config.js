/* eslint-disable no-bitwise -- hex ↔ canales RGB */
const colors = require('tailwindcss/colors');
const {
  DARK_BG,
  DARK_BORDER,
  DARK_TEXT,
  LIGHT_SLATE,
  SEMANTIC,
} = require('./theme.palette');

/**
 * Tema oscuro sin `dark:` en cada pantalla: los grises (`slate`, `white`) y
 * los tintes de color se leen de variables CSS que `.dark:root` reescribe.
 * Fondo, texto y borde tienen escalas propias porque en oscuro no se invierten
 * igual: `text-white` sobre un botón sigue blanco, `bg-white` se vuelve
 * superficie oscura.
 */
const FAMILIES = [
  'slate',
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
  'yellow',
  'fuchsia',
  'lime',
];
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

const rgb = hex => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};

/** `{ light: {...vars}, dark: {...vars}, theme: {...colores} }` de una propiedad. */
function scale(prop, darkFor) {
  const light = {};
  const dark = {};
  const theme = {};
  const add = (name, lightHex, darkHex) => {
    const variable = `--${prop}-${name}`;
    light[variable] = rgb(lightHex);
    dark[variable] = rgb(darkHex);
    return `rgb(var(${variable}) / <alpha-value>)`;
  };
  for (const family of FAMILIES) {
    theme[family] = {};
    for (const shade of SHADES) {
      const lightHex =
        family === 'slate' ? LIGHT_SLATE[shade] : colors[family][shade];
      theme[family][shade] = add(
        `${family}-${shade}`,
        lightHex,
        darkFor(family, shade, lightHex),
      );
    }
  }
  theme.white = add('white', '#ffffff', darkFor('white', 0, '#ffffff'));
  for (const [name, { light: l, dark: d }] of Object.entries(SEMANTIC)) {
    theme[name] = add(name, l, d);
  }
  return { light, dark, theme };
}

const bg = scale('bg', DARK_BG);
const text = scale('text', DARK_TEXT);
const border = scale('border', DARK_BORDER);

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.js', './src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  // `class` permite elegir Claro/Oscuro en Ajustes; «Sistema» sigue al teléfono.
  darkMode: 'class',
  theme: {
    extend: {
      backgroundColor: bg.theme,
      textColor: text.theme,
      borderColor: border.theme,
    },
  },
  plugins: [
    ({ addBase }) =>
      addBase({
        ':root': { ...bg.light, ...text.light, ...border.light },
        '.dark:root': { ...bg.dark, ...text.dark, ...border.dark },
      }),
  ],
};
