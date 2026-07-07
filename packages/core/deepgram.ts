/**
 * Deepgram speech-to-text client.
 *
 * We open a live WebSocket to Deepgram's `/v1/listen` endpoint, stream the
 * audio bytes in ~8 KB chunks, then send a `CloseStream` control message so
 * Deepgram flushes all final transcripts before closing the socket.
 *
 * Why live-stream a complete file instead of the REST prerecorded endpoint?
 *  1. The user explicitly asked for an "active socket connection".
 *  2. Streaming lets us report interim transcripts in the future (we don't
 *     use them yet, but the plumbing is here).
 *  3. Same codepath will work once we add mic-streaming from the UI.
 */

import { log, logError } from './logger';
import { loadDeepgramSettings } from './storage';

export interface TranscribeOptions {
  /** Override persisted API key (e.g. tests). */
  apiKey?: string;
  /** Override persisted model. */
  model?: string;
  /** Override persisted language. */
  language?: string;
  /** Bail out if the socket doesn't close within this many ms. */
  timeoutMs?: number;
}

export interface TranscribeResult {
  /** Joined final transcript across the whole file. */
  transcript: string;
  /** Audio duration in seconds (reported by Deepgram metadata). */
  durationSec: number;
  /** Detected language, if Deepgram returned one. */
  detectedLanguage?: string;
}

/**
 * Stream a complete audio buffer (OGG/Opus, MP3, WAV, …) to Deepgram via
 * WebSocket and return the joined final transcript. Deepgram auto-detects
 * the container when we don't pass `encoding`, which is what Telegram voice
 * notes (OGG/Opus) need.
 */
export async function transcribeAudioBuffer(
  audio: Uint8Array,
  opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const settings = loadDeepgramSettings();
  const apiKey = opts.apiKey || settings.apiKey;
  if (!apiKey) throw new Error('Deepgram API key not configured');

  const model = opts.model || settings.model || 'nova-3';
  const language = opts.language || settings.language || 'multi';
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const params = new URLSearchParams({
    model,
    smart_format: 'true',
    punctuate: 'true',
    language,
  });
  const wsUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

  return new Promise<TranscribeResult>((resolve, reject) => {
    let settled = false;
    const finalize = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const ws = new WebSocket(wsUrl, {
      // Bun supports a `headers` option on the WebSocket client. On
      // runtimes that don't, Deepgram also accepts auth via the
      // `token` subprotocol — falling back there keeps us portable.
      // @ts-expect-error — Bun-specific extension
      headers: { Authorization: `Token ${apiKey}` },
    });

    const transcripts: string[] = [];
    let durationSec = 0;
    let detectedLanguage: string | undefined;

    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      finalize(() => reject(new Error(`Deepgram timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    ws.addEventListener('open', async () => {
      try {
        // Deepgram recommends 20–250 ms of audio per send. 8 KiB is roughly
        // 100 ms of 32 kbps Opus, a safe middle ground.
        const CHUNK_SIZE = 8 * 1024;
        for (let off = 0; off < audio.byteLength; off += CHUNK_SIZE) {
          const end = Math.min(off + CHUNK_SIZE, audio.byteLength);
          ws.send(audio.slice(off, end));
          // 5 ms breather per chunk keeps us well under any server-side
          // burst limits without meaningfully slowing transcription.
          await new Promise((r) => setTimeout(r, 5));
        }
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch (err) {
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        finalize(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : ev.data.toString();
        const data = JSON.parse(raw);
        if (data.type === 'Results') {
          const alt = data.channel?.alternatives?.[0];
          const text: string = (alt?.transcript ?? '').trim();
          if (text && data.is_final) transcripts.push(text);
          const detected = data.channel?.detected_language || data.detected_language;
          if (detected && !detectedLanguage) detectedLanguage = detected;
        } else if (data.type === 'Metadata') {
          if (typeof data.duration === 'number') durationSec = data.duration;
        }
      } catch (err) {
        logError(`[deepgram] Failed to parse message: ${err}`);
      }
    });

    ws.addEventListener('close', (ev: CloseEvent) => {
      clearTimeout(timeout);
      if (ev.code !== 1000 && transcripts.length === 0) {
        finalize(() => reject(new Error(`Deepgram closed abnormally (code=${ev.code}, reason=${ev.reason || 'unknown'})`)));
      } else {
        finalize(() => resolve({
          transcript: transcripts.join(' ').trim(),
          durationSec,
          detectedLanguage,
        }));
      }
    });

    ws.addEventListener('error', (ev: Event) => {
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      const msg = (ev as ErrorEvent).message || 'WebSocket error';
      finalize(() => reject(new Error(`Deepgram WS error: ${msg}`)));
    });
  });
}

/**
 * Convenience wrapper: fetches a URL (typically a Telegram file link) and
 * transcribes the downloaded bytes in one go. Used by the Telegram voice
 * handler so it can pass the file URL directly.
 */
export async function transcribeAudioFromUrl(
  url: string,
  opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download audio: ${res.status} ${res.statusText}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  log(`[deepgram] Downloaded ${buf.byteLength} bytes from ${url.slice(0, 80)}…, sending to Deepgram`);
  return transcribeAudioBuffer(buf, opts);
}

/** Whether the user has configured an API key (used to gate UI badges). */
export function isDeepgramConfigured(): boolean {
  return Boolean(loadDeepgramSettings().apiKey);
}
