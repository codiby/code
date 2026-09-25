import { describe, expect, it } from 'bun:test';
import { parseToolResultImages } from './tool-result-images';

describe('parseToolResultImages', () => {
  it('pulls base64 images and their text out of a serialised content array', () => {
    const content = JSON.stringify([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      { type: 'text', text: 'caption' },
    ]);
    expect(parseToolResultImages(content)).toEqual({ images: ['data:image/jpeg;base64,AAAA'], text: 'caption' });
  });

  it('defaults the media type to png', () => {
    const content = [{ type: 'image', source: { type: 'base64', data: 'BBBB' } }];
    expect(parseToolResultImages(content)?.images).toEqual(['data:image/png;base64,BBBB']);
  });

  it('leaves plain and truncated text alone', () => {
    expect(parseToolResultImages('     1\tconst a = 1')).toBeNull();
    expect(parseToolResultImages('[{"type":"image","source":{"type":"base64","data":"AA')).toBeNull();
    expect(parseToolResultImages(JSON.stringify([{ type: 'text', text: 'hi' }]))).toBeNull();
  });
});
