/**
 * Font stacks for the two consumers that cannot read the CSS custom properties
 * set in `styles/fonts.css` + the Tailwind `@theme` block.
 *
 * Monaco and xterm both measure the character cell on a canvas 2d context, and
 * `CanvasRenderingContext2D.font` does not resolve `var(--font-mono)` — it
 * silently falls back to the default font, which puts every column a fraction
 * of a pixel off from what the DOM renders. So they get the family list
 * spelled out. Keep this in sync with `--font-mono` in `styles/global.css`.
 */
export const MONO_FONT_STACK =
  '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
