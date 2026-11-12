import { describe, expect, test } from 'bun:test';
import { channelHeader } from './format';
import { exampleChannelHeader, personaPrompt } from './prompt';

/** `[<Label> · <Wkd> <DD> <Mon> <HH:MM>]`, nothing else. */
const HEADER = /^\[[^\]·]+ · (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([01]\d|2[0-3]):[0-5]\d\]$/;

describe('channelHeader', () => {
  test('is exactly "[Label · Wkd DD Mon HH:MM]" in the owner\'s timezone', () => {
    // 2026-11-12T06:14Z is 00:14 on Thursday in Mexico City (UTC-6).
    expect(channelHeader('Telegram', Date.parse('2026-11-12T06:14:00Z'), 'America/Mexico_City')).toBe('[Telegram · Thu 12 Nov 00:14]');
    expect(channelHeader('WhatsApp', Date.parse('2026-11-12T06:14:00Z'), 'UTC')).toBe('[WhatsApp · Thu 12 Nov 06:14]');
  });

  test('the zone can move the date, and the weekday follows it', () => {
    // Still Wednesday 11 Nov in Los Angeles.
    expect(channelHeader('App', Date.parse('2026-11-12T06:14:00Z'), 'America/Los_Angeles')).toBe('[App · Wed 11 Nov 22:14]');
    expect(channelHeader('App', Date.parse('2026-11-12T06:14:00Z'), 'Asia/Tokyo')).toBe('[App · Thu 12 Nov 15:14]');
  });

  test('ICU quirks never show: no "Sept", no "24:00", no commas or "at", single digits padded', () => {
    expect(channelHeader('Webhook', Date.parse('2026-09-03T00:05:00Z'), 'UTC')).toBe('[Webhook · Thu 03 Sep 00:05]');
    expect(channelHeader('Webhook', Date.parse('2026-01-04T09:07:00Z'), 'UTC')).toBe('[Webhook · Sun 04 Jan 09:07]');
    for (let month = 0; month < 12; month++) {
      for (const hour of [0, 9, 12, 23]) {
        const at = Date.UTC(2026, month, 28, hour, 1);
        expect(channelHeader('iOS Shortcut', at, 'Europe/Madrid')).toMatch(HEADER);
      }
    }
  });

  test('does not depend on the ICU string formatter at all', () => {
    // Even if format() changed its output, the header would not. (`format`
    // is an accessor on the prototype, so it is swapped by hand.)
    const proto = Intl.DateTimeFormat.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, 'format')!;
    Object.defineProperty(proto, 'format', { configurable: true, get: () => () => 'Thursday, 12 September at 24:14' });
    try {
      expect(new Intl.DateTimeFormat('en-GB').format(new Date())).toBe('Thursday, 12 September at 24:14');
      expect(channelHeader('Telegram', Date.parse('2026-11-12T06:14:00Z'), 'UTC')).toBe('[Telegram · Thu 12 Nov 06:14]');
    } finally {
      Object.defineProperty(proto, 'format', original);
    }
  });

  test('an unknown timezone still gives the same shape (in UTC)', () => {
    expect(channelHeader('Telegram', Date.parse('2026-11-12T06:14:00Z'), 'Mars/Olympus_Mons')).toBe('[Telegram · Thu 12 Nov 06:14]');
  });
});

describe('persona prompt header example', () => {
  test('is a header channelHeader really produces', () => {
    expect(exampleChannelHeader()).toBe('[Telegram · Wed 12 Nov 09:14]');
    expect(exampleChannelHeader()).toMatch(HEADER);
    expect(personaPrompt()).toContain(`starts with a header like \`${exampleChannelHeader()}\``);
  });
});
