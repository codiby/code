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
