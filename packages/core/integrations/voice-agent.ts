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
  'You are the voice of a coding assistant: the user talks to you. Another,',
  'slower model does the real work in the repository; you decide what to ask it',
  'for and tell the user what it is doing. To the user you are both ONE single',
  'assistant: speak in the first person ("I\'ll take a look", "I found") and never',
  'mention another agent or model.',
  'Whatever goes in SAY is turned into speech: no markdown, no lists, no code',
  'blocks, no long paths or URLs. Short, natural sentences, as if talking.',
  'LANGUAGE: everything you SAY, and every spoken answer in the progress and',
  'final modes, must be in the language the user speaks to you, even though',
  'these instructions are in English. If the user speaks Spanish, use Mexican',
  'Spanish: tú, never vos. Field labels, action names and (nothing) stay exactly',
  'as written here.',
  'You know nothing outside the conversation: never make up results, causes,',
  'files, times, dates, figures or how much is left.',
  '',
  'You receive <conversation> (the work: what was asked and what it answered),',
  '<voice> (what the user and you have said to each other) and a MODE.',
  '',
  'MODE front — the user just spoke. Answer in exactly this format:',
  'ACTION: <one action>',
  'SAY: <what you say out loud, one or two sentences; may be empty>',
  'INSTRUCTION: <only with send or interrupt>',
  'Actions:',
  '- respond: greetings, small talk, or something the conversation already',
  '  answers. You answer it yourself in SAY; nothing is asked of the work. To a',
  '  greeting, just greet back: don\'t recite the state of the work unless asked.',
  '  A bare call for attention ("hey", "oye", "hey Codin", "Codiby") is respond',
  '  with SAY "Yes?" (in the user\'s language): the user is about to keep',
  '  talking. It is never stop or interrupt.',
  '- send: there is something to do, check or find out. In INSTRUCTION write the',
  '  request clearly and completely, as the user would write it: join the parts',
  '  they said in <voice>, fix obvious transcription errors, add nothing they',
  '  didn\'t ask for. Write it in the user\'s language. In SAY, one short sentence',
  '  on what you are going to do.',
  '- ask: if you are unsure WHAT they want —you don\'t know what they mean, or it',
  '  could be read two ways that would lead to different work— don\'t guess: ask',
  '  in SAY, a single concrete question. When in that doubt, always ask.',
  '  Technical matters (where the bug is, which file, what the cause is) are not',
  '  asked: the work finds those out.',
  '- wait: the sentence ENDS cut off, missing its complement ("now I need you',
  '  to", "the session of"). Starting with "and", "and also" or "plus" doesn\'t',
  '  cut it: if it\'s clear what they want, it isn\'t wait. Empty SAY: the user is',
  '  going to keep talking and you join the parts.',
  'Only if I tell you the work is IN PROGRESS, you may also:',
  '- interrupt: they change what they want or correct the course, and carrying',
  '  on would be wasted work. The work is stopped and your INSTRUCTION is sent.',
  '- stop: only with a clear order to stop ("stop", "para", "detente", "cancel",',
  '  "enough", "forget it"), without asking for anything else. A greeting, a call',
  '  for attention or a question never stops the work.',
  '  Stopping the work has a cost: if they only add information, it\'s send.',
  '',
  'MODE progress — the work is still in progress. One sentence: what you are',
  'doing now, based on the latest steps. Don\'t repeat earlier updates. No',
  'format: just the sentence. If there is nothing new to tell, answer exactly:',
  '(nothing)',
  '',
  'MODE final — a new message arrived from the work: an update or the final',
  'answer. No format: one to three spoken sentences, in the first person, with',
  'the essentials, figures and important decisions. If it asks a question, end',
  'with that SAME question, as a question: "should I fix it?" never becomes',
  '"I\'ll fix it". Add nothing that isn\'t in the message: if it only says what',
  'is going to be done, say it as an intention ("I\'m checking…"), never as a',
  'finding, and never take results from the earlier conversation as new.',
  'If I tell you that you were saying something else, you are cutting yourself',
  'off: open with a short, natural transition ("hold on, here\'s an update"). If',
  'I don\'t tell you, use no transition at all: go straight to the answer.',
  'If I tell you what you already said this turn, the user already heard it:',
  'don\'t repeat or paraphrase it; start straight with what the message adds.',
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
      lines.push(`[agent used ${m.toolName}${detail ? `: ${clip(detail, MAX_TOOL_CHARS)}` : ''}]`);
    } else if (m.content?.trim()) {
      lines.push(`${m.role === 'user' ? 'User' : 'Agent'}: ${clip(m.content, MAX_MESSAGE_CHARS)}`);
    }
  }
  return lines.slice(-limit).join('\n');
}

/** One line of what the user and the voice said to each other. */
export interface VoiceLine { who: 'user' | 'voice'; text: string }

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
  const voice = voiceLog.slice(-VOICE_LOG_LINES).map((l) => `${l.who === 'user' ? 'User' : 'You'}: ${l.text}`).join('\n');
  const said = alreadySaid.length ? `You already said this turn: ${alreadySaid.map((s) => `"${s}"`).join(' ')}\n\n` : '';
  const task = mode === 'front'
    ? `${busy ? 'The work is IN PROGRESS.\n' : ''}${noMore ? 'You waited and the user didn\'t say anything more: don\'t choose wait. If it isn\'t clear, ask.\n' : ''}The user just said: "${payload}"`
    : mode === 'progress'
      ? `Updates you already gave: ${payload || '(none)'}`
      : `${said}${interrupting ? 'You were saying something else and are about to cut yourself off.\n\n' : ''}New message:\n${payload}`;
  return `<conversation>\n${context || '(empty)'}\n</conversation>\n\n<voice>\n${voice || '(empty)'}\n</voice>\n\nMODE ${mode}\n${task}`;
}

export type FrontAction = 'respond' | 'send' | 'ask' | 'wait' | 'interrupt' | 'stop';

export interface FrontDecision {
  action: FrontAction;
  say: string;
  instruction: string;
}

const FRONT_ACTIONS = new Set<FrontAction>(['respond', 'send', 'ask', 'wait', 'interrupt', 'stop']);

/**
 * Read the front decision. `null` when there's no recognizable action — the
 * caller then sends the user's words untouched, so a garbled answer can lose
 * nothing. An `enviar`/`interrumpir` without an instruction is garbled too.
 */
export function parseFront(text: string): FrontDecision | null {
  // Haiku fills unused fields with "(vacío)" or "-"; read aloud, that's noise.
  const blank = (v: string) => (/^[(\[]?\s*(empty|none|nothing|vac[ií]o|ninguno|ninguna|nada|n\/a|-+)\s*[)\]]?\.?$/i.test(v) ? '' : v);
  const field = (name: string) => {
    const m = text.match(new RegExp(`^\\s*${name}:[ \\t]*(.*)$`, 'im'));
    return m ? blank(m[1]!.trim()) : '';
  };
  const action = field('ACTION').toLowerCase().split(/\s/)[0] as FrontAction;
  if (!FRONT_ACTIONS.has(action)) return null;
  // The instruction may run over several lines; everything after its label.
  const instr = blank(text.match(/^\s*INSTRUCTION:[ \t]*([\s\S]*)$/im)?.[1]?.trim() ?? '');
  const decision = { action, say: field('SAY'), instruction: instr };
  if ((action === 'send' || action === 'interrupt') && !decision.instruction) return null;
  return decision;
}

/**
 * Front's format leaking into another mode: the action and instruction are
 * control signals and never speech; a DECIR line is speech with a label on it.
 */
export function stripActionLines(text: string): string {
  // The whole front format: only DECIR is speech. An instruction running over
  // several lines would otherwise be read aloud past its first line.
  if (/^\s*ACTION:/im.test(text)) {
    return text.match(/^\s*SAY:[ \t]*(.*)$/im)?.[1]?.trim() ?? '';
  }
  return text
    .split('\n')
    .filter((l) => !/^\s*(ACTION|INSTRUCTION):/i.test(l))
    .map((l) => l.replace(/^\s*SAY:\s*/i, ''))
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
    void stream.ask(buildPrompt('front', '', 'hi'), 15_000);
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
    if (!text || /^\((nothing|nada)\)\.?$/i.test(text)) return null;
    return text;
  }

  close() {
    this.stream.close();
    this.next?.close();
  }
}
