/**
 * RichInput — a `contenteditable` editor that behaves like a controlled input.
 *
 * The source of truth is the `value` string (the markdown draft). On every edit
 * we serialize the DOM back to a string, hand it to `onChange`, then re-render a
 * canonical highlighted DOM and restore the caret by character offset. Because
 * the editable layer *is* the styled layer, fenced code blocks can render as
 * real bordered cards (Slack-style) — something the old textarea+overlay could
 * never do without breaking caret alignment.
 *
 * Caret coordination with the parent:
 *   - User edits: the caret measured mid-edit is restored after re-render.
 *   - Programmatic edits (formatting shortcuts, history): the parent stamps the
 *     desired caret into `desiredCaretRef` right before changing `value`.
 *
 * IME/dead-key safety: we never touch the DOM mid-composition (Spanish accents,
 * etc.) — edits are flushed on `compositionend`.
 *
 * Known trade-off: re-rendering innerHTML drops the browser's native undo
 * stack. Acceptable for a chat composer; revisit if undo becomes important.
 */
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { renderEditorHtml } from '../lib/composer-markdown';
import { getCaret, serializeEditor, setCaret } from '../lib/contenteditable';

type Caret = { start: number; end: number };

interface Props {
  value: string;
  onChange: (text: string) => void;
  /** Parent stamps a desired caret here before a programmatic value change. */
  desiredCaretRef: React.MutableRefObject<Caret | null>;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLDivElement>) => void;
  onFocus?: () => void;
  autoFocus?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

export const RichInput = forwardRef<HTMLDivElement, Props>(function RichInput(props, ref) {
  const { value, onChange, desiredCaretRef, onKeyDown, onPaste, onFocus, autoFocus, disabled, placeholder, className } = props;

  const elRef = useRef<HTMLDivElement | null>(null);
  useImperativeHandle(ref, () => elRef.current as HTMLDivElement, []);

  const composingRef = useRef(false);
  const measuredRef = useRef<Caret | null>(null);

  // Re-render the canonical DOM from `value` and put the caret back. Skips work
  // when the DOM already matches (avoids disturbing an unfocused selection).
  const canonicalize = () => {
    const el = elRef.current;
    if (!el || composingRef.current) return;
    const html = renderEditorHtml(value);
    if (el.innerHTML !== html) el.innerHTML = html;
    if (document.activeElement !== el) {
      desiredCaretRef.current = null;
      measuredRef.current = null;
      return;
    }
    const want = desiredCaretRef.current ?? measuredRef.current ?? { start: value.length, end: value.length };
    desiredCaretRef.current = null;
    measuredRef.current = null;
    setCaret(el, value, want.start, want.end);
  };

  // Apply canonical rendering whenever the controlled value changes.
  useLayoutEffect(() => {
    canonicalize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // React only honors `autoFocus` on input/textarea/select/button — never on a
  // contentEditable <div> — so the prop is a no-op here. Focus the editor
  // ourselves on mount when the host asks for it. This composer is keyed by the
  // active session, so it remounts on tab switch and after `/clear` spawns a
  // fresh session; without this the caret would land on <body> instead of the
  // new empty composer.
  useLayoutEffect(() => {
    if (autoFocus) elRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Read the user's edit out of the DOM. If it changed the text, push it up
  // (React re-render → layout effect re-renders + restores). If the text is
  // unchanged but the DOM diverged (e.g. just typed into an un-highlighted
  // span), canonicalize in place since `value` won't change.
  const flush = () => {
    const el = elRef.current;
    if (!el) return;
    const text = serializeEditor(el);
    measuredRef.current = getCaret(el);
    if (text === value) canonicalize();
    else onChange(text);
  };

  const handleInput = () => {
    if (composingRef.current) return; // wait for compositionend
    flush();
  };

  return (
    <div
      ref={elRef}
      contentEditable={!disabled}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      spellCheck={false}
      autoFocus={autoFocus}
      data-empty={value === '' ? 'true' : undefined}
      data-placeholder={placeholder}
      className={className}
      onInput={handleInput}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={() => { composingRef.current = false; flush(); }}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onFocus={onFocus}
    />
  );
});
