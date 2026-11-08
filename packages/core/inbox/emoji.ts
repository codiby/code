/**
 * Slack's `:shortcode:` emoji → something the app can show. Standard names
 * come from gemoji (GitHub's set, which Slack's names follow); a workspace's
 * custom emoji are images, learned from `emoji.list` when the app has
 * `emoji:read`. Skin tones are separate codes in Slack (`:wave::skin-tone-3:`)
 * and become a modifier on the emoji before them.
 */

import { gemoji } from 'gemoji';

export type EmojiGlyph = { unicode: string } | { url: string };

const standard = new Map<string, string>();
for (const g of gemoji) for (const name of g.names) standard.set(name, g.emoji);
// Slack names gemoji doesn't carry.
for (const [name, ch] of Object.entries({
  simple_smile: '🙂', slightly_smiling_face: '🙂', white_check_mark: '✅', heavy_check_mark: '✔️',
  thumbsup_all: '👍', party_parrot: '🦜', 'face_with_rolling_eyes': '🙄', 'hugging_face': '🤗',
})) if (!standard.has(name)) standard.set(name, ch);

const TONES: Record<string, string> = {
  'skin-tone-2': '\u{1F3FB}', 'skin-tone-3': '\u{1F3FC}', 'skin-tone-4': '\u{1F3FD}',
  'skin-tone-5': '\u{1F3FE}', 'skin-tone-6': '\u{1F3FF}',
};

/** Custom emoji per connected workspace, looked up as one set: two
 *  workspaces rarely share a custom name, and when they do either image is
 *  close enough for a preview. */
const workspaces = new Map<string, Map<string, string>>();
let custom = new Map<string, string>();

/** Install a workspace's custom emoji (`emoji.list` → name → url or `alias:x`).
 *  `workspace` defaults to a single shared slot (tests, one connection). */
export function setCustomEmoji(list: Record<string, string>, workspace = 'default'): void {
  workspaces.set(workspace, new Map(Object.entries(list)));
  custom = new Map([...workspaces.values()].flatMap(m => [...m]));
}

export function resolveEmoji(name: string, depth = 0): EmojiGlyph | null {
  const base = name.replace(/::skin-tone-[2-6]$/, '');
  const tone = /::(skin-tone-[2-6])$/.exec(name)?.[1];
  const std = standard.get(base);
  if (std) return { unicode: tone ? std + TONES[tone] : std };
  const c = custom.get(base);
  if (!c) return null;
  if (c.startsWith('alias:')) return depth < 3 ? resolveEmoji(c.slice(6), depth + 1) : null;
  return { url: c };
}

/** `:name:` and `:name::skin-tone-N:` in a stretch of text. */
export const EMOJI_RE = /:([a-z0-9_+'-]+(?:::skin-tone-[2-6])?):/g;

/** Replace shortcodes in plain text: unicode where there is one, the code
 *  itself otherwise (a custom image can't live in plain text). */
export function emojifyPlain(text: string): string {
  return text.replace(EMOJI_RE, (m, name: string) => {
    const g = resolveEmoji(name);
    return g && 'unicode' in g ? g.unicode : m;
  });
}

/** Replace shortcodes in Markdown: unicode, or an inline image for custom
 *  emoji (alt `:name:`, which the Inbox styles to text height). */
export function emojifyMarkdown(text: string): string {
  return text.replace(EMOJI_RE, (m, name: string) => {
    const g = resolveEmoji(name);
    if (!g) return m;
    return 'unicode' in g ? g.unicode : `![:${name}:](${g.url})`;
  });
}

export interface EmojiMatch { name: string; unicode?: string; url?: string }

/** Emoji by name for a picker: prefix matches first, then anywhere in the
 *  name, then tags (`ok` finds 👍). Empty query → a few common ones. */
export function searchEmoji(query: string, limit = 48): EmojiMatch[] {
  const q = query.trim().toLowerCase().replace(/^:|:$/g, '');
  if (!q) {
    return ['thumbsup', 'heart', 'joy', 'pray', 'eyes', 'tada', 'white_check_mark', 'fire', 'rocket', 'raised_hands',
      'clap', 'ok_hand', '100', 'thinking_face', 'grinning', 'sweat_smile', 'muscle', 'wave', 'x', 'warning']
      .map(name => ({ name, unicode: standard.get(name)! })).filter(e => e.unicode);
  }
  const out: EmojiMatch[] = [];
  const seen = new Set<string>();
  const push = (name: string, glyph: EmojiGlyph | null) => {
    if (!glyph || seen.has(name) || out.length >= limit) return;
    seen.add(name);
    out.push({ name, ...glyph });
  };
  for (const pass of [(n: string) => n.startsWith(q), (n: string) => n.includes(q)]) {
    for (const name of standard.keys()) if (pass(name)) push(name, { unicode: standard.get(name)! });
    for (const name of custom.keys()) if (pass(name)) push(name, resolveEmoji(name));
  }
  for (const g of gemoji) if (g.tags.some(t => t.startsWith(q))) push(g.names[0]!, { unicode: g.emoji });
  return out;
}
