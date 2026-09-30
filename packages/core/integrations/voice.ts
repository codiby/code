/**
 * Voice mode: a live conversation with a session, spoken instead of typed.
 *
 *   desktop mic ──webm/opus──▶ /voice/ws/:sessionId ──▶ Deepgram listen (STT)
 *                                   │ utterance text
 *                                   ▼
 *                           sendMessageToSession ──▶ Claude
 *                                   │ turn result text
 *                                   ▼
 *   desktop speaker ◀──PCM 24k── Deepgram Aura or ElevenLabs (see tts.ts)
 *
 * One `VoiceBridge` per client socket. Its listen socket lives as long as the
 * client does; each spoken reply gets its own TTS job.
 *
 * Client → server
 *   binary                     mic audio (MediaRecorder chunks, any container
 *                              Deepgram auto-detects — webm/opus in Electron)
 *   {type:'interrupt'}         stop the reply that is playing
 *   {type:'tts', enabled}      mute/unmute spoken replies
 * Server → client
 *   {type:'ready'}             Deepgram is listening
 *   {type:'transcript', text, final}   the utterance in progress
 *   {type:'utterance', text}   sent to Claude
 *   {type:'barge_in'}          user talked over the reply — drop queued audio
 *   {type:'tts_start', sampleRate} · binary PCM16 mono · {type:'tts_end'}
 *   {type:'error', message}
 */

import { log, logError } from '../lib/logger';
import { loadDeepgramSettings, loadVoiceSettings } from '../session/storage';
import { getSessionState } from '../session/state';
import { startTts, TTS_SAMPLE_RATE, type TtsJob } from './tts';
import { CONTEXT_MESSAGES, FastVoiceAgent, parseFront, type VoiceLine } from './voice-agent';

/** Silence after which Deepgram marks a segment `speech_final`. */
const ENDPOINTING_MS = 500;
/** Gap between words after which Deepgram sends `UtteranceEnd` (min 1000). */
const UTTERANCE_END_MS = 1000;

/** Deepgram rejects Speak messages over 2000 characters. */
const SPEAK_CHUNK_CHARS = 1800;
/** Deepgram closes a listen socket after ~10 s without audio or KeepAlive. */
const KEEPALIVE_MS = 5_000;

interface ClientSocket {
  send(data: string | Uint8Array | ArrayBuffer): unknown;
  close(code?: number, reason?: string): void;
}

export interface VoiceDeps {
  sendMessageToSession(sessionId: string, text: string): Promise<{ ok: boolean; error?: string }>;
  /** Same as the chat's Stop button. */
  interruptSession(sessionId: string): Promise<void>;
  /** The session's UI feed — how other viewers (the floating bubble) learn
   *  what voice mode is doing. */
  broadcastToSession(sessionId: string, msg: object): void;
}

/** What voice mode is doing for a session, as viewers show it. */
export type VoiceState = 'off' | 'listening' | 'speaking';

/** A session's voice state across its voice connections — for a viewer that
 *  subscribes after voice mode started. */
export function voiceStateOf(sessionId: string): VoiceState {
  let state: VoiceState = 'off';
  for (const b of bridges.values()) {
    if (b.sessionId !== sessionId) continue;
    if (b.voiceState === 'speaking') return 'speaking';
    if (b.voiceState === 'listening') state = 'listening';
  }
  return state;
}

function broadcastVoiceState(sessionId: string) {
  deps?.broadcastToSession(sessionId, { type: 'voice_state', sessionId, state: voiceStateOf(sessionId) });
}

let deps: VoiceDeps | null = null;
export function setVoiceDeps(d: VoiceDeps) { deps = d; }

const bridges = new Map<ClientSocket, VoiceBridge>();

export function openVoice(ws: ClientSocket, sessionId: string) {
  const bridge = new VoiceBridge(ws, sessionId);
  bridges.set(ws, bridge);
  bridge.start();
}

export function voiceMessage(ws: ClientSocket, message: string | Uint8Array | ArrayBuffer) {
  bridges.get(ws)?.handleClient(message);
}

export function closeVoice(ws: ClientSocket) {
  const bridge = bridges.get(ws);
  bridge?.dispose();
  bridges.delete(ws);
  // After the delete, so a session with no voice left reads as off.
  if (bridge) broadcastVoiceState(bridge.sessionId);
}

/** Speak a finished turn to every voice client attached to the session. */
export function speakTurnResult(sessionId: string, text: string | undefined) {
  if (!text?.trim()) return;
  for (const bridge of bridges.values()) {
    if (bridge.sessionId === sessionId) bridge.onTurnComplete(text);
  }
}

/**
 * Markdown is written for the eye. Read aloud, fences and URLs are noise, so
 * code blocks are dropped and the rest is reduced to its words.
 */
export function toSpeakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\|?[\s:-]+\|[\s|:-]*$/gm, '')
    .replace(/\|/g, ', ')
    .replace(/(\*\*|__|~~)(.*?)\1/g, '$2')
    .replace(/(^|\W)[*_](\S[^*_]*)[*_](?=\W|$)/g, '$1$2')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n(\s*\n)+/g, '\n')
    .trim();
}

/** Split on sentence boundaries so each Speak message stays under the limit. */
export function chunkForSpeech(text: string, max = SPEAK_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = '';
  for (let sentence of text.match(/[^.!?\n]+[.!?]*\s*|\n/g) ?? []) {
    if (current.length + sentence.length > max && current.trim()) {
      chunks.push(current.trim());
      current = '';
    }
    // A single run-on "sentence" longer than the limit gets hard-cut.
    while (sentence.length > max) {
      chunks.push(sentence.slice(0, max));
      sentence = sentence.slice(max);
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** Lowercased, accent-free words — "¡Detente!" and "detente" compare equal. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9ñ]+/)
    .filter(Boolean);
}

/**
 * The reply leaking from the speakers back into the mic. Echo cancellation
 * catches most of it; what slips through transcribes as the reply's own words,
 * and treating that as the user talking would make every reply cut itself off.
 */
export function isEcho(heard: string, replyWords: Set<string>): boolean {
  const w = words(heard);
  if (w.length === 0 || replyWords.size === 0) return false;
  // One word proves nothing either way — "si" is in half the replies.
  if (w.length === 1) return false;
  const matched = w.filter((x) => replyWords.has(x)).length;
  return matched / w.length >= 0.7;
}

/**
 * The final summary adds nothing the user hasn't already heard this turn —
 * "¿qué está raro? cuéntame" after "dime qué está raro". Content words only:
 * articles and "voy a" match everything.
 */
export function repeats(summary: string, alreadySaid: string[]): boolean {
  if (alreadySaid.length === 0) return false;
  const said = new Set(words(alreadySaid.join(' ')));
  const content = words(summary).filter((w) => w.length > 3);
  if (content.length === 0) return true;
  return content.filter((w) => said.has(w)).length / content.length >= 0.6;
}

/** Two session messages carrying the same text, give or take formatting. */
export function sameContent(a: string, b: string): boolean {
  const wa = words(toSpeakable(a));
  const wb = new Set(words(toSpeakable(b)));
  if (wa.length === 0 || wb.size === 0) return false;
  const shared = wa.filter((w) => wb.has(w)).length;
  return shared / Math.max(wa.length, wb.size) >= 0.8;
}

/** "Para", "espera", "stop" said over a reply mean "be quiet", not a message. */
const STOP_WORDS = new Set([
  'para', 'parale', 'detente', 'alto', 'espera', 'esperate', 'basta', 'silencio',
  'callate', 'ya', 'ok', 'okay', 'stop', 'wait', 'enough', 'shh', 'shhh',
]);

/**
 * Whether the words carry an explicit order to stop. Haiku once stopped a turn
 * on "Oye, Codin" — a call for attention — so "detener" is only honoured when
 * the user actually said something like it.
 */
const STOP_INTENT = /^(para(r|le)?|det(en|ente|ener|engas|ente)|cancela(r|lo|la)?|basta|alto|olvida(lo)?|stop|callate|silencio|ya\s*no)$/;
export function hasStopIntent(text: string): boolean {
  const w = words(text);
  if (w.some((x) => STOP_INTENT.test(x))) return true;
  return /\bya no\b/.test(w.join(' '));
}

export function isStopCommand(text: string): boolean {
  const w = words(text);
  return w.length > 0 && w.length <= 3 && w.every((x) => STOP_WORDS.has(x));
}

/** Playback outlives generation: the client is still playing after `tts_end`. */
const PLAYBACK_SLACK_MS = 400;
const ECHO_TAIL_MS = 2_000;

const MAX_FINAL_INPUT_CHARS = 6_000;
const FINAL_FALLBACK = 'Ya terminé, te dejé la respuesta en el chat.';
const ACK_TIMEOUT_MS = 5_000;
/** How long an utterance waits on Haiku's call before going to the session
 *  as heard. */
const FRONT_TIMEOUT_MS = 4_000;
const MAX_VOICE_LOG = 60;
/** Silence after a cut sentence before front decides without waiting. */
const WAIT_FOR_REST_MS = 6_000;
const FINAL_TIMEOUT_MS = 8_000;
const PROGRESS_CHECK_MS = 3_000;
/** Silence during a long turn before saying what the session is up to. */
const PROGRESS_AFTER_QUIET_MS = 20_000;

type SpeechKind = 'ack' | 'progress' | 'final';

interface Reply { job: TtsJob | null }

class VoiceBridge {
  private listen: WebSocket | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  /** Final segments of the utterance in progress. */
  private finals: string[] = [];
  /** Audio frames that arrived before the listen socket opened. */
  private pendingAudio: Uint8Array[] = [];
  /** The reply being generated, if any. */
  private tts: Reply | null = null;
  private ttsEnabled = true;
  /** Pending send of the utterance, armed at end of speech. */
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Shown by the floating bubble; changes go out through setVoiceState. */
  voiceState: VoiceState = 'off';

  private setVoiceState(state: VoiceState) {
    if (this.voiceState === state || this.disposed) return;
    this.voiceState = state;
    broadcastVoiceState(this.sessionId);
  }
  /** Words of the reply being read aloud, for telling echo from the user. */
  private replyWords = new Set<string>();
  /** When the first audio frame of the reply went out, and how much followed. */
  private playbackStartedAt = 0;
  private playbackMs = 0;
  /** The utterance in progress started by talking over a reply. */
  private bargedIn = false;

  /** Haiku, speaking while the session works (see voice-agent.ts). */
  private agent: FastVoiceAgent | null = null;
  /** Speech waiting for the current reply to finish playing. */
  private speechQueue: { text: string; kind: SpeechKind }[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private progressInFlight = false;
  /** Bumped per utterance sent, so late answers for an older one are dropped. */
  private turn = 0;
  private answeredTurn = 0;
  private turnStartedAt = 0;
  /** When the last thing said finished playing — progress waits on silence. */
  private quietSince = 0;
  private progressNotes: string[] = [];
  private progressSteps = 0;
  /** What Haiku already told the user this turn; the final summary skips it. */
  private saidThisTurn: string[] = [];
  /** What is playing right now — only Haiku's own filler may be cut for news. */
  private currentKind: SpeechKind | null = null;
  /** What the user and the voice said to each other — Haiku's memory, since
   *  small talk it answers itself never reaches the session. */
  private voiceLog: VoiceLine[] = [];
  /** Utterances not yet turned into a session message (a cut sentence, a
   *  request awaiting clarification). */
  private heardSinceSend: string[] = [];
  /** Armed when front waits for the rest of a cut sentence. */
  private waitTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Whether the client is still playing a reply. Generation runs many times
   * faster than real time — 8 s of speech arrives in under one — so "the
   * provider is still sending" ends long before the user stops hearing it.
   */
  private get speaking() {
    return this.tts !== null || Date.now() < this.playbackEndsAt;
  }

  private get playbackEndsAt() {
    return this.playbackStartedAt > 0 ? this.playbackStartedAt + this.playbackMs + PLAYBACK_SLACK_MS : 0;
  }

  /** Transcription lags the audio by about a second, so the reply's last words
   *  can come back as "heard" after it has finished playing. */
  private get inEchoWindow() {
    return this.speaking || Date.now() < this.playbackEndsAt + ECHO_TAIL_MS;
  }

  constructor(private ws: ClientSocket, readonly sessionId: string) {}

  private get tag() { return `[voice ${this.sessionId.slice(0, 8)}]`; }

  private sendClient(msg: object) {
    try { this.ws.send(JSON.stringify(msg)); } catch {}
  }

  private fail(message: string) {
    logError(`${this.tag} ${message}`);
    this.sendClient({ type: 'error', message });
  }

  start() {
    const settings = loadDeepgramSettings();
    if (!settings.apiKey) {
      this.fail('Deepgram API key not configured');
      this.ws.close(4000, 'Deepgram not configured');
      return;
    }
    const params = new URLSearchParams({
      model: settings.model || 'nova-3',
      language: settings.language || 'multi',
      smart_format: 'true',
      punctuate: 'true',
      interim_results: 'true',
      // When Deepgram calls a segment done. Sending waits longer — see
      // scheduleSend — so these only need to be short enough to start the
      // clock early.
      endpointing: String(ENDPOINTING_MS),
      utterance_end_ms: String(UTTERANCE_END_MS),
      vad_events: 'true',
    });
    const listen = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      // @ts-expect-error — Bun-specific extension
      headers: { Authorization: `Token ${settings.apiKey}` },
    });
    listen.binaryType = 'arraybuffer';
    this.listen = listen;

    listen.addEventListener('open', () => {
      if (this.disposed) { listen.close(); return; }
      log(`${this.tag} listening (${params.get('model')}, ${params.get('language')})`);
      for (const frame of this.pendingAudio) listen.send(frame);
      this.pendingAudio = [];
      this.keepAlive = setInterval(() => {
        try { listen.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
      }, KEEPALIVE_MS);
      this.sendClient({ type: 'ready' });
      this.setVoiceState('listening');
    });
    if (loadVoiceSettings().fastAgent) {
      this.agent = new FastVoiceAgent(this.tag);
      this.progressTimer = setInterval(() => this.maybeSayProgress(), PROGRESS_CHECK_MS);
    }
    listen.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      try { this.onListenEvent(JSON.parse(ev.data)); }
      catch (err) { logError(`${this.tag} bad listen message: ${err}`); }
    });
    listen.addEventListener('close', (ev: CloseEvent) => {
      if (this.disposed) return;
      this.fail(`Deepgram listen closed (code=${ev.code}${ev.reason ? `, ${ev.reason}` : ''})`);
      this.ws.close(4001, 'Deepgram listen closed');
    });
    listen.addEventListener('error', () => {
      if (!this.disposed) this.fail('Deepgram listen socket error');
    });
  }

  private onListenEvent(data: any) {
    if (data.type === 'Results') {
      const text: string = (data.channel?.alternatives?.[0]?.transcript ?? '').trim();
      if (!text) return;
      // Its own voice coming back through the mic: not the user, not a message.
      if (this.inEchoWindow && isEcho(text, this.replyWords)) return;
      if (this.speaking) {
        // Transcribed words — not raw VAD, which also fires on the fan — are
        // what counts as talking over the reply.
        this.bargeIn();
        this.bargedIn = true;
      }
      // Still talking: whatever pause ended the last segment was mid-thought.
      this.cancelSend();
      // The rest of a cut sentence is arriving; it'll be decided with it.
      if (this.waitTimer) { clearTimeout(this.waitTimer); this.waitTimer = null; }
      if (data.is_final) this.finals.push(text);
      const pending = data.is_final ? this.finals.join(' ') : [...this.finals, text].join(' ');
      this.sendClient({ type: 'transcript', text: pending, final: !!data.is_final });
      if (data.speech_final) this.scheduleSend(ENDPOINTING_MS);
      return;
    }
    // Fires when endpointing missed the pause (background noise keeps the
    // VAD open). `last_word_end: -1` means speech_final already caught it.
    // Words dropped as echo still produce an UtteranceEnd; with nothing
    // collected there's nothing to send.
    if (data.type === 'UtteranceEnd' && data.last_word_end !== -1 && !this.sendTimer && this.finals.length > 0) {
      this.scheduleSend(UTTERANCE_END_MS);
    }
  }

  /**
   * Deepgram's end-of-speech fires on a breath. Sending right then split
   * "Ayer estuve trabajando en… [pause] …el bridge" into two messages, so wait
   * until the silence adds up to the user's pause setting; any new words in
   * the meantime cancel the send and the utterance keeps growing.
   */
  private scheduleSend(silenceSoFarMs: number) {
    this.cancelSend();
    const wait = Math.max(0, loadVoiceSettings().sendAfterMs - silenceSoFarMs);
    this.sendClient({ type: 'pending_send', ms: wait });
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      this.flushUtterance();
    }, wait);
  }

  private cancelSend() {
    if (!this.sendTimer) return;
    clearTimeout(this.sendTimer);
    this.sendTimer = null;
  }

  private flushUtterance() {
    const text = this.finals.join(' ').trim();
    this.finals = [];
    const bargedIn = this.bargedIn;
    this.bargedIn = false;
    if (!text) return;
    if (!deps) { this.fail('Voice bridge not wired'); return; }
    const busy = getSessionState(this.sessionId).isStreaming;
    const stopWords = bargedIn && isStopCommand(text);

    // "Para" over a reply while the session is idle only meant "be quiet" —
    // and it already was. Sending it on would start a turn answering "para".
    if (stopWords && !(busy && this.agent)) {
      log(`${this.tag} stop command, not sent: ${text}`);
      this.sendClient({ type: 'utterance', text, sent: false });
      return;
    }

    // Without the voice agent, the words go to the session as heard.
    if (!this.agent) { this.sendToSession(text); return; }

    this.heardSinceSend.push(text);
    this.remember('usuario', text);
    void this.decide(text, busy, stopWords);
  }

  /**
   * The user spoke; Haiku decides what it means before anything reaches the
   * session. That is what lets it answer small talk itself, ask when it isn't
   * sure, and wait out a sentence the transcriber cut in half — none of which
   * the session could do with a fragment dropped straight into it.
   */
  private async decide(text: string, busy: boolean, stopWords: boolean, noMore = false) {
    const raw = await this.agent!.ask(
      'front', this.recentMessages(), text, FRONT_TIMEOUT_MS, { voiceLog: this.voiceLog.slice(0, -1), busy, noMore },
    );
    if (this.disposed) return;
    const decision = raw ? parseFront(raw) : null;

    if (decision?.action === 'esperar') {
      if (noMore) {
        // Told it can't wait again and waited anyway: ask rather than guess.
        decision.action = 'preguntar';
        decision.say = decision.say || '¿Me lo terminas de decir?';
      } else {
        log(`${this.tag} front: esperar`);
        // A cut sentence the user never finishes mustn't sit here forever:
        // after a while, decide again on what was said, waiting ruled out.
        this.waitTimer = setTimeout(() => {
          this.waitTimer = null;
          const heard = this.heardSinceSend.join(' ');
          if (heard) void this.decide(heard, getSessionState(this.sessionId).isStreaming, false, true);
        }, WAIT_FOR_REST_MS);
        return;
      }
    }

    // No usable answer: the user's own words go through untouched, so a slow
    // or garbled Haiku costs nothing but the rewrite.
    if (!decision) {
      log(`${this.tag} front: ${raw ? 'unparseable' : 'no answer'}, sending as heard`);
      this.sendToSession(this.heardSinceSend.join(' '));
      return;
    }

    let { action } = decision;
    // Interrupting or stopping only means something while the session works.
    if (!busy && action === 'interrumpir') action = 'enviar';
    if (!busy && action === 'detener') action = 'responder';
    // Stop words over a reply never become a new request.
    if (stopWords && (action === 'enviar' || action === 'interrumpir')) action = 'detener';
    // Stopping the work takes an explicit order, whatever Haiku concluded.
    // "Oye, Codin" once came back as interrumpir with a made-up "cancela la
    // revisión": a redirect says what to do instead, so three words or fewer
    // with no stop order can't be one either.
    const heard = this.heardSinceSend.join(' ');
    const tooThinToStop = !hasStopIntent(heard)
      && (action === 'detener' || (action === 'interrumpir' && words(heard).length <= 3));
    if (busy && tooThinToStop) {
      log(`${this.tag} front: ${action} without a stop order in "${heard}", treated as responder`);
      action = 'responder';
      decision.say = '¿Sí?';
    }
    log(`${this.tag} front: ${action}${decision.instruction ? ` → ${decision.instruction.slice(0, 120)}` : ''}`);

    if (action === 'interrumpir' || action === 'detener') {
      this.sendClient({ type: 'agent_action', action });
      await deps!.interruptSession(this.sessionId);
    }
    if (action === 'enviar' || action === 'interrumpir') {
      this.sendToSession(decision.instruction, this.heardSinceSend);
    } else if (action === 'responder' || action === 'detener') {
      // Answered or dropped: nothing heard so far is pending anymore. Asking
      // and waiting keep it, so the next utterance completes the request.
      this.heardSinceSend = [];
      this.sendClient({ type: 'utterance', text, sent: false });
    }

    if (decision.say) {
      this.remember('voz', decision.say);
      this.say(decision.say, 'ack');
    }
  }

  /**
   * Start a session turn. `heard` is what the user actually said when the
   * message is Haiku's rewrite: it rides along so the session can catch a
   * misreading instead of acting on it.
   */
  private sendToSession(message: string, heard: string[] = []) {
    this.turn++;
    this.turnStartedAt = Date.now();
    this.quietSince = Date.now();
    this.progressNotes = [];
    this.progressSteps = 0;
    this.saidThisTurn = [];
    // Anything still queued answered the previous request.
    this.speechQueue = this.speechQueue.filter((s) => s.kind === 'ack');
    this.heardSinceSend = [];

    const literal = heard.join(' ').trim();
    const body = literal && literal !== message.trim() ? `${message}\n\n> 🎙️ «${literal}»` : message;
    log(`${this.tag} to session: ${message.slice(0, 120)}`);
    this.sendClient({ type: 'utterance', text: message });
    deps!.sendMessageToSession(this.sessionId, body).then((res) => {
      if (!res.ok) this.fail(`Could not send to session: ${res.error ?? 'unknown error'}`);
    });
  }

  /** Record a line of the dialogue; what the voice said also counts as heard
   *  this turn, so the next summary won't repeat it. */
  private remember(who: VoiceLine['who'], text: string) {
    this.voiceLog.push({ who, text });
    if (this.voiceLog.length > MAX_VOICE_LOG) this.voiceLog.splice(0, this.voiceLog.length - MAX_VOICE_LOG);
    if (who === 'voz') this.saidThisTurn.push(text);
  }

  private recentMessages() {
    return getSessionState(this.sessionId).messages.slice(-CONTEXT_MESSAGES * 4);
  }

  /**
   * The session finished a turn (the SDK's result). This is the only moment
   * Haiku speaks for the session: relaying messages mid-turn had it announce
   * "encontré el problema" when the session had only said it was going to
   * look. Now it gets everything the session wrote this turn, finished, and
   * answers from that.
   */
  onTurnComplete(markdown: string) {
    const turn = this.turn;
    this.answeredTurn = turn;
    // Progress and an ack that never got its turn are both stale now.
    this.speechQueue = this.speechQueue.filter((s) => s.kind === 'final');

    // Without the voice agent, the session's answer is all there is to say.
    if (!this.agent) { this.say(markdown, 'final'); return; }
    void this.relayTurn(turn, this.turnTexts(markdown));
  }

  /**
   * What the session wrote since the user's last message: the findings along
   * the way as well as the closing answer, which alone often just says "listo".
   */
  private turnTexts(result: string): string {
    const msgs = getSessionState(this.sessionId).messages;
    let i = msgs.length - 1;
    while (i >= 0 && msgs[i]!.role !== 'user') i--;
    const texts = msgs.slice(i + 1)
      .filter((m) => m.role === 'assistant' && !m.toolName && !m.isToolResult && !m.isThinking && !m.parentToolUseId)
      .map((m) => m.content.trim())
      .filter(Boolean);
    // The SDK's result is normally the last message already; add it if not.
    const last = texts[texts.length - 1];
    if (result.trim() && !(last && sameContent(last, result))) texts.push(result.trim());
    return texts.join('\n\n');
  }

  private async relayTurn(turn: number, text: string) {
    const speakable = toSpeakable(text);
    if (!speakable || !this.agent) return;
    const alreadySaid = [...this.saidThisTurn];
    // Only Haiku's own filler (an ack, a progress note) is cut off for the
    // answer; it opens with "espera, te actualizo" when it does.
    const cuttingIn = () => this.currentKind === 'ack' || this.currentKind === 'progress';

    // Haiku is the only voice the user hears — two voices, one reading the
    // session verbatim and one paraphrasing ahead of it, sounded like two
    // assistants talking over the same point. The end of the text is kept
    // when it's too long: that's where the answer and its question are.
    const summary = await this.agent.ask(
      'final', this.recentMessages(), speakable.slice(-MAX_FINAL_INPUT_CHARS), FINAL_TIMEOUT_MS,
      { alreadySaid, interrupting: cuttingIn() },
    );
    // The user already moved on to something else.
    if (this.turn !== turn) return;
    if (!summary) {
      log(`${this.tag} turn summary timed out`);
      // A pointer to the chat beats the session's own voice.
      if (alreadySaid.length === 0) this.say(FINAL_FALLBACK, 'final');
      return;
    }
    // Judged here rather than by asking Haiku to stay quiet: told it could
    // answer "(nada)", it went silent even on answers full of new results.
    if (repeats(summary, alreadySaid)) { log(`${this.tag} turn summary repeats what was said, skipped`); return; }
    this.remember('voz', summary);
    if (cuttingIn()) this.cutOff();
    this.say(summary, 'final');
  }

  /** Stop the filler playing now, and any filler lined up after it. */
  private cutOff() {
    this.speechQueue = this.speechQueue.filter((s) => s.kind === 'final');
    this.tts?.job?.cancel();
    this.tts = null;
    this.playbackStartedAt = 0;
    this.playbackMs = 0;
    this.currentKind = null;
    if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = null; }
    // Same client signal as a barge-in: drop the audio already queued there.
    this.sendClient({ type: 'barge_in' });
    log(`${this.tag} cut own filler for news from the session`);
  }

  /** Say it now, or after whatever is playing — never over it. */
  private say(text: string, kind: SpeechKind) {
    if (!this.ttsEnabled || this.disposed) return;
    if (!this.speaking) { this.speak(text, kind); return; }
    if (kind === 'final') this.speechQueue = this.speechQueue.filter((s) => s.kind === 'final');
    this.speechQueue.push({ text, kind });
  }

  private scheduleDrain() {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      if (this.speaking) return;
      this.quietSince = Date.now();
      this.currentKind = null;
      const next = this.speechQueue.shift();
      if (next) this.speak(next.text, next.kind);
      // The last reply finished playing on the client, not just generating.
      else this.setVoiceState('listening');
    }, Math.max(0, this.playbackEndsAt - Date.now()));
  }

  /**
   * During a long turn, say what the session is up to — but only after a
   * stretch of silence, and only when it has taken new steps since the last
   * update, so it doesn't narrate a single slow command every 20 seconds.
   */
  private maybeSayProgress() {
    if (!this.agent || this.progressInFlight || this.speaking || this.speechQueue.length) return;
    if (this.turn === 0 || this.answeredTurn === this.turn) return;
    if (Date.now() - this.quietSince < PROGRESS_AFTER_QUIET_MS) return;
    const state = getSessionState(this.sessionId);
    if (!state.isStreaming) return;
    const steps = state.messages.filter((m) => m.toolName && !m.isToolResult && m.timestamp >= this.turnStartedAt).length;
    if (steps === this.progressSteps) return;

    const turn = this.turn;
    this.progressInFlight = true;
    this.progressSteps = steps;
    this.agent.ask('progress', this.recentMessages(), this.progressNotes.join(' | '), ACK_TIMEOUT_MS).then((said) => {
      this.progressInFlight = false;
      if (!said || this.turn !== turn || this.answeredTurn === turn) return;
      this.progressNotes.push(said);
      this.remember('voz', said);
      this.say(said, 'progress');
    });
  }

  handleClient(message: string | Uint8Array | ArrayBuffer) {
    if (typeof message !== 'string') {
      const frame = message instanceof Uint8Array ? message : new Uint8Array(message);
      if (this.listen?.readyState === WebSocket.OPEN) this.listen.send(frame);
      // The first MediaRecorder chunk carries the webm header; losing it
      // leaves Deepgram unable to decode anything that follows.
      else this.pendingAudio.push(frame);
      return;
    }
    let msg: any;
    try { msg = JSON.parse(message); } catch { return; }
    if (msg.type === 'interrupt') this.bargeIn();
    else if (msg.type === 'tts') {
      this.ttsEnabled = !!msg.enabled;
      if (!this.ttsEnabled) this.bargeIn();
    }
  }

  private speak(markdown: string, kind: SpeechKind) {
    if (!this.ttsEnabled || this.disposed) return;
    const chunks = chunkForSpeech(toSpeakable(markdown));
    if (chunks.length === 0) return;
    // say() only calls in when nothing is playing; this is the backstop.
    this.tts?.job?.cancel();
    this.currentKind = kind;
    // The reply's identity, set before starting: a provider can fail
    // synchronously (no API key), calling back before startTts returns.
    const reply: Reply = { job: null };
    this.tts = reply;
    this.replyWords = new Set(words(chunks.join(' ')));
    this.playbackStartedAt = 0;
    this.playbackMs = 0;
    log(`${this.tag} speaking ${chunks.join(' ').length} chars`);
    this.setVoiceState('speaking');
    this.sendClient({ type: 'tts_start', sampleRate: TTS_SAMPLE_RATE });
    reply.job = startTts(chunks, {
      onAudio: (pcm) => {
        if (this.tts !== reply) return;
        if (!this.playbackStartedAt) this.playbackStartedAt = Date.now();
        this.playbackMs += (pcm.length / 2 / TTS_SAMPLE_RATE) * 1000;
        try { this.ws.send(pcm); } catch {}
      },
      onDone: () => {
        if (this.tts !== reply) return;
        this.tts = null;
        this.sendClient({ type: 'tts_end' });
        this.scheduleDrain();
      },
      onError: (message) => {
        if (this.tts !== reply) return;
        this.tts = null;
        // tts_end first so the client doesn't sit in "speaking" forever.
        this.sendClient({ type: 'tts_end' });
        this.fail(message);
        this.scheduleDrain();
      },
    });
  }

  private bargeIn() {
    if (!this.speaking) return;
    this.tts?.job?.cancel();
    this.tts = null;
    this.playbackStartedAt = 0;
    this.playbackMs = 0;
    // Stopping the reply means stopping what was lined up after it too.
    this.speechQueue = [];
    this.currentKind = null;
    if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = null; }
    this.quietSince = Date.now();
    log(`${this.tag} barge-in: reply stopped`);
    this.sendClient({ type: 'barge_in' });
    this.setVoiceState('listening');
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelSend();
    if (this.keepAlive) clearInterval(this.keepAlive);
    try {
      if (this.listen?.readyState === WebSocket.OPEN) this.listen.send(JSON.stringify({ type: 'CloseStream' }));
      this.listen?.close();
    } catch {}
    this.tts?.job?.cancel();
    this.tts = null;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    if (this.waitTimer) clearTimeout(this.waitTimer);
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.agent?.close();
    log(`${this.tag} closed`);
  }
}
