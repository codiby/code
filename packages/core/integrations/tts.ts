/**
 * Text-to-speech for voice mode, one streaming socket per reply.
 *
 * Both providers are asked for raw PCM16 mono at 24 kHz so the client player
 * never has to care which one spoke. A socket per reply (instead of one kept
 * warm) costs a connect, ~200 ms, which is noise next to a Claude turn — and
 * means a voice or speed change in settings applies to the very next reply.
 */

import { loadDeepgramSettings, loadVoiceSettings } from '../session/storage';

export const TTS_SAMPLE_RATE = 24_000;

/** What each API rejects outside of (Deepgram answers 400, ElevenLabs clamps). */
export const SPEED_RANGE = {
  deepgram: { min: 0.7, max: 1.5 },
  elevenlabs: { min: 0.7, max: 1.2 },
} as const;

export interface TtsHandlers {
  onAudio(pcm: Uint8Array): void;
  onDone(): void;
  onError(message: string): void;
}

export interface TtsJob {
  /** Stop generating; no handler fires afterwards. */
  cancel(): void;
}

function clampSpeed(speed: number, provider: keyof typeof SPEED_RANGE): number {
  const { min, max } = SPEED_RANGE[provider];
  return Math.min(max, Math.max(min, speed));
}

/** `chunks` are already sized for the provider's per-message limit. */
export function startTts(chunks: string[], handlers: TtsHandlers): TtsJob {
  const voice = loadVoiceSettings();
  return voice.ttsProvider === 'elevenlabs'
    ? elevenLabsJob(chunks, handlers, voice.ttsSpeed)
    : deepgramJob(chunks, handlers, voice.ttsSpeed, voice.deepgramVoice);
}

/**
 * Wraps the handlers so each job reports exactly one terminal event, and none
 * at all once cancelled — a socket closing after `Clear` is not an error.
 */
function guard(h: TtsHandlers) {
  let over = false;
  return {
    get over() { return over; },
    audio(pcm: Uint8Array) { if (!over && pcm.length) h.onAudio(pcm); },
    done() { if (!over) { over = true; h.onDone(); } },
    error(msg: string) { if (!over) { over = true; h.onError(msg); } },
    cancel() { over = true; },
  };
}

function deepgramJob(chunks: string[], h: TtsHandlers, speed: number, voice: string): TtsJob {
  const g = guard(h);
  const { apiKey } = loadDeepgramSettings();
  if (!apiKey) { g.error('Deepgram API key not configured'); return { cancel() {} }; }

  const params = new URLSearchParams({
    model: voice,
    encoding: 'linear16',
    sample_rate: String(TTS_SAMPLE_RATE),
    speed: String(clampSpeed(speed, 'deepgram')),
  });
  const ws = new WebSocket(`wss://api.deepgram.com/v1/speak?${params}`, {
    // @ts-expect-error — Bun-specific extension
    headers: { Authorization: `Token ${apiKey}` },
  });
  ws.binaryType = 'arraybuffer';
  let headerChecked = false;

  ws.addEventListener('open', () => {
    for (const text of chunks) ws.send(JSON.stringify({ type: 'Speak', text }));
    ws.send(JSON.stringify({ type: 'Flush' }));
  });
  ws.addEventListener('message', (ev: MessageEvent) => {
    if (typeof ev.data !== 'string') {
      let pcm = new Uint8Array(ev.data as ArrayBuffer);
      // The first frame may carry a WAV header; played as samples it's a click.
      if (!headerChecked) {
        headerChecked = true;
        if (pcm.length >= 44 && String.fromCharCode(...pcm.subarray(0, 4)) === 'RIFF') pcm = pcm.subarray(44);
      }
      g.audio(pcm);
      return;
    }
    try {
      const data = JSON.parse(ev.data);
      if (data.type === 'Flushed') {
        g.done();
        ws.send(JSON.stringify({ type: 'Close' }));
      } else if (data.type === 'Warning' || data.type === 'Error') {
        g.error(`Aura: ${data.description ?? data.err_msg ?? JSON.stringify(data)}`);
      }
    } catch {}
  });
  ws.addEventListener('close', (ev: CloseEvent) => {
    g.error(`Aura closed mid-reply (code=${ev.code}${ev.reason ? `, ${ev.reason}` : ''})`);
  });

  return {
    cancel() {
      g.cancel();
      try { ws.close(); } catch {}
    },
  };
}

function elevenLabsJob(chunks: string[], h: TtsHandlers, speed: number): TtsJob {
  const g = guard(h);
  const { apiKey, voiceId, modelId } = loadVoiceSettings().elevenlabs;
  if (!apiKey) { g.error('ElevenLabs API key not configured'); return { cancel() {} }; }
  if (!voiceId) { g.error('ElevenLabs voice not selected'); return { cancel() {} }; }

  const params = new URLSearchParams({
    model_id: modelId,
    output_format: `pcm_${TTS_SAMPLE_RATE}`,
  });
  const ws = new WebSocket(
    `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input?${params}`,
    {
      // @ts-expect-error — Bun-specific extension
      headers: { 'xi-api-key': apiKey },
    },
  );

  ws.addEventListener('open', () => {
    // The first message opens the generation and carries the voice settings;
    // its text must be a single space.
    ws.send(JSON.stringify({
      text: ' ',
      voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: clampSpeed(speed, 'elevenlabs') },
    }));
    for (const text of chunks) ws.send(JSON.stringify({ text: `${text} ` }));
    // Empty text ends the input; ElevenLabs flushes what's left and answers isFinal.
    ws.send(JSON.stringify({ text: '' }));
  });
  ws.addEventListener('message', (ev: MessageEvent) => {
    if (typeof ev.data !== 'string') return;
    try {
      const data = JSON.parse(ev.data);
      if (data.audio) g.audio(Uint8Array.from(Buffer.from(data.audio, 'base64')));
      if (data.isFinal) g.done();
      else if (data.error || data.message) g.error(`ElevenLabs: ${data.error ?? ''} ${data.message ?? ''}`.trim());
    } catch {}
  });
  ws.addEventListener('close', (ev: CloseEvent) => {
    // A clean close after the last audio chunk is how a generation ends when
    // isFinal doesn't arrive on its own.
    if (ev.code === 1000) g.done();
    else g.error(`ElevenLabs closed mid-reply (code=${ev.code}${ev.reason ? `, ${ev.reason}` : ''})`);
  });

  return {
    cancel() {
      g.cancel();
      try { ws.close(); } catch {}
    },
  };
}

export interface ElevenLabsVoice {
  id: string;
  name: string;
  /** "american", "mexican", … — from ElevenLabs' labels, may be empty. */
  accent: string;
  gender: string;
  category: string;
  sample: string | null;
}

/** Voices on the user's ElevenLabs account (premade + cloned + library). */
export async function listElevenLabsVoices(): Promise<ElevenLabsVoice[]> {
  const { apiKey } = loadVoiceSettings().elevenlabs;
  if (!apiKey) throw new Error('ElevenLabs API key not configured');
  const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': apiKey } });
  if (!res.ok) throw new Error(`ElevenLabs voices: ${res.status} ${res.statusText}`);
  const data = await res.json() as { voices?: any[] };
  return (data.voices ?? [])
    .map((v) => ({
      id: v.voice_id,
      name: v.name,
      accent: v.labels?.accent ?? '',
      gender: v.labels?.gender ?? '',
      category: v.category ?? '',
      sample: v.preview_url ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
