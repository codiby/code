/**
 * The voice of voice mode: Haiku is who the user talks to.
 *
 * The session's model (Opus) takes seconds to minutes per turn, answers in
 * markdown meant to be read, and can't make sense of a sentence cut in half
 * by the transcriber. So what the user says goes to this agent first:
 *   front     decides per utterance — answer it itself, write the session an
 *             instruction, ask the user to clarify, wait for the rest of a cut
 *             sentence, or (mid-turn) interrupt or stop the session
 *   progress  narrates what the session is doing during long turns
 *   final     turns each new session message into a few spoken sentences
 * It has no tools; the session remains the only one doing work.
 *
 * One streaming `query()` stays open per voice connection: a cold one-shot
 * spends ~1.7 s spawning Claude Code before the first token, a warm one ~0.5 s.
 * The stream is replaced every RECYCLE_AFTER asks with the next one warmed up
 * in advance. Nothing is lost when it is: what Haiku and the user said to each
 * other travels in every prompt (the voice log), not in the stream's memory.
 */

import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_BIN } from '../config/config';
import { log, logError } from '../lib/logger';
import type { ChatMessage } from '../session/state';

export type VoiceAgentMode = 'front' | 'progress' | 'final';

/** How much of the session the agent sees — enough to resolve "eso", "lo de antes". */
export const CONTEXT_MESSAGES = 20;
/** Lines of the user↔voice dialogue carried in each prompt. */
export const VOICE_LOG_LINES = 16;
const MAX_MESSAGE_CHARS = 600;
const MAX_TOOL_CHARS = 140;
/**
 * The stream's own history is only a liability — every prompt carries what
 * matters: after a dozen asks Haiku started imitating old answers (an action
 * line inside a summary, read aloud). A short run keeps it clean.
 */
const RECYCLE_AFTER = 4;

const SYSTEM_PROMPT = [
  'Eres la voz de un asistente de programación: el usuario habla contigo. Otro',
  'modelo, más lento, hace el trabajo real en el repositorio; tú decides qué le',
  'pides y le cuentas al usuario lo que hace. Para el usuario ambos son UN SOLO',
  'asistente: habla en primera persona ("voy a revisar", "encontré") y nunca',
  'menciones a otro agente o modelo.',
  'Lo que va en DECIR se convierte en voz: sin markdown, sin listas, sin bloques',
  'de código, sin rutas largas ni URLs. Frases cortas, naturales, como hablando.',
  'Responde en el idioma del usuario; en español, de México: tú, nunca vos.',
  'No sabes nada fuera de la conversación: nunca inventes resultados, causas,',
  'archivos, horas, fechas, cifras ni cuánto falta.',
  '',
  'Recibes <conversacion> (el trabajo: lo que se le pidió y lo que respondió),',
  '<voz> (lo que el usuario y tú se han dicho) y un MODO.',
  '',
  'MODO front — el usuario acaba de hablar. Responde exactamente en este formato:',
  'ACCION: <una acción>',
  'DECIR: <lo que dices en voz alta, una o dos frases; puede ir vacío>',
  'INSTRUCCION: <solo con enviar o interrumpir>',
  'Acciones:',
  '- responder: saludos, plática, o algo que ya responde la conversación. Lo',
  '  contestas tú en DECIR; no se le pide nada al trabajo. A un saludo, saluda',
  '  y ya: no recites el estado del trabajo si no te lo preguntan.',
  '  Una llamada de atención sola ("oye", "oye Codin", "hey", "Codiby") es',
  '  responder con DECIR "¿Sí?": el usuario va a seguir hablando. Nunca es',
  '  detener ni interrumpir.',
  '- enviar: hay algo que hacer, revisar o averiguar. En INSTRUCCION redactas el',
  '  pedido claro y completo, como lo escribiría el usuario: junta las partes que',
  '  dijo en <voz>, corrige errores de transcripción obvios, no agregues nada que',
  '  no pidió. En DECIR, una frase corta de qué vas a hacer.',
  '- preguntar: si tienes duda de QUÉ quiere —no sabes a qué se refiere, o cabe',
  '  entenderlo de dos formas que llevarían a trabajos distintos— no adivines:',
  '  pregúntale en DECIR, una sola pregunta concreta. Ante esa duda, siempre',
  '  pregunta. Lo técnico (dónde está el error, qué archivo, cuál es la causa) no',
  '  se pregunta: eso lo averigua el trabajo.',
  '- esperar: la frase TERMINA cortada, sin su complemento ("ahora necesito que",',
  '  "la sesión de"). Empezar con "y", "y también que" o "además" no la corta: si',
  '  se entiende qué pide, no es esperar. DECIR vacío: el usuario va a seguir',
  '  hablando y tú juntas las partes.',
  'Solo si te indico que el trabajo está EN CURSO, también puedes:',
  '- interrumpir: cambia lo que quiere o corrige el rumbo, y seguir sería trabajo',
  '  perdido. Se detiene el trabajo y se envía tu INSTRUCCION.',
  '- detener: solo con una orden clara de parar ("para", "detente", "cancela",',
  '  "basta", "olvídalo"), sin pedir nada más. Un saludo, una llamada de atención',
  '  o una pregunta nunca detienen el trabajo.',
  '  Detener trabajo tiene costo: si solo agrega información, es enviar.',
  '',
  'MODO progress — el trabajo sigue en curso. Una frase: qué estás haciendo ahora',
  'según los últimos pasos. No repitas avisos anteriores. Sin formato: solo la',
  'frase. Si no hay nada nuevo que contar, responde exactamente: (nada)',
  '',
  'MODO final — llegó un mensaje nuevo del trabajo: un avance o la respuesta',
  'final. Sin formato: una a tres frases habladas, en primera persona, con lo',
  'esencial, cifras y decisiones importantes. Si hace una pregunta, termina con',
  'esa MISMA pregunta, como pregunta: "¿lo corrijo?" nunca se vuelve "lo',
  'corrijo". No agregues nada que no esté en el mensaje: si solo dice lo que se',
  'va a hacer, dilo como intención ("estoy revisando…"), nunca como hallazgo, y',
  'nunca tomes resultados de la conversación anterior como si fueran nuevos.',
  'Si te indico que estabas diciendo otra cosa, te estás cortando a ti mismo:',
  'empieza con una transición corta y natural ("espera, te actualizo"). Si no',
  'te lo indico, no uses ninguna transición: ve directo a la respuesta.',
  'Si te indico lo que ya dijiste en este turno, el usuario ya lo escuchó: no lo',
  'repitas ni lo parafrasees; empieza directo con lo que el mensaje agrega.',
].join('\n');

/**
 * Keep the start and the end. Cutting only the tail dropped the part that
 * matters most in an answer — its closing question — so "hazlo" after
 * "…¿bajo la pausa a 800 ms?" had nothing to refer to.
 */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const head = Math.floor(max * 0.4);
  return `${flat.slice(0, head)} … ${flat.slice(flat.length - (max - head - 3))}`;
}

function describeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const pick = i.description ?? i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.query ?? i.url ?? i.prompt;
  return typeof pick === 'string' ? pick : '';
}

/**
 * The last `limit` meaningful messages as a plain transcript. Thinking, tool
 * results and terminal chrome are left out: they are long, and the agent only
 * needs to know what was said and which steps were taken.
 */
export function buildContext(messages: ChatMessage[], limit = CONTEXT_MESSAGES): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.isThinking || m.isToolResult || m.isTerminal || m.role === 'system') continue;
    if (m.toolName) {
      const detail = describeToolInput(m.toolInput);
      lines.push(`[agente usó ${m.toolName}${detail ? `: ${clip(detail, MAX_TOOL_CHARS)}` : ''}]`);
    } else if (m.content?.trim()) {
      lines.push(`${m.role === 'user' ? 'Usuario' : 'Agente'}: ${clip(m.content, MAX_MESSAGE_CHARS)}`);
    }
  }
  return lines.slice(-limit).join('\n');
}

/** One line of what the user and the voice said to each other. */
export interface VoiceLine { who: 'usuario' | 'voz'; text: string }

export interface AskOptions {
  /** The user↔voice dialogue so far — the voice's memory across streams. */
  voiceLog?: VoiceLine[];
  /** What the user already heard this turn; `final` must not repeat it. */
  alreadySaid?: string[];
  /** The session is mid-turn: front may also interrupt or stop it. */
  busy?: boolean;
  /** Haiku is cutting off its own ack or progress note to say this. */
  interrupting?: boolean;
  /** Front already chose to wait and the user said nothing more. */
  noMore?: boolean;
}

export function buildPrompt(mode: VoiceAgentMode, context: string, payload: string, opts: AskOptions = {}): string {
  const { voiceLog = [], alreadySaid = [], busy = false, interrupting = false, noMore = false } = opts;
  const voz = voiceLog.slice(-VOICE_LOG_LINES).map((l) => `${l.who === 'usuario' ? 'Usuario' : 'Tú'}: ${l.text}`).join('\n');
  const said = alreadySaid.length ? `Ya dijiste en este turno: ${alreadySaid.map((s) => `"${s}"`).join(' ')}\n\n` : '';
  const task = mode === 'front'
    ? `${busy ? 'El trabajo está EN CURSO.\n' : ''}${noMore ? 'Esperaste y el usuario ya no siguió hablando: no elijas esperar. Si no se entiende, pregunta.\n' : ''}El usuario acaba de decir: "${payload}"`
    : mode === 'progress'
      ? `Avisos que ya diste: ${payload || '(ninguno)'}`
      : `${said}${interrupting ? 'Estabas diciendo otra cosa y te vas a cortar.\n\n' : ''}Mensaje nuevo:\n${payload}`;
  return `<conversacion>\n${context || '(vacía)'}\n</conversacion>\n\n<voz>\n${voz || '(vacía)'}\n</voz>\n\nMODO ${mode}\n${task}`;
}

export type FrontAction = 'responder' | 'enviar' | 'preguntar' | 'esperar' | 'interrumpir' | 'detener';

export interface FrontDecision {
  action: FrontAction;
  say: string;
  instruction: string;
}

const FRONT_ACTIONS = new Set<FrontAction>(['responder', 'enviar', 'preguntar', 'esperar', 'interrumpir', 'detener']);

/**
 * Read the front decision. `null` when there's no recognizable action — the
 * caller then sends the user's words untouched, so a garbled answer can lose
 * nothing. An `enviar`/`interrumpir` without an instruction is garbled too.
 */
export function parseFront(text: string): FrontDecision | null {
  // Haiku fills unused fields with "(vacío)" or "-"; read aloud, that's noise.
  const blank = (v: string) => (/^[(\[]?\s*(vac[ií]o|ninguno|ninguna|nada|n\/a|-+)\s*[)\]]?\.?$/i.test(v) ? '' : v);
  const field = (name: string) => {
    const m = text.match(new RegExp(`^\\s*${name}:[ \\t]*(.*)$`, 'im'));
    return m ? blank(m[1]!.trim()) : '';
  };
  const action = field('ACCI[OÓ]N').toLowerCase().split(/\s/)[0] as FrontAction;
  if (!FRONT_ACTIONS.has(action)) return null;
  // The instruction may run over several lines; everything after its label.
  const instr = blank(text.match(/^\s*INSTRUCCI[OÓ]N:[ \t]*([\s\S]*)$/im)?.[1]?.trim() ?? '');
  const decision = { action, say: field('DECIR'), instruction: instr };
  if ((action === 'enviar' || action === 'interrumpir') && !decision.instruction) return null;
  return decision;
}

/**
 * Front's format leaking into another mode: the action and instruction are
 * control signals and never speech; a DECIR line is speech with a label on it.
 */
export function stripActionLines(text: string): string {
  // The whole front format: only DECIR is speech. An instruction running over
  // several lines would otherwise be read aloud past its first line.
  if (/^\s*ACCI[OÓ]N:/im.test(text)) {
    return text.match(/^\s*DECIR:[ \t]*(.*)$/im)?.[1]?.trim() ?? '';
  }
  return text
    .split('\n')
    .filter((l) => !/^\s*(ACCI[OÓ]N|INSTRUCCI[OÓ]N):/i.test(l))
    .map((l) => l.replace(/^\s*DECIR:\s*/i, ''))
    .join('\n')
    .trim();
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: undefined as unknown as string,
  };
}

interface Pending { resolve(text: string | null): void; settled: boolean }

/** One warm Haiku stream. Asks are answered strictly in order. */
class WarmStream {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private pending: Pending[] = [];
  private retiring = false;
  private runtime: Query;
  private closed = false;
  asks = 0;

  constructor(private tag: string) {
    const self = this;
    async function* input() {
      while (!self.closed) {
        while (self.queue.length) yield self.queue.shift()!;
        await new Promise<void>((r) => { self.wake = r; });
      }
    }
    this.runtime = query({
      prompt: input(),
      options: {
        model: 'haiku',
        maxTurns: 1000,
        // No built-in tools at all. With them merely denied, Haiku read "the
        // other agent does the work" as "go look", tried a tool, got refused
        // and answered on a second round trip: 3.5 s instead of 0.7.
        tools: [],
        systemPrompt: SYSTEM_PROMPT,
        // Same trimming as suggestions/suggest.ts: no user settings, MCP
        // servers or extended thinking — each costs seconds on a reply that
        // has to arrive in under one.
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        thinking: { type: 'disabled' },
        pathToClaudeCodeExecutable: CLAUDE_BIN,
      },
    });
    void this.read();
  }

  private async read() {
    try {
      for await (const msg of this.runtime) {
        if (msg.type !== 'result') continue;
        const next = this.pending.shift();
        const text = (msg as { result?: string }).result?.trim() ?? '';
        if (next && !next.settled) { next.settled = true; next.resolve(text || null); }
        if (this.retiring && !this.waiting) this.close();
      }
    } catch (err) {
      if (!this.closed) logError(`${this.tag} fast agent stream ended: ${err instanceof Error ? err.message : err}`);
    }
    // Whatever was still waiting will never be answered.
    for (const p of this.pending.splice(0)) if (!p.settled) { p.settled = true; p.resolve(null); }
    this.closed = true;
  }

  get alive() { return !this.closed && !this.retiring; }

  /** Someone is still waiting on an answer from this stream. */
  private get waiting() { return this.pending.some((p) => !p.settled); }

  /**
   * Stop taking asks but let the ones in flight finish. Closing outright on a
   * swap threw away whatever was mid-answer — a relay started just before an
   * ack triggered the swap came back empty.
   */
  retire() {
    this.retiring = true;
    if (!this.waiting) this.close();
  }

  ask(prompt: string, timeoutMs: number): Promise<string | null> {
    if (this.closed || this.retiring) return Promise.resolve(null);
    this.asks++;
    return new Promise((resolve) => {
      // Stays in `pending` after a timeout so the late result is consumed by
      // its own slot instead of being handed to the next ask.
      const p: Pending = { resolve, settled: false };
      this.pending.push(p);
      setTimeout(() => {
        if (p.settled) return;
        p.settled = true;
        resolve(null);
        if (this.retiring && !this.waiting) this.close();
      }, timeoutMs);
      this.queue.push(userMessage(prompt));
      this.wake?.();
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.wake?.();
    void this.runtime.interrupt?.().catch(() => {});
  }
}

export class FastVoiceAgent {
  private stream: WarmStream;
  /** Started ahead of time so swapping streams never costs a cold start. */
  private next: WarmStream | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private tag: string) {
    // Pays the ~1.7 s process start now, while the user is still talking,
    // instead of on the first ack.
    this.stream = this.warm();
  }

  private warm(): WarmStream {
    const stream = new WarmStream(this.tag);
    // A plain greeting, not a mode that can answer "(nada)" or carry an action
    // line: whatever this answers stays in the stream's history as an example.
    void stream.ask(buildPrompt('front', '', 'hola'), 15_000);
    return stream;
  }

  /**
   * One ask at a time. Prompts pushed while Haiku was still answering got
   * folded by Claude Code into a single turn — one result for several asks —
   * so answers came back empty or shifted onto the wrong question ("revisa el
   * log" answered with "listo, me paro"). The wait is one answer, ~0.7 s.
   */
  ask(
    mode: VoiceAgentMode,
    messages: ChatMessage[],
    payload: string,
    timeoutMs: number,
    opts: AskOptions = {},
  ): Promise<string | null> {
    const run = this.chain.then(() => this.askNow(mode, messages, payload, timeoutMs, opts));
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async askNow(
    mode: VoiceAgentMode,
    messages: ChatMessage[],
    payload: string,
    timeoutMs: number,
    opts: AskOptions,
  ): Promise<string | null> {
    if (!this.stream.alive || this.stream.asks >= RECYCLE_AFTER) {
      this.stream.retire();
      this.stream = this.next?.alive ? this.next : this.warm();
      this.next = null;
    }
    // One ask before the swap, start the replacement so it's warm by then.
    if (!this.next && this.stream.asks >= RECYCLE_AFTER - 1) this.next = this.warm();

    const t0 = Date.now();
    const raw = await this.stream.ask(buildPrompt(mode, buildContext(messages), payload, opts), timeoutMs);
    log(`${this.tag} fast ${mode} in ${Date.now() - t0} ms: ${raw ? raw.slice(0, 100) : '(none)'}`);
    // The busy ack's action line is parsed by the caller; anywhere else it's a
    // stray from the stream's history and must never be read aloud.
    const text = raw && mode !== 'front' ? stripActionLines(raw) : raw;
    if (!text || text === '(nada)') return null;
    return text;
  }

  close() {
    this.stream.close();
    this.next?.close();
  }
}
