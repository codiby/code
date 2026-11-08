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

let custom = new Map<string, string>();

/** Install the workspace's custom emoji (`emoji.list` → name → url or `alias:x`). */
export function setCustomEmoji(list: Record<string, string>): void {
  custom = new Map(Object.entries(list));
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
