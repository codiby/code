/**
 * Turns bare URLs, `www.` hosts, plain domains and email addresses into links,
 * for text the author never wrote as Markdown.
 *
 * This runs over the HTML `renderMarkdown` already produced, so it has to skip
 * anything that is already a link, already code, or is markup rather than
 * text — otherwise it would rewrite `href` attributes and double-link
 * `[text](url)` that the Markdown pass handled properly.
 */

/**
 * Schemeless domains only link when they end in one of these. The list is
 * deliberately short and excludes anything that doubles as a file extension:
 * this renderer shows a lot of chat about `bridge.ts`, `main.rs`, `build.sh`
 * and `README.md`, and none of those may turn blue. Anything exotic still
 * links once the author writes `https://` or `www.`.
 */
const BARE_TLDS = [
  'com', 'org', 'net', 'edu', 'gov', 'int', 'mil',
  'io', 'dev', 'app', 'ai', 'co', 'me', 'tv',
  'info', 'biz', 'xyz', 'cloud', 'tech', 'blog', 'site', 'online', 'store',
];

/** Regions the autolinker must not touch: existing links, code, and any tag. */
const SKIP = /<(a|code|pre|button)\b[^>]*>[\s\S]*?<\/\1>|<[^>]*>/gi;

const HOST = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9-]+)*';
const PATH = '(?:\\/[^\\s<>"\'`]*)?';
/** The label right before a schemeless TLD must contain a letter, so a version
 *  string like `1.2.co` stays plain text. */
const BARE_HOST = `(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)*[A-Za-z0-9-]*[A-Za-z][A-Za-z0-9-]*`;

const CANDIDATE = new RegExp(
  // Never start mid-word, mid-path or mid-address: `packages/foo.io` and the
  // `x.com` inside `me@x.com` must not match on their own.
  '(?<![\\w@./-])(' +
    `https?:\\/\\/[^\\s<>"'\`]+` + '|' +
    `www\\.[^\\s<>"'\`]+` + '|' +
    `[A-Za-z0-9._%+-]+@${HOST}\\.[A-Za-z]{2,}` + '|' +
    `${BARE_HOST}\\.(?:${BARE_TLDS.join('|')})\\b${PATH}` +
  ')',
  'g',
);

const EMAIL = /^[A-Za-z0-9._%+-]+@/;

function count(text: string, char: string): number {
  let n = 0;
  for (const c of text) if (c === char) n++;
  return n;
}

/**
 * Drops punctuation that belongs to the sentence rather than the URL, so
 * "see https://x.com." links to `https://x.com` and "(github.com/a)" doesn't
 * swallow the closing paren. A closing paren is kept when the URL opened one
 * itself — Wikipedia-style `…/Foo_(bar)` stays intact.
 */
function trimTrailing(url: string): [href: string, tail: string] {
  let end = url.length;
  while (end > 0) {
    const c = url[end - 1];
    if (c === ';' && /&[a-z]+;$/i.test(url.slice(0, end))) break; // `&amp;`
    if ('.,!?:;\'"'.includes(c)) { end--; continue; }
    // Weigh the parens *before* this one: `…/Foo_(bar)` opened its own, while
    // the `)` in `(github.com/a)` closes the prose around it.
    if (c === ')' && count(url.slice(0, end - 1), '(') <= count(url.slice(0, end - 1), ')')) { end--; continue; }
    break;
  }
  return [url.slice(0, end), url.slice(end)];
}

function anchor(text: string): string {
  const [href, tail] = trimTrailing(text);
  if (!href) return text;
  const target = EMAIL.test(href)
    ? `mailto:${href}`
    : /^https?:\/\//i.test(href) ? href : `https://${href}`;
  return `<a href="${target}" target="_blank" rel="noopener noreferrer"`
    + ` class="text-blue-400 hover:underline break-all">${href}</a>${tail}`;
}

/** Link the bare URLs in a plain-text run. Input must already be HTML-escaped. */
export function autolinkText(text: string): string {
  return text.replace(CANDIDATE, (match) => anchor(match));
}

/** Link the bare URLs in rendered Markdown, leaving markup and code alone. */
export function autolinkHtml(html: string): string {
  let out = '';
  let last = 0;
  for (const m of html.matchAll(SKIP)) {
    out += autolinkText(html.slice(last, m.index));
    out += m[0];
    last = m.index + m[0].length;
  }
  return out + autolinkText(html.slice(last));
}
