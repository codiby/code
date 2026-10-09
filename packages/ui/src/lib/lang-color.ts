/**
 * Accent color for a file's language, shown as the small dot in editor tabs.
 * Kept to a handful of hues so the strip reads as a hint, not a rainbow;
 * anything unlisted falls back to neutral zinc.
 */

const BY_EXT: Record<string, string> = {
  ts: '#3b82f6', tsx: '#3b82f6', mts: '#3b82f6', cts: '#3b82f6',
  js: '#facc15', jsx: '#facc15', mjs: '#facc15', cjs: '#facc15',
  json: '#facc15', jsonc: '#facc15',
  py: '#4ade80', go: '#22d3ee', rs: '#fb923c', swift: '#fb923c',
  java: '#f87171', kt: '#a78bfa', rb: '#f87171', php: '#a78bfa',
  c: '#60a5fa', h: '#60a5fa', cpp: '#60a5fa', hpp: '#60a5fa', cs: '#a78bfa',
  html: '#fb923c', htm: '#fb923c', css: '#38bdf8', scss: '#f472b6', less: '#38bdf8',
  vue: '#4ade80', svelte: '#fb923c',
  yaml: '#f87171', yml: '#f87171', toml: '#f87171',
  sh: '#4ade80', bash: '#4ade80', zsh: '#4ade80', fish: '#4ade80',
  sql: '#38bdf8', graphql: '#f472b6', gql: '#f472b6',
  md: '#a1a1aa', markdown: '#a1a1aa', txt: '#71717a', log: '#71717a',
};

const NEUTRAL = '#71717a';

export function langColor(fileName: string): string {
  const name = fileName.split(/[\\/]/).pop() || '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return NEUTRAL;
  return BY_EXT[name.slice(dot + 1).toLowerCase()] ?? NEUTRAL;
}
