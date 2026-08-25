/**
 * Grammar for the ```explain fenced block.
 *
 * An `explain` block is a complex answer the agent breaks into beats, which the
 * UI shows ONE AT A TIME inside a frame of constant height. The reader advances
 * at their own pace; the objective stays pinned above and the text never drifts
 * down the screen as steps accumulate.
 *
 * A step can also be a *decision*. That changes the block's nature: what comes
 * after a decision depends on the answer, so the agent cannot author it up
 * front. It writes up to the decision, the turn ends, and the continuation
 * arrives later as another block carrying `continues <id>` — appended to the
 * same figure rather than drawn as a new message.
 *
 * Pure module (no DOM, no React) so the grammar is unit-testable on its own.
 *
 *     goal Bajar los watches sin romper el auto-reload
 *     # Un watch por carpeta
 *     El watcher pide un aviso por cada carpeta del proyecto.
 *     |+const SKIP = new Set(['node_modules', '.git'])
 *     # ¿De dónde sale la lista a ignorar?
 *     Dónde vive cambia el resto del arreglo.
 *     = Fija, en el código · Simple, se versiona con el repo
 *     = Configurable por proyecto · Cada repo la ajusta
 */

import { splitBlockSegments } from './block-fences';

export interface ExplainOption {
  label: string;
  description?: string;
}

export interface ExplainStep {
  title: string;
  /** Prose lines, in order. Rendered with the inline-markdown subset. */
  body: string[];
  /** Verbatim code lines (`|` sigil); a leading +/- tints them like a diff. */
  code: string[];
  /** Present (non-empty) => this step is a decision and blocks advancing. */
  options: ExplainOption[];
  /** Agent-authored extras for the "no entendí" panel, on top of the fixed three. */
  asks: string[];
}

export interface ExplainBlock {
  goal: string;
  /** Id of the block this one continues, when it is a branch continuation. */
  continues?: string;
  steps: ExplainStep[];
  /** Set when the source is malformed; callers fall back to a plain block. */
  error?: string;
}

const GOAL_RE = /^goal\s+(.+)$/;
const CONTINUES_RE = /^continues\s+(\S+)$/;
const TITLE_RE = /^#\s+(.+)$/;
const OPTION_RE = /^=\s+(.+)$/;
const ASK_RE = /^\?\s+(.+)$/;

/** `Label · description` — the separator is a middle dot, optional. */
function parseOption(raw: string): ExplainOption {
  const dot = raw.indexOf('·');
  if (dot < 0) return { label: raw.trim() };
  const label = raw.slice(0, dot).trim();
  const description = raw.slice(dot + 1).trim();
  return description ? { label, description } : { label };
}

function newStep(title: string): ExplainStep {
  return { title, body: [], code: [], options: [], asks: [] };
}

/**
 * Parse the body of an ```explain fence. Never throws: anything it cannot make
 * sense of comes back as `error` so the caller can render the raw source rather
 * than show the reader a broken figure.
 */
export function parseExplain(source: string): ExplainBlock {
  const fail = (error: string): ExplainBlock => ({ goal: '', steps: [], error });

  const lines = source.replace(/\s+$/, '').split('\n');
  let goal = '';
  let continues: string | undefined;
  const steps: ExplainStep[] = [];
  let step: ExplainStep | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();

    const title = TITLE_RE.exec(line.trimStart());
    if (title) {
      step = newStep(title[1].trim());
      steps.push(step);
      continue;
    }

    // Directives are only meaningful in the preamble, before the first step.
    if (!step) {
      const g = GOAL_RE.exec(line.trim());
      if (g) { goal = g[1].trim(); continue; }
      const c = CONTINUES_RE.exec(line.trim());
      if (c) { continues = c[1]; continue; }
      if (line.trim()) return fail('content before the first `# step`');
      continue;
    }

    if (line.startsWith('|')) { step.code.push(line.slice(1)); continue; }

    const opt = OPTION_RE.exec(line.trimStart());
    if (opt) { step.options.push(parseOption(opt[1])); continue; }

    const ask = ASK_RE.exec(line.trimStart());
    if (ask) { step.asks.push(ask[1].trim()); continue; }

    // Blank lines separate paragraphs; a run of them collapses to one break.
    if (!line.trim()) {
      if (step.body.length && step.body[step.body.length - 1] !== '') step.body.push('');
      continue;
    }
    step.body.push(line.trim());
  }

  if (!steps.length) return fail('no `# step` lines');
  if (!goal && !continues) return fail('missing `goal <text>`');

  // Trailing blank from the paragraph rule above is never meaningful.
  for (const s of steps) {
    while (s.body.length && s.body[s.body.length - 1] === '') s.body.pop();
  }

  return { goal, continues, steps };
}

/* ---------------------------------------------------------------------------
   Anchors.

   When the reader answers a decision or asks for a step to be rewritten, that
   IS a turn to the model — someone has to generate the reply. What it must not
   be is a new pair of bubbles in the thread: the whole point of the format is
   that the conversation stops growing.

   So the outgoing message carries an anchor naming the block and step it
   belongs to, and the renderer routes it there instead of drawing it. The
   anchor rides in an HTML comment: the model reads it as plain context, and the
   markdown renderer already strips comments, so it can never leak on screen.
   --------------------------------------------------------------------------- */

export interface ExplainAnchor {
  blockId: string;
  step: number;
  kind: 'answer' | 'rewrite';
}

const ANCHOR_RE = /<!--\s*explain\s+block=(\S+)\s+step=(\d+)\s+kind=(answer|rewrite)\s*-->/;

/**
 * Stable identity for a block: the message that authored it plus its index in
 * that message. Derived, so the agent never has to invent — or collide on — an
 * id of its own.
 */
export function explainBlockId(messageId: string, index: number): string {
  return `${messageId}:${index}`;
}

export function formatAnchor(anchor: ExplainAnchor): string {
  return `<!-- explain block=${anchor.blockId} step=${anchor.step} kind=${anchor.kind} -->`;
}

export function parseAnchor(text: string): ExplainAnchor | null {
  const m = ANCHOR_RE.exec(text);
  if (!m) return null;
  return { blockId: m[1], step: Number(m[2]), kind: m[3] as ExplainAnchor['kind'] };
}

/** True when the message exists only to feed a block and must not be drawn. */
export function isAnchoredMessage(text: string): boolean {
  return ANCHOR_RE.test(text);
}

/** True when the step is a decision, i.e. it blocks until the reader answers. */
export function isDecision(step: ExplainStep): boolean {
  return step.options.length > 0;
}

/* ---------------------------------------------------------------------------
   Deriving a block's live state from the transcript.

   Nothing about an explain block is stored: the answers and the continuations
   ARE the messages that carried them. That is what makes the block survive a
   remount, a reload, or scrolling out of the virtualised window — and it is
   why re-deciding is a truncation (drop the messages after) rather than an
   edit.
   --------------------------------------------------------------------------- */

export interface ExplainParts {
  /** Block id → raw sources of the blocks continuing it, in arrival order. */
  continuations: Record<string, string[]>;
  /** Block id → step index → the option label the reader picked. */
  answers: Record<string, Record<number, string>>;
}

export interface ExplainSourceMessage {
  id: string;
  role: string;
  content: string;
  isThinking?: boolean;
}

export const EMPTY_EXPLAIN_PARTS: ExplainParts = { continuations: {}, answers: {} };

/**
 * Scan a message window for everything the explain blocks in it need, and for
 * the messages that must NOT be drawn as bubbles: the reader's answers, and any
 * message whose whole content was a continuation block.
 *
 * A continuation that arrives alongside real prose is kept visible — swallowing
 * an agent's text because it happened to tack a block on is a worse failure than
 * an extra bubble.
 */
export function collectExplainParts(
  messages: readonly ExplainSourceMessage[],
): { parts: ExplainParts; hidden: Set<string> } {
  const parts: ExplainParts = { continuations: {}, answers: {} };
  const hidden = new Set<string>();
  // True between an anchored message and the reply it triggered. The reasoning
  // for that turn belongs to the block too: if the question never drew a bubble,
  // a stray "Thought" bubble answering it is an orphan on screen.
  let inAnchoredTurn = false;

  for (const message of messages) {
    if (typeof message.content !== 'string' || !message.content) continue;

    if (message.isThinking) {
      if (inAnchoredTurn) hidden.add(message.id);
      continue;
    }

    const anchor = parseAnchor(message.content);
    if (anchor) {
      hidden.add(message.id);
      inAnchoredTurn = true;
      if (anchor.kind === 'answer') {
        const label = message.content.replace(ANCHOR_RE, '').trim().split('\n')[0].trim();
        (parts.answers[anchor.blockId] ||= {})[anchor.step] = label;
      }
      continue;
    }

    // Any other non-thinking message closes the turn the anchor opened.
    if (message.role === 'assistant') inAnchoredTurn = false;

    if (!message.content.includes('continues')) continue;
    const segments = splitBlockSegments(message.content, ['explain']);
    let found = false;
    let leftover = '';
    for (const segment of segments) {
      if (segment.type === 'block') {
        const parsed = parseExplain(segment.source);
        if (parsed.continues) {
          (parts.continuations[parsed.continues] ||= []).push(segment.source);
          found = true;
          continue;
        }
      }
      leftover += (segment.type === 'md' ? segment.text : '') + '\n';
    }
    if (found && !leftover.trim()) hidden.add(message.id);
  }

  return { parts, hidden };
}

/**
 * Fold continuation blocks into the block they continue.
 *
 * Continuations are append-only: a branch that gets re-decided is dropped by
 * the caller (which truncates `parts`), never mutated. A continuation's own
 * `goal` is ignored — the objective belongs to the original block and pinning a
 * new one halfway through is exactly the disorientation this format avoids.
 */
export function mergeExplain(base: ExplainBlock, parts: ExplainBlock[]): ExplainBlock {
  if (!parts.length) return base;
  const steps = [...base.steps];
  for (const part of parts) {
    if (part.error) continue;
    steps.push(...part.steps);
  }
  return { ...base, steps };
}
