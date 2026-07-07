import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X as XIcon } from 'lucide-react';
import { Button, TextField, TextArea } from '@heroui/react';
import { wrapMockupHtml, type MockupComment, type MockupInboundMsg } from '../../lib/mockup-inspector';

type Popup = {
  commentId?: string;
  selector: string;
  summary: string;
  text: string;
  // Set when the popup was opened by the inspector picking a fresh element
  // (not by clicking an existing dot). On Save we flip inspect back on so
  // the user can immediately pick the next element; Cancel leaves it off
  // so a stray click doesn't grab a random thing.
  restoreInspect?: boolean;
};

interface Props {
  open: boolean;
  name: string;
  html: string;
  comments: MockupComment[];
  onSetComments: (next: MockupComment[]) => void;
  /** Fire the comments as a chat message right now. Caller clears comments. */
  onSendToChat: (markdown: string) => void;
  /** Drop the comments into the chat input field without sending. */
  onWriteToChat: (markdown: string) => void;
  /** Minimize the modal — the parent keeps the mockup in its pill list. */
  onClose: () => void;
}

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

/**
 * Full-screen mobile preview for HTML mockups produced by the
 * `mockup_write` / `mockup_edit` SDK tools. Same iframe + inspector protocol
 * as the desktop MockupPanel — only the chrome is rebuilt for touch (full
 * inset-0 sheet, bottom-anchored comment editor instead of a floating popup).
 *
 * Closing the modal does not destroy state: the parent keeps the mockup in
 * its per-session list so it stays accessible from the dock pill row above
 * the chat composer.
 */
export function MobileMockupModal({
  open,
  name,
  html,
  comments,
  onSetComments,
  onSendToChat,
  onWriteToChat,
  onClose,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [inspect, setInspect] = useState(false);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [iframeReady, setIframeReady] = useState(0);

  // Skip the wrap+inject pass while the modal is closed so the iframe
  // doesn't keep the inspector script live in memory.
  const wrappedHtml = useMemo(() => (open ? wrapMockupHtml(html) : ''), [html, open]);

  // Reset transient state on close so the next open starts with inspector
  // off and no orphaned comment editor.
  useEffect(() => {
    if (!open) {
      setInspect(false);
      setPopup(null);
    }
  }, [open]);

  // Push the inspector flag and current comment list down whenever they
  // change *and* the iframe has signalled ready. Using `iframeReady` as a
  // dep means an html re-render (mockup_edit) re-pushes after the new doc
  // boots.
  useEffect(() => {
    if (!open) return;
    const w = iframeRef.current?.contentWindow;
    if (!w) return;
    w.postMessage({ __codiby_mockup_cmd: true, type: 'set_inspector', enabled: inspect }, '*');
  }, [inspect, iframeReady, open]);

  useEffect(() => {
    if (!open) return;
    const w = iframeRef.current?.contentWindow;
    if (!w) return;
    w.postMessage({
      __codiby_mockup_cmd: true,
      type: 'set_comments',
      comments: comments.map(c => ({ id: c.id, selector: c.selector })),
    }, '*');
  }, [comments, iframeReady, open]);

  // Listen for messages from the iframe (pick / dot click / ready ping).
  // Filter strictly by source so we don't react to messages from other
  // iframes (e.g. file editor's Monaco worker).
  useEffect(() => {
    if (!open) return;
    const handler = (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const msg = e.data as (MockupInboundMsg & { __codiby_mockup?: boolean }) | undefined;
      if (!msg || (msg as { __codiby_mockup?: boolean }).__codiby_mockup !== true) return;
      if (msg.type === 'mockup_ready') {
        setIframeReady(n => n + 1);
        return;
      }
      if (msg.type === 'mockup_pick') {
        // Auto-disable inspect mode while the editor is up so a mis-aimed
        // tap outside the popup doesn't grab a different element. Re-armed
        // on Save.
        const wasInspecting = inspect;
        if (wasInspecting) setInspect(false);
        setPopup({
          selector: msg.selector,
          summary: msg.summary,
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
          text: c.text,
        });
        return;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [comments, inspect, open]);

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
    if (restore) setInspect(true);
  }, [popup, comments, onSetComments, closePopup]);

  const deletePopup = useCallback(() => {
    if (!popup?.commentId) { closePopup(); return; }
    onSetComments(comments.filter(c => c.id !== popup.commentId));
    closePopup();
  }, [popup, comments, onSetComments, closePopup]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] bg-zinc-950 flex flex-col"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="flex items-center px-2 py-2 border-b border-border shrink-0 gap-2">
        <Button
          variant="ghost"
          isIconOnly
          size="sm"
          onPress={onClose}
          className="w-9 h-9 flex items-center justify-center rounded-full text-zinc-400 active:text-zinc-100 active:bg-white/10 min-w-0"
          aria-label="Close mockup"
        >
          <XIcon size={18} />
        </Button>
        <div className="flex-1 flex items-center justify-center gap-1.5 min-w-0 px-1">
          <span className="text-[10px] text-violet-400 shrink-0">▣</span>
          <span className="text-[12px] font-mono text-violet-300 truncate">{name}</span>
        </div>
        <Button
          variant="ghost"
          onPress={() => setInspect(v => !v)}
          className={`shrink-0 h-7 px-2.5 flex items-center rounded-full text-[11px] font-medium transition-colors min-w-0 ${
            inspect
              ? 'bg-violet-500/20 text-violet-200 border border-violet-500/40'
              : 'bg-zinc-900/70 text-zinc-300 border border-white/10 active:bg-zinc-900/90'
          }`}
          aria-pressed={inspect}
          aria-label={inspect ? 'Exit inspect mode' : 'Pick elements to comment on'}
        >
          {inspect ? '◉ Inspecting' : '◉ Inspect'}
        </Button>
      </div>

      <div className="flex-1 relative min-h-0 bg-white">
        <iframe
          ref={iframeRef}
          key={name}
          title={`mockup-${name}`}
          srcDoc={wrappedHtml}
          sandbox="allow-scripts allow-forms allow-popups"
          className="absolute inset-0 w-full h-full bg-white border-0"
        />
      </div>

      {comments.length > 0 && !popup && (
        <div
          className="flex items-center gap-2 px-3 py-2 border-t border-border bg-zinc-950 shrink-0"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.5rem)' }}
        >
          <span className="text-[12px] text-violet-300 font-medium">
            {comments.length} comment{comments.length !== 1 ? 's' : ''}
          </span>
          <span className="flex-1" />
          <Button
            variant="ghost"
            onPress={() => {
              const md = buildChatMessage(name, comments);
              if (md) onWriteToChat(md);
            }}
            className="text-[12px] text-zinc-400 active:text-zinc-200 px-2 py-1.5 h-auto min-w-0"
          >
            Write only
          </Button>
          <Button
            variant="primary"
            onPress={() => {
              const md = buildChatMessage(name, comments);
              if (md) onSendToChat(md);
            }}
            className="text-[12px] font-semibold text-white bg-violet-600 active:bg-violet-500 rounded-full px-3 py-1.5 h-auto min-w-0"
          >
            Send {comments.length} to chat
          </Button>
        </div>
      )}

      {popup && (
        <div
          className="absolute inset-x-0 bottom-0 z-10 bg-[#1f1f1f] border-t border-violet-500/40 rounded-t-2xl shadow-2xl text-zinc-200"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border-light">
            <span className="text-[10px] text-violet-400 shrink-0">▣</span>
            <span className="text-[11px] font-mono text-zinc-400 truncate flex-1" title={popup.selector}>
              {popup.summary}
            </span>
            <Button
              variant="ghost"
              isIconOnly
              size="sm"
              onPress={closePopup}
              className="w-6 h-6 flex items-center justify-center rounded-full text-zinc-500 active:text-zinc-200 min-w-0"
              aria-label="Close"
            >
              <XIcon size={14} />
            </Button>
          </div>
          <TextField
            value={popup.text}
            onChange={(v) => setPopup(p => p ? { ...p, text: v } : p)}
            aria-label="Comment text"
          >
            <TextArea
              autoFocus
              placeholder="Comment on this element…"
              className="block w-full bg-transparent px-3 py-2 text-[14px] resize-none focus:outline-none placeholder:text-zinc-600"
              rows={4}
            />
          </TextField>
          <div className="flex items-center justify-end gap-1 px-2 py-2 border-t border-border-light">
            {popup.commentId && (
              <Button
                variant="ghost"
                className="text-[12px] text-red-400 active:text-red-300 px-2 py-1.5 h-auto min-w-0"
                onPress={deletePopup}
              >
                Delete
              </Button>
            )}
            <span className="flex-1" />
            <Button
              variant="ghost"
              className="text-[12px] text-zinc-400 active:text-zinc-200 px-2 py-1.5 h-auto min-w-0"
              onPress={closePopup}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              className="text-[12px] font-semibold text-white bg-violet-600 active:bg-violet-500 rounded-full px-3 py-1.5 h-auto min-w-0"
              onPress={savePopup}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
