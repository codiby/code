import { describe, expect, test } from 'bun:test';
import { ELEVENLABS_CLEAR_KEY, elevenLabsKeyForSave, elevenLabsKeyState } from './voice-key';

describe('ElevenLabs key in voice settings', () => {
  test('a current bridge only says whether a key is saved', () => {
    expect(elevenLabsKeyState({ configured: true, voiceId: 'v' })).toEqual({ configured: true, legacy: null });
    expect(elevenLabsKeyState({ configured: false })).toEqual({ configured: false, legacy: null });
    expect(elevenLabsKeyState(undefined)).toEqual({ configured: false, legacy: null });
    // Only a literal true counts.
    expect(elevenLabsKeyState({ configured: 'yes' }).configured).toBe(false);
  });

  test('a bridge that still returns the key is treated as legacy', () => {
    expect(elevenLabsKeyState({ apiKey: 'sk-old' })).toEqual({ configured: true, legacy: { key: 'sk-old' } });
    expect(elevenLabsKeyState({ apiKey: '' })).toEqual({ configured: false, legacy: { key: '' } });
  });

  test('an empty field sends no key, so the saved one is kept', () => {
    expect(elevenLabsKeyForSave('', null)).toEqual({});
    expect(elevenLabsKeyForSave('   ', null)).toEqual({});
  });

  test('a typed key replaces the saved one, trimmed', () => {
    expect(elevenLabsKeyForSave('  sk-new ', null)).toEqual({ apiKey: 'sk-new' });
    expect(elevenLabsKeyForSave('sk-new', { key: 'sk-old' })).toEqual({ apiKey: 'sk-new' });
  });

  test('a legacy bridge gets its own key back when the field is empty', () => {
    expect(elevenLabsKeyForSave('', { key: 'sk-old' })).toEqual({ apiKey: 'sk-old' });
    expect(elevenLabsKeyForSave('', { key: '' })).toEqual({});
  });

  test('"Clear key" asks for the key to be removed', () => {
    expect(ELEVENLABS_CLEAR_KEY).toEqual({ apiKey: '', clearApiKey: true });
  });
});
