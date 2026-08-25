/**
 * Renders an ```explain block: a complex answer shown one beat at a time.
 *
 * Three rules drive every layout decision here, and they are all about the
 * reader's eye not having to hunt:
 *
 *   1. The objective is pinned. It is the thing that gets lost when an answer
 *      covers several topics, so it never scrolls away.
 *   2. The steps already read collapse into a ONE-LINE rail, not a growing
 *      list. A list pushes the live text further down on every advance.
 *   3. The frame holds the height of the tallest step, so the body text and
 *      the primary button sit at the same pixel for the whole run. You can
 *      click through five steps without moving the mouse.
 *
 * A decision step blocks advancing. Answering it ends the turn: what comes
 * next depends on the answer, so the agent writes it only once it knows —
 * and the continuation folds into this same figure (see lib/explain.ts).
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { renderInlineSubset } from '../lib/inline-md';
import {
  formatAnchor,
  isDecision,
  mergeExplain,
  parseExplain,
  type ExplainBlock,
  type ExplainStep,
} from '../lib/explain';

/** The three ways an explanation fails, independent of what it is about. */
const REWRITE_MODES = [
  { label: 'Give me an analogy', ask: 'Explain this with an analogy, no technical terms.' },
  { label: 'Show me the code', ask: 'Show me the actual code that does this.' },
  { label: 'Start from scratch', ask: 'Assume I do not know the terms and explain from scratch.' },
];

const prose = (text: string) => renderInlineSubset(text, 'ex-code', 'ex-strong');

function send(text: string) {
  window.dispatchEvent(new CustomEvent('codiby-code:send-message', { detail: { text } }));
}

/** Code lines (`|` sigil) keep diff tinting when they carry a +/- column. */
function Artifact({ lines }: { lines: string[] }) {
  return (
    <div className="ex-art">
      {lines.map((line, i) => {
        const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
        return <div key={i} className={`ex-art-row ex-art-${kind}`}>{line || ' '}</div>;
      })}
    </div>
  );
}

function Decision({
  step,
  answer,
  pending,
  onPick,
}: {
  step: ExplainStep;
  answer?: string;
  /** Answered, but the branch it unblocked hasn't arrived yet. */
  pending?: boolean;
  onPick: (label: string) => void;
}) {
  if (answer !== undefined) {
    return (
      <>
        <div className="ex-answered">
          <span className="ex-answered-check" aria-hidden>✓</span>
          <span className="ex-answered-label">{answer}</span>
        </div>
        {pending && <div className="ex-writing">writing the next step…</div>}
      </>
    );
  }
  return (
    <div className="ex-opts">
      {step.options.map((opt, i) => (
        <button key={i} type="button" className="ex-opt" onClick={() => onPick(opt.label)}>
          <span className="ex-opt-key">{i + 1}</span>
          <span className="ex-opt-text">
            {opt.label}
            {opt.description && <span className="ex-opt-desc">{opt.description}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * `continuations` / `answers` are rebuilt from the transcript on every render of
 * the thread, so a shallow compare would always miss and re-run the layout
 * measurement below. Compare by value instead — both are tiny.
 */
function sameProps(a: ExplainProps, b: ExplainProps): boolean {
  return a.source === b.source
    && a.blockId === b.blockId
    && a.continuations.length === b.continuations.length
    && a.continuations.every((s, i) => s === b.continuations[i])
    && JSON.stringify(a.answers) === JSON.stringify(b.answers);
}

interface ExplainProps {
  source: string;
  blockId: string;
  /** Raw sources of the blocks that `continues` this one, in arrival order. */
  continuations: string[];
  /** Step index → the option label the reader picked, from the anchored replies. */
  answers: Record<number, string>;
}

export const Explain = memo(function Explain({
  source,
  blockId,
  continuations,
  answers,
}: ExplainProps) {
  const block: ExplainBlock = useMemo(() => {
    const base = parseExplain(source);
    if (base.error || !continuations.length) return base;
    return mergeExplain(base, continuations.map(parseExplain));
  }, [source, continuations]);

  const steps = block.steps;
  const [cur, setCur] = useState(0);
  const [asking, setAsking] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const slidesRef = useRef<HTMLDivElement>(null);
  const floorRef = useRef(0);
  // `measure` runs from a ResizeObserver, outside React's render, so it reads
  // the steps through a ref rather than closing over a stale array.
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  /**
   * The frame takes the height of the tallest step. Measured on every width
   * change rather than once at mount: the chat pane is resizable, and a
   * message can be rendered while its container is still zero-width, where a
   * single measurement would bake in garbage. `min-height` (never `height`)
   * means a bad measurement can only leave dead space — the body can never
   * overlap the footer.
   */
  const measure = useCallback(() => {
    const frame = frameRef.current;
    const slides = slidesRef.current;
    if (!frame || !slides || !frame.clientWidth) return;

    // Decision steps are excluded from the floor. A list of options is far
    // taller than a paragraph, and reserving that height would leave a hole
    // under every explanation. It costs nothing: on a decision you click an
    // option inside the frame, not the footer button — which is disabled
    // there anyway — so letting that one step push the footer down is free.
    let tallest = 0;
    const children = Array.from(slides.children) as HTMLElement[];
    children.forEach((el, i) => {
      if (isDecision(stepsRef.current[i])) return;
      const wasLive = el.classList.contains('ex-slide-on');
      el.classList.add('ex-slide-on');
      el.style.visibility = 'hidden';
      tallest = Math.max(tallest, el.offsetHeight);
      el.style.visibility = '';
      if (!wasLive) el.classList.remove('ex-slide-on');
    });

    // Only ever grows. Steps that arrive after a decision can make the frame
    // taller once; shrinking it back would move the button under the cursor.
    floorRef.current = Math.max(floorRef.current, tallest);
    frame.style.minHeight = `${floorRef.current}px`;
  }, []);

  useLayoutEffect(measure, [measure, steps, cur, answers]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [measure]);

  // A continuation landed: walk forward to the first step it brought, which is
  // what the reader just unblocked by answering.
  const stepCount = steps.length;
  const prevCount = useRef(stepCount);
  useEffect(() => {
    if (stepCount > prevCount.current) setCur(prevCount.current);
    prevCount.current = stepCount;
  }, [stepCount]);

  const step = steps[cur];
  const waiting = step ? isDecision(step) && answers[cur] === undefined : false;
  const last = cur === steps.length - 1;
  // Any decision still open means the run has steps that don't exist yet — the
  // count must say so wherever you are, not only while standing on the question.
  const openEnded = steps.some((s, i) => isDecision(s) && answers[i] === undefined);

  const pick = useCallback((label: string) => {
    send(`${label}\n\n${formatAnchor({ blockId, step: cur, kind: 'answer' })}`);
  }, [blockId, cur]);

  const rewrite = useCallback((ask: string) => {
    setAsking(false);
    send(`${ask}\n\n${formatAnchor({ blockId, step: cur, kind: 'rewrite' })}`);
  }, [blockId, cur]);

  // Number keys answer the open decision — with one question on screen there is
  // nothing to disambiguate, so there is no submit button either.
  useEffect(() => {
    if (!step || (!waiting && !asking)) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(target.tagName))) return;
      if (e.key === 'Escape' && asking) { setAsking(false); return; }
      if (!waiting) return;
      const n = Number(e.key);
      if (n >= 1 && n <= step.options.length) {
        e.preventDefault();
        pick(step.options[n - 1].label);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [waiting, asking, step, pick]);

  if (block.error || !step) {
    return (
      <pre className="ex-raw" title={`explain: ${block.error || 'no steps'}`}>{source}</pre>
    );
  }

  const extraAsks = step.asks.map(a => ({ label: a, ask: a }));

  return (
    <figure className="ex">
      {block.goal && (
        <div className="ex-goal">
          <span className="ex-goal-tag">Goal</span>
          <span className="ex-goal-text" dangerouslySetInnerHTML={{ __html: prose(block.goal) }} />
        </div>
      )}

      <div className="ex-rail">
        {steps.map((s, i) => {
          const picked = answers[i];
          const tip = picked ? `${s.title} → ${picked}` : s.title;
          return (
            <button
              key={i}
              type="button"
              title={tip}
              onClick={() => setCur(i)}
              className={[
                'ex-seg',
                isDecision(s) ? 'ex-seg-ask' : '',
                i < cur ? 'ex-seg-past' : '',
                i === cur ? 'ex-seg-on' : '',
              ].join(' ')}
            >
              <em className="ex-seg-tip">{tip}</em>
            </button>
          );
        })}
        {openEnded && <span className="ex-seg-ghost" aria-hidden />}
        <span className="ex-count">
          {cur + 1} / {steps.length}{openEnded ? '+' : ''}
        </span>
      </div>

      <div className="ex-frame" ref={frameRef}>
        <div ref={slidesRef}>
          {steps.map((s, i) => (
            <div key={i} className={`ex-slide${i === cur ? ' ex-slide-on' : ''}`}>
              {isDecision(s) && <span className="ex-ask-tag">decision</span>}
              <h3 className="ex-title">{s.title}</h3>
              {s.body.map((line, j) =>
                line === ''
                  ? <div key={j} className="ex-break" />
                  : <p key={j} className="ex-p" dangerouslySetInnerHTML={{ __html: prose(line) }} />
              )}
              {s.code.length > 0 && <Artifact lines={s.code} />}
              {isDecision(s) && (
                <Decision
                  step={s}
                  answer={answers[i]}
                  pending={answers[i] !== undefined && i === steps.length - 1}
                  onPick={pick}
                />
              )}
            </div>
          ))}
        </div>

        {asking && (
          <div className="ex-over">
            <div className="ex-over-head">Send it back to the agent</div>
            {[...REWRITE_MODES, ...extraAsks].map((mode, i) => (
              <button key={i} type="button" className="ex-over-opt" onClick={() => rewrite(mode.ask)}>
                {mode.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="ex-acts">
        <button
          type="button"
          className="ex-btn ex-btn-primary"
          disabled={waiting || last}
          onClick={() => setCur(c => Math.min(c + 1, steps.length - 1))}
        >
          {last && !openEnded ? 'Done ✓' : 'Got it, next →'}
        </button>
        <button
          type="button"
          className="ex-btn ex-btn-ghost"
          disabled={cur === 0}
          onClick={() => setCur(c => Math.max(c - 1, 0))}
        >
          ← Back
        </button>
        {waiting ? (
          <span className="ex-hint">pick one to continue</span>
        ) : (
          <button type="button" className="ex-btn ex-btn-quiet" onClick={() => setAsking(a => !a)}>
            I didn't get this
          </button>
        )}
      </div>
    </figure>
  );
}, sameProps);

/** Placeholder while the closing fence of a streaming block hasn't arrived. */
export function ExplainPending() {
  return (
    <figure className="ex">
      <div className="ex-pending">
        <span className="ex-pending-bar" aria-hidden />
        <span className="ex-pending-bar" aria-hidden />
        <span className="ex-pending-bar" aria-hidden />
      </div>
    </figure>
  );
}
