/**
 * Client half of voice mode (server half: packages/core/integrations/voice.ts).
 *
 * Streams the mic to the bridge as MediaRecorder chunks and plays back the
 * PCM16 replies Deepgram Aura synthesises. Turn-taking happens on the server:
 * it decides when an utterance ends and when the user talked over a reply,
 * and tells us with `barge_in` so we can drop the audio already queued here.
 */

export type VoiceState = 'connecting' | 'listening' | 'speaking' | 'closed';

export interface VoiceCallbacks {
  onState(state: VoiceState): void;
  /** The utterance in progress; `null` once it has been sent to Claude. */
  onTranscript(text: string | null): void;
  onError(message: string): void;
}

/** ~250 ms per chunk: Deepgram wants 20–250 ms, and fewer frames is cheaper. */
const CHUNK_MS = 250;

export class VoiceSession {
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private player: PcmPlayer | null = null;
  private state: VoiceState = 'connecting';
  private stopped = false;

  constructor(private url: string, private cb: VoiceCallbacks) {}

  private setState(state: VoiceState) {
    if (this.state === state) return;
    this.state = state;
    this.cb.onState(state);
  }

  async start() {
    this.cb.onState('connecting');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Mic needs a secure context (https or localhost).');
    // Echo cancellation keeps the reply coming out of the speakers from being
    // transcribed as the user talking over it.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (this.stopped) { this.releaseMic(); return; }

    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => this.startRecorder();
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = (ev) => {
      if (!this.stopped && ev.code !== 1000) this.cb.onError(ev.reason || `Voice socket closed (${ev.code})`);
      this.stop();
    };
  }

  private startRecorder() {
    if (!this.stream) return;
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      .find((c) => MediaRecorder.isTypeSupported(c));
    const rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = async (ev) => {
      if (ev.data.size > 0 && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(await ev.data.arrayBuffer());
      }
    };
    rec.start(CHUNK_MS);
    this.recorder = rec;
  }

  private onMessage(data: string | ArrayBuffer) {
    if (typeof data !== 'string') {
      this.player?.push(data);
      return;
    }
    let msg: any;
    try { msg = JSON.parse(data); } catch { return; }
    switch (msg.type) {
      case 'ready':
        this.setState('listening');
        break;
      case 'transcript':
        this.cb.onTranscript(msg.text);
        break;
      case 'utterance':
        this.cb.onTranscript(null);
        break;
      case 'tts_start':
        this.player?.close();
        this.player = new PcmPlayer(msg.sampleRate, () => this.setState('listening'));
        this.setState('speaking');
        break;
      case 'tts_end':
        this.player?.end();
        break;
      case 'barge_in':
        this.player?.close();
        this.player = null;
        this.setState('listening');
        break;
      case 'error':
        this.cb.onError(msg.message);
        break;
    }
  }

  /** Cut the reply short without saying anything. */
  interrupt() {
    this.player?.close();
    this.player = null;
    this.setState('listening');
    this.send({ type: 'interrupt' });
  }
  private send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private releaseMic() {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    try { if (this.recorder?.state !== 'inactive') this.recorder?.stop(); } catch {}
    this.recorder = null;
    this.releaseMic();
    this.player?.close();
    this.player = null;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close(1000);
    this.ws = null;
    this.setState('closed');
  }
}

/** Gapless playback of little-endian PCM16 mono frames as they arrive. */
class PcmPlayer {
  private ctx: AudioContext;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  /** A frame can split a sample in half; the odd byte waits for the next one. */
  private carry: Uint8Array | null = null;
  private ended = false;

  constructor(private sampleRate: number, private onDone: () => void) {
    this.ctx = new AudioContext({ sampleRate });
  }

  push(frame: ArrayBuffer) {
    let bytes = new Uint8Array(frame);
    if (this.carry) {
      const joined = new Uint8Array(this.carry.length + bytes.length);
      joined.set(this.carry);
      joined.set(bytes, this.carry.length);
      bytes = joined;
      this.carry = null;
    }
    if (bytes.length % 2) {
      this.carry = bytes.slice(-1);
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    if (bytes.length === 0) return;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = new Float32Array(bytes.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;

    const buffer = this.ctx.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(samples, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    this.nextTime = Math.max(this.nextTime, this.ctx.currentTime + 0.05);
    src.start(this.nextTime);
    this.nextTime += buffer.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      this.maybeDone();
    };
  }

  /** No more frames are coming; report done once the queue drains. */
  end() {
    this.ended = true;
    this.maybeDone();
  }

  private maybeDone() {
    if (this.ended && this.sources.size === 0) {
      this.ended = false;
      this.onDone();
      this.close();
    }
  }

  close() {
    for (const src of this.sources) { try { src.stop(); } catch {} }
    this.sources.clear();
    void this.ctx.close().catch(() => {});
  }
}
