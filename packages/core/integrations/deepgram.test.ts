import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { transcribeAudioFromUrl } from './deepgram';

// Telegram's file URLs embed the bot token in the path.
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const URL_WITH_TOKEN = `https://api.telegram.org/file/bot${TOKEN}/voice/file_42.oga`;

const realFetch = globalThis.fetch;
const RealWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.WebSocket = RealWebSocket;
});

function logged(spies: { mock: { calls: unknown[][] } }[]): string {
  return spies.flatMap(s => s.mock.calls.map(c => c.map(String).join(' '))).join('\n');
}

describe('transcribeAudioFromUrl', () => {
  test('never logs the file URL', async () => {
    globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
    // Stop before any real call to Deepgram.
    globalThis.WebSocket = class { constructor() { throw new Error('offline in tests'); } } as unknown as typeof WebSocket;
    const out = spyOn(console, 'log').mockImplementation(() => {});
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await transcribeAudioFromUrl(URL_WITH_TOKEN, { apiKey: 'test-key' }).catch(() => {});
      const text = logged([out, err]);
      expect(text).toMatch(/Downloaded 3 bytes/);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('api.telegram.org');
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  test('a failed download does not carry the URL in its error', async () => {
    globalThis.fetch = (async (u: string) => { throw new Error(`Unable to connect: ${u}`); }) as unknown as typeof fetch;
    const error = await transcribeAudioFromUrl(URL_WITH_TOKEN, { apiKey: 'test-key' }).then(() => null, e => e as Error);
    expect(error?.message).toMatch(/^Failed to download audio/);
    expect(error?.message).not.toContain(TOKEN);
  });
});

import { applyDeepgramSettings, deepgramSettingsView, nextSecretValue } from './deepgram';
import { loadDeepgramSettings, saveDeepgramSettings } from '../session/storage';

describe('Deepgram settings: the API key is write-only', () => {
  const KEY = 'dg-test-0123456789abcdef';
  let before: ReturnType<typeof loadDeepgramSettings>;
  const keep = () => { before = loadDeepgramSettings(); };
  const restore = () => saveDeepgramSettings(before);

  test('the view says whether a key is saved, never which', () => {
    keep();
    try {
      saveDeepgramSettings({ apiKey: KEY, model: 'nova-3', language: 'es' });
      const view = deepgramSettingsView();
      expect(view).toEqual({ configured: true, model: 'nova-3', language: 'es' });
      expect(JSON.stringify(view)).not.toContain(KEY);
      saveDeepgramSettings({ apiKey: '', model: 'nova-3', language: 'es' });
      expect(deepgramSettingsView().configured).toBe(false);
    } finally { restore(); }
  });

  test('an empty or missing key keeps the saved one; a new one replaces it; clearApiKey removes it', () => {
    keep();
    try {
      saveDeepgramSettings({ apiKey: KEY, model: 'nova-3', language: 'multi' });
      // The settings form re-saving without touching the key.
      expect(applyDeepgramSettings({ apiKey: '', model: 'nova-2', language: 'en' })).toEqual({ ok: true, configured: true });
      expect(loadDeepgramSettings()).toEqual({ apiKey: KEY, model: 'nova-2', language: 'en' });
      expect(applyDeepgramSettings({ model: 'nova-3' }).configured).toBe(true);
      expect(loadDeepgramSettings()).toEqual({ apiKey: KEY, model: 'nova-3', language: 'en' });

      expect(applyDeepgramSettings({ apiKey: '  new-key  ' }).configured).toBe(true);
      expect(loadDeepgramSettings().apiKey).toBe('new-key');

      // What the new form sends to clear — `apiKey: ''` alongside, for bridges that predate clearApiKey.
      expect(applyDeepgramSettings({ apiKey: '', clearApiKey: true })).toEqual({ ok: true, configured: false });
      expect(loadDeepgramSettings().apiKey).toBe('');
      saveDeepgramSettings({ apiKey: KEY, model: 'nova-3', language: 'multi' });
      expect(applyDeepgramSettings({ apiKey: null }).configured).toBe(false);
    } finally { restore(); }
  });

  test('emptied model and language fall back to the defaults; garbage bodies change nothing', () => {
    keep();
    try {
      saveDeepgramSettings({ apiKey: KEY, model: 'nova-2', language: 'es' });
      applyDeepgramSettings({ model: ' ', language: '' });
      expect(loadDeepgramSettings()).toEqual({ apiKey: KEY, model: 'nova-3', language: 'multi' });
      applyDeepgramSettings(null);
      applyDeepgramSettings('nope');
      expect(loadDeepgramSettings()).toEqual({ apiKey: KEY, model: 'nova-3', language: 'multi' });
    } finally { restore(); }
  });

  test('nextSecretValue', () => {
    expect(nextSecretValue('old', undefined, undefined)).toBe('old');
    expect(nextSecretValue('old', '   ', undefined)).toBe('old');
    expect(nextSecretValue('old', 42, undefined)).toBe('old');
    expect(nextSecretValue('old', ' new ', undefined)).toBe('new');
    expect(nextSecretValue('old', 'new', true)).toBe('');
    expect(nextSecretValue('old', null, undefined)).toBe('');
  });
});
