import { describe, expect, test } from 'bun:test';
import { plainSlackText, slackMessageToItem, slackPermalink, type SlackLookup } from './slack-events';

const lookup: SlackLookup = {
  me: 'UME',
  teamUrl: 'https://acme.slack.com/',
  userName: id => ({ UME: 'jovaz', UMR: 'Mariana Ruiz', UDL: 'Daniel López' } as Record<string, string>)[id] ?? id,
  channelName: id => ({ C1: 'up-dev' } as Record<string, string>)[id] ?? id,
  myThreads: new Set(['100.000']),
};

describe('slackMessageToItem', () => {
  test('a mention in a channel', () => {
    const it = slackMessageToItem({ channel: 'C1', channel_type: 'channel', user: 'UMR', text: '<@UME> ¿puedes revisar?', ts: '200.5' }, lookup)!;
    expect(it.kind).toBe('mention');
    expect(it.title).toBe('Mariana Ruiz');
    expect(it.body).toBe('@jovaz ¿puedes revisar?');
    expect(it.context.where).toBe('#up-dev');
    expect(it.id).toBe('slack:C1:200.5');
    expect(it.occurredAt).toBe(200500);
    expect(it.url).toBe('https://acme.slack.com/archives/C1/p2005');
  });

  test('a direct message, even without a mention', () => {
    const it = slackMessageToItem({ channel: 'D9', channel_type: 'im', user: 'UDL', text: 'listo', ts: '300.1' }, lookup)!;
    expect(it.kind).toBe('dm');
    expect(it.context.where).toBe('direct message');
  });

  test('a reply in a thread the user wrote in', () => {
    const it = slackMessageToItem({ channel: 'C1', channel_type: 'channel', user: 'UMR', text: 'ok', ts: '101.0', thread_ts: '100.000' }, lookup)!;
    expect(it.kind).toBe('thread_reply');
    expect(it.url).toContain('thread_ts=100.000');
  });

  test('ignores own messages, bots, edits, and channel chatter', () => {
    expect(slackMessageToItem({ channel: 'C1', user: 'UME', text: '<@UME>', ts: '1' }, lookup)).toBeNull();
    expect(slackMessageToItem({ channel: 'D1', channel_type: 'im', user: 'UMR', bot_id: 'B1', text: 'x', ts: '1' }, lookup)).toBeNull();
    expect(slackMessageToItem({ channel: 'C1', subtype: 'message_changed', user: 'UMR', text: '<@UME>', ts: '1' }, lookup)).toBeNull();
    expect(slackMessageToItem({ channel: 'C1', channel_type: 'channel', user: 'UMR', text: 'hola equipo', ts: '1' }, lookup)).toBeNull();
  });
});

describe('plainSlackText / permalinks', () => {
  test('markup becomes readable text', () => {
    expect(plainSlackText('<@UMR> en <#C1|up-dev>: <https://x.dev|el PR> &amp; <!here>', lookup.userName))
      .toBe('@Mariana Ruiz en #up-dev: el PR & @here');
  });
  test('no team url, no link', () => {
    expect(slackPermalink(undefined, 'C1', '1.2')).toBeNull();
  });
});

import { slackToMarkdown } from './slack-events';
describe('slackToMarkdown', () => {
  const md = (t: string) => slackToMarkdown(t, lookup.userName);
  test('formatting, links and mentions', () => {
    expect(md('*Pending review* on _web_ ~old~ <https://gh.io/p/1|#6120> <@UMR> <!here>'))
      .toBe('**Pending review** on *web* ~~old~~ [#6120](https://gh.io/p/1) [@Mariana Ruiz](slack-user:UMR) **@here**');
  });
  test('your own mention stays plain', () => {
    expect(slackToMarkdown('<@UMR> hola', lookup.userName, 'UMR')).toBe('**@Mariana Ruiz** hola');
  });
  test('bullets become list items, nested ones indented', () => {
    expect(md('• uno\n    ◦ dos')).toBe('- uno\n  - dos');
  });
  test('code is left alone', () => {
    expect(md('usa `*no bold*` y\n```\n*literal* &lt;x&gt;\n```')).toBe('usa `*no bold*` y\n```\n*literal* <x>\n```');
    expect(md('```inline block```')).toBe('```\ninline block\n```');
  });
  test('a leading # is not a heading; entities decode', () => {
    expect(md('#general &amp; co')).toBe('\\#general & co');
  });
});

import { resolveEmoji, setCustomEmoji } from './emoji';
describe('emoji', () => {
  test('standard shortcodes, skin tones, Slack-only names', () => {
    expect(slackToMarkdown(':thumbsup: :rocket: :wave::skin-tone-3: :white_check_mark:', lookup.userName)).toBe('👍 🚀 👋🏼 ✅');
    expect(plainSlackText('listo :tada:', lookup.userName)).toBe('listo 🎉');
  });
  test('custom workspace emoji become inline images; aliases follow; unknown stay as text', () => {
    setCustomEmoji({ partyparrot: 'https://emoji.slack-edge.com/T1/parrot.gif', pp: 'alias:partyparrot' });
    expect(slackToMarkdown(':pp: :nope:', lookup.userName)).toBe('![:pp:](https://emoji.slack-edge.com/T1/parrot.gif) :nope:');
    expect(plainSlackText(':partyparrot:', lookup.userName)).toBe(':partyparrot:');
    expect(resolveEmoji('pp')).toEqual({ url: 'https://emoji.slack-edge.com/T1/parrot.gif' });
    setCustomEmoji({});
  });
  test('times and code are not emoji', () => {
    expect(slackToMarkdown('a las 10:30:45 `:tada:`', lookup.userName)).toBe('a las 10:30:45 `:tada:`');
  });
});

import { itemsAnsweredBy } from './slack-events';
describe('itemsAnsweredBy', () => {
  const it = (id: string, channel: string, ts: string, threadTs: string | null = null) =>
    ({ id, source: 'slack', context: { channel, ts, threadTs } });
  const items = [
    it('mention-root', 'C1', '100.0'),            // a mention that opened a thread
    it('reply-in-thread', 'C1', '105.0', '100.0'), // a reply in that thread
    it('other-thread', 'C1', '200.0', '190.0'),
    it('dm-old', 'D1', '50.0'),
    it('dm-new', 'D1', '70.0'),
  ];
  test('a reply in a thread answers that thread, opening message included', () => {
    expect(itemsAnsweredBy(items, { channel: 'C1', ts: '110.0', thread_ts: '100.0' }).sort()).toEqual(['mention-root', 'reply-in-thread']);
  });
  test('in a DM, a message answers what came before it', () => {
    expect(itemsAnsweredBy(items, { channel: 'D1', ts: '60.0' })).toEqual(['dm-old']);
  });
  test('a top-level message in a channel answers nothing', () => {
    expect(itemsAnsweredBy(items, { channel: 'C1', ts: '300.0' })).toEqual([]);
  });
});

import { searchEmoji } from './emoji';
describe('searchEmoji', () => {
  test('prefix first, tags too, and a default set', () => {
    expect(searchEmoji('rock')[0]).toEqual({ name: 'rock', unicode: '🪨' });
    expect(searchEmoji('rock').some(e => e.name === 'rocket')).toBe(true);
    expect(searchEmoji('ok').some(e => e.unicode === '👍')).toBe(true);
    expect(searchEmoji('')[0]?.name).toBe('thumbsup');
  });
});
