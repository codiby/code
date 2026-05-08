/**
 * Right-side preview panel for HTML mockups produced by the `mockup_write` /
 * `mockup_edit` SDK tools.
 *
 * Renders the mockup inside a sandboxed iframe and overlays an inspector:
 *
 *   - "Inspect" toggle in the header puts the iframe into pick mode.
 *     Clicking an element opens a comment popup positioned over the
 *     iframe at the click coords.
 *   - Each saved comment leaves a numbered violet dot anchored to the
 *     element. Clicking a dot reopens the comment for edit/delete.
 *   - "Send N to chat" pushes a markdown summary of the comments into
 *     the chat input so the user can fire it as a follow-up turn.
 *
 * Communication with the iframe goes through the `mockup-inspector`
 * postMessage protocol — the iframe is sandboxed without `allow-same-origin`
 * so the parent can't reach into its DOM directly.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, TextField, TextArea } from '@heroui/react';
import { wrapMockupHtml, type MockupComment, type MockupInboundMsg } from '../lib/mockup-inspector';

type Popup = {
  commentId?: string;       // present when editing an existing comment
  selector: string;
  summary: string;
  x: number;                // iframe-relative coords, in CSS px
  y: number;
  text: string;
  // Set when the popup was opened by the inspector picking a fresh element
  // (not by clicking an existing dot). On Save we flip inspect back on so
  // the user can immediately pick the next element; Cancel leaves it off
  // so a stray click doesn't grab a random thing.
  restoreInspect?: boolean;
};

export type MockupPanelProps = {
  name: string;
  html: string;
  inspect: boolean;
  comments: MockupComment[];
  onSetInspect: (next: boolean) => void;
  onSetComments: (next: MockupComment[]) => void;
  /** Fire the comments as a chat message right now. Parent is responsible
   *  for clearing the comment list after this returns. */
  onSendToChat: (markdown: string) => void;
  /** Drop the comments into the chat input field without sending. Parent
   *  leaves the comment list intact so the user can keep iterating. */
  onWriteToChat: (markdown: string) => void;
  onClose: () => void;
  onToggleFullWidth: () => void;
};

function genId(): string {
  return 'c_' + Math.random().toString(36).slice(2, 10);
}

function buildChatMessage(name: string, comments: MockupComment[]): string {
  if (!comments.length) return '';
  const lines = [`Mockup feedback — \`${name}\`:`, ''];
  comments.forEach((c, i) => {
    lines.push(`${i + 1}. \`${c.summary}\``);
    lines.push(`   ${c.text.split('\n').join('\n   ')}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

export function MockupPanel({
  name, html, inspect, comments,
  onSetInspect, onSetComments, onSendToChat, onWriteToChat, onClose, onToggleFullWidth,
}: MockupPanelProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [iframeReady, setIframeReady] = useState(0);  // bumped on every `mockup_ready` msg

  const wrappedHtml = useMemo(() => wrapMockupHtml(html), [html]);

  // Push the inspector flag and current comment list down whenever they
  // change *and* the iframe has signalled ready. Using `iframeReady` as a
  // dep means an html re-render (mockup_edit) re-pushes after the new doc
  // boots.
  useEffect(() => {
    const w = iframeRef.current?.contentWindow;
    if (!w) return;
    w.postMessage({ __codiby_mockup_cmd: true, type: 'set_inspector', enabled: inspect }, '*');
  }, [inspect, iframeReady]);

  useEffect(() => {
    const w = iframeRef.current?.contentWindow;
    if (!w) return;
    w.postMessage({
      __codiby_mockup_cmd: true,
      type: 'set_comments',
      comments: comments.map(c => ({ id: c.id, selector: c.selector })),
    }, '*');
  }, [comments, iframeReady]);

  // Listen for messages coming back from the iframe (pick / dot click /
  // ready ping). Filter strictly by source so we don't react to messages
  // from other iframes (e.g. the file editor's Monaco worker).
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const msg = e.data as (MockupInboundMsg & { __codiby_mockup?: boolean }) | undefined;
      if (!msg || (msg as any).__codiby_mockup !== true) return;
      if (msg.type === 'mockup_ready') {
        setIframeReady(n => n + 1);
        return;
      }
      if (msg.type === 'mockup_pick') {
        // Auto-disable inspect mode while the popup is up — otherwise a
        // mis-aimed click outside the popup would grab a different element
        // and clobber the in-progress comment. We re-arm it on Save.
        const wasInspecting = inspect;
        if (wasInspecting) onSetInspect(false);
        setPopup({
          selector: msg.selector,
          summary: msg.summary,
          x: msg.x,
          y: msg.y,
          text: '',
          restoreInspect: wasInspecting,
        });
        return;
      }
      if (msg.type === 'mockup_dot') {
        const c = comments.find(x => x.id === msg.commentId);
        if (!c) return;
        setPopup({
          commentId: c.id,
          selector: c.selector,
          summary: c.summary,
          x: msg.x,
          y: msg.y,
          text: c.text,
        });
        return;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [comments, inspect, onSetInspect]);

  const closePopup = useCallback(() => setPopup(null), []);

  const savePopup = useCallback(() => {
    if (!popup) return;
    const text = popup.text.trim();
    const restore = !!popup.restoreInspect;
    if (!text) { closePopup(); return; }
    if (popup.commentId) {
      onSetComments(comments.map(c => c.id === popup.commentId ? { ...c, text } : c));
    } else {
      const next: MockupComment = {
        id: genId(),
        selector: popup.selector,
        summary: popup.summary,
        text,
      };
      onSetComments([...comments, next]);
    }
    closePopup();
    // Re-arm inspect mode after a successful save if we were the ones who
    // turned it off (i.e. the popup came from a fresh element pick). Skip
    // for Cancel / Delete / empty-text — those cases the user is bailing
    // out, so leaving inspect off avoids accidental picks.
    if (restore) onSetInspect(true);
  }, [popup, comments, onSetComments, closePopup, onSetInspect]);

  const deletePopup = useCallback(() => {
    if (!popup?.commentId) { closePopup(); return; }
    onSetComments(comments.filter(c => c.id !== popup.commentId));
    closePopup();
  }, [popup, comments, onSetComments, closePopup]);

  // Translate iframe-local coords to wrapper-local for popup placement.
  // Account for the header bar so the popup sits inside the iframe area.
  const popupStyle = useMemo(() => {
    if (!popup) return null;
    // Clamp so the popup doesn't escape the iframe horizontally/vertically.
    const iframeEl = iframeRef.current;
    const wrapEl = wrapperRef.current;
    if (!iframeEl || !wrapEl) return { left: popup.x, top: popup.y };
    const ir = iframeEl.getBoundingClientRect();
    const wr = wrapEl.getBoundingClientRect();
    const leftRaw = (ir.left - wr.left) + popup.x - 140;     // popup width ~280
    const topRaw  = (ir.top  - wr.top)  + popup.y + 8;
    const maxLeft = (ir.left - wr.left) + ir.width  - 290;
    const maxTop  = (ir.top  - wr.top)  + ir.height - 180;
    return {
      left: Math.max(8, Math.min(leftRaw, maxLeft)),
      top:  Math.max(8, Math.min(topRaw,  maxTop)),
    };
  }, [popup]);

  return (
    <div ref={wrapperRef} className="flex-1 flex flex-col min-w-0 relative">
      <div
        className="flex items-center justify-between px-3 py-1 border-b border-border shrink-0 bg-surface"
        onDoubleClick={onToggleFullWidth}
      >
        <div className="flex items-center gap-1.5 truncate cursor-default">
          <span className="text-[10px] text-violet-400 shrink-0">▣</span>
          <span className="text-[12px] font-mono text-violet-300 truncate">mockup · {name}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            className={`text-[11px] px-2 py-0.5 h-auto rounded transition-colors ${
              inspect
                ? 'bg-violet-500/20 text-violet-200 hover:bg-violet-500/30'
                : 'text-zinc-500 hover:text-violet-300'
            }`}
            onPress={() => onSetInspect(!inspect)}
            aria-label={inspect ? 'Exit inspect mode (Esc)' : 'Pick elements to comment on'}
          >
            {inspect ? '◉ Inspecting' : '◉ Inspect'}
          </Button>
          {comments.length > 0 && (
            <SendCommentsButton
              count={comments.length}
              onSend={() => {
                const md = buildChatMessage(name, comments);
                if (md) onSendToChat(md);
              }}
              onWrite={() => {
                const md = buildChatMessage(name, comments);
                if (md) onWriteToChat(md);
              }}
            />
          )}
          <Button isIconOnly size="sm" variant="ghost" className="text-zinc-500 hover:text-zinc-200 text-sm px-1 h-auto min-w-0" onPress={onClose} aria-label="Close mockup">
            <span>×</span>
          </Button>
        </div>
      </div>
      <div className="flex-1 relative min-h-0">
        <iframe
          ref={iframeRef}
          key={name}
          title={`mockup-${name}`}
          srcDoc={wrappedHtml}
          sandbox="allow-scripts allow-forms allow-popups"
          className="absolute inset-0 w-full h-full bg-white border-0"
          onLoad={() => { /* `mockup_ready` postMessage drives readiness */ }}
        />
        {popup && popupStyle && (
          <div
            className="absolute z-10 w-[280px] bg-[#1f1f1f] border border-violet-500/40 rounded-lg shadow-2xl text-zinc-200"
            style={popupStyle}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-border-light">
              <span className="text-[10px] text-violet-400 shrink-0">▣</span>
              <span className="text-[11px] font-mono text-zinc-400 truncate" title={popup.selector}>
                {popup.summary}
              </span>
            </div>
            <TextField
              value={popup.text}
              onChange={(v) => setPopup(p => p ? { ...p, text: v } : p)}
              aria-label="Element comment"
            >
              <TextArea
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { e.preventDefault(); closePopup(); }
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); savePopup(); }
                }}
                placeholder="Comment on this element… (Cmd+Enter to save, Esc to cancel)"
                className="block w-full bg-transparent px-2.5 py-2 text-[12px] resize-none border-0 placeholder:text-zinc-600"
                rows={4}
              />
            </TextField>
            <div className="flex items-center justify-end gap-1 px-2 py-1.5 border-t border-border-light">
              {popup.commentId && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-[11px] text-red-400 hover:text-red-300 px-2 py-0.5 h-auto"
                  onPress={deletePopup}
                >
                  Delete
                </Button>
              )}
              <span className="flex-1" />
              <Button
                size="sm"
                variant="ghost"
                className="text-[11px] text-zinc-500 hover:text-zinc-300 px-2 py-0.5 h-auto"
                onPress={closePopup}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="text-[11px] text-white bg-violet-600 hover:bg-violet-500 rounded px-2 py-0.5 h-auto"
                onPress={savePopup}
              >
                Save
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Split button: primary action sends + clears, the caret reveals a single
 * "Write to chat only" alternative that drops the markdown into the input
 * without firing it.
 */
function SendCommentsButton({
  count, onSend, onWrite,
}: {
  count: number;
  onSend: () => void;
  onWrite: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Close the dropdown on any click outside the wrapper. Capture phase so
  // we win even when the iframe / messages list also handle clicks.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick, true);
    return () => document.removeEventListener('mousedown', onDocClick, true);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex items-stretch">
      <Button
        size="sm"
        variant="ghost"
        className="text-[11px] pl-2 pr-1.5 py-0.5 h-auto rounded-l text-violet-300 hover:bg-violet-500/20 transition-colors border border-r-0 border-transparent hover:border-violet-500/30"
        onPress={onSend}
        aria-label="Send these comments to chat now and clear the dots"
      >
        Send {count} to chat
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-[11px] px-1 py-0.5 h-auto rounded-r text-violet-300 hover:bg-violet-500/20 transition-colors border border-l-0 border-transparent hover:border-violet-500/30"
        onPress={() => setOpen(o => !o)}
        aria-label="More options"
        aria-expanded={open}
      >
        ▾
      </Button>
      {open && (
        <div className="absolute top-full right-0 mt-1 z-20 min-w-[180px] bg-[#1f1f1f] border border-border-light rounded-md shadow-xl overflow-hidden">
          <Button
            variant="ghost"
            fullWidth
            className="block text-left justify-start text-[11px] px-3 py-1.5 h-auto rounded-none text-zinc-300 hover:bg-surface-light transition-colors"
            onPress={() => { setOpen(false); onWrite(); }}
            aria-label="Insert the comments into the chat input without sending"
          >
            Write to chat only
          </Button>
        </div>
      )}
    </div>
  );
}
