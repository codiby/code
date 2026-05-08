/**
 * Right-side panel that surfaces an `ExitPlanMode` plan as a block-based,
 * read-only document. Each markdown "block" (paragraph, heading, list, code
 * fence) becomes a discrete hover target. Hovering reveals a "+" gutter button
 * that opens a comment popup pinned to that block; saved comments leave a
 * numbered violet badge inline. The header offers "Send N to chat" so the
 * collected feedback can be fired back at the assistant in a single turn —
 * mirroring `MockupPanel`'s send/write split.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Send as SendIcon } from 'lucide-react';
import { Button, TextField, TextArea } from '@heroui/react';
import { Markdown } from './Markdown';

export type PlanComment = {
  id: string;
  blockIndex: number;
  blockPreview: string;
  text: string;
};

export type PlanPanelProps = {
  content: string;
  comments: PlanComment[];
  allowedPrompts?: { tool: string; prompt: string }[];
  onSetComments: (next: PlanComment[]) => void;
  onSendToChat: (markdown: string) => void;
  onWriteToChat: (markdown: string) => void;
  onClose: () => void;
  onToggleFullWidth: () => void;
};

type Popup = {
  commentId?: string;
  blockIndex: number;
  blockPreview: string;
  text: string;
};

function genId(): string {
  return 'p_' + Math.random().toString(36).slice(2, 10);
}

const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+/;

function isListItemLine(line: string): boolean {
  return LIST_ITEM_RE.test(line);
}

// Split markdown into top-level blocks, treating fenced code regions as a
// single block so we don't shred ``` fences into orphaned halves. Each list
// item (numbered or bulleted) is also its own block so the user can comment
// on a single item without dragging the whole list along.
function splitBlocks(source: string): string[] {
  const lines = source.split('\n');
  const blocks: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  let inListItem = false;

  const flush = () => {
    while (buf.length && buf[0].trim() === '') buf.shift();
    while (buf.length && buf[buf.length - 1].trim() === '') buf.pop();
    if (buf.length) blocks.push(buf.join('\n'));
    buf = [];
    inListItem = false;
  };

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      flush();
      buf.push(line);
      inFence = !inFence;
      if (!inFence) flush();
      continue;
    }
    if (inFence) {
      buf.push(line);
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (isListItemLine(line)) {
      // New list item starts a fresh block, even if the previous line was
      // also a list item (no blank line between them).
      flush();
      buf.push(line);
      inListItem = true;
      continue;
    }
    if (inListItem && /^\s+\S/.test(line)) {
      // Indented continuation line for the current list item — keep it
      // attached.
      buf.push(line);
      continue;
    }
    // Non-list line ends any open list item.
    if (inListItem) flush();
    buf.push(line);
  }
  flush();
  return blocks;
}

function previewOf(block: string): string {
  const stripped = block
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>~-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 60 ? stripped.slice(0, 57) + '…' : stripped;
}

function buildChatMessage(comments: PlanComment[], blocks: string[]): string {
  if (!comments.length) return '';
  const lines = ['Plan feedback:', ''];
  comments.forEach((c, i) => {
    const block = blocks[c.blockIndex] ?? c.blockPreview;
    lines.push(`${i + 1}. On _"${c.blockPreview}"_:`);
    lines.push(`   ${c.text.split('\n').join('\n   ')}`);
    lines.push('');
    lines.push('   > ' + block.split('\n').join('\n   > '));
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

export function PlanPanel({
  content, comments, allowedPrompts,
  onSetComments, onSendToChat, onWriteToChat, onClose, onToggleFullWidth,
}: PlanPanelProps) {
  const [popup, setPopup] = useState<Popup | null>(null);
  const blockRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const blocks = useMemo(() => splitBlocks(content), [content]);

  // Flash blocks whose text is new or modified relative to the previous plan
  // version. Equality is by exact block text — a reworded paragraph counts
  // as "new" because the new string is not in the prior set. First mount
  // seeds the prior set without flashing, otherwise the entire document
  // would light up the moment the panel opens.
  const prevBlockSetRef = useRef<Set<string>>(new Set());
  const [recentlyChanged, setRecentlyChanged] = useState<Set<string>>(new Set());
  useEffect(() => {
    const prev = prevBlockSetRef.current;
    const isFirstMount = prev.size === 0;
    const newSet = new Set(blocks);
    prevBlockSetRef.current = newSet;
    if (isFirstMount) return;
    const changed = blocks.filter(b => !prev.has(b));
    if (changed.length === 0) return;
    setRecentlyChanged(prevSet => {
      const next = new Set(prevSet);
      for (const b of changed) next.add(b);
      return next;
    });
    const t = setTimeout(() => {
      setRecentlyChanged(prevSet => {
        const next = new Set(prevSet);
        for (const b of changed) next.delete(b);
        return next;
      });
    }, 2500);
    return () => clearTimeout(t);
  }, [blocks]);

  const commentsByBlock = useMemo(() => {
    const m: Record<number, PlanComment[]> = {};
    for (const c of comments) {
      (m[c.blockIndex] = m[c.blockIndex] || []).push(c);
    }
    return m;
  }, [comments]);

  const openNewComment = useCallback((blockIndex: number) => {
    setPopup({
      blockIndex,
      blockPreview: previewOf(blocks[blockIndex] || ''),
      text: '',
    });
  }, [blocks]);

  const openExistingComment = useCallback((c: PlanComment) => {
    setPopup({
      commentId: c.id,
      blockIndex: c.blockIndex,
      blockPreview: c.blockPreview,
      text: c.text,
    });
  }, []);

  const closePopup = useCallback(() => setPopup(null), []);

  const savePopup = useCallback(() => {
    if (!popup) return;
    const text = popup.text.trim();
    if (!text) { closePopup(); return; }
    if (popup.commentId) {
      onSetComments(comments.map(c => c.id === popup.commentId ? { ...c, text } : c));
    } else {
      onSetComments([...comments, {
        id: genId(),
        blockIndex: popup.blockIndex,
        blockPreview: popup.blockPreview,
        text,
      }]);
    }
    closePopup();
  }, [popup, comments, onSetComments, closePopup]);

  const deletePopup = useCallback(() => {
    if (!popup?.commentId) { closePopup(); return; }
    onSetComments(comments.filter(c => c.id !== popup.commentId));
    closePopup();
  }, [popup, comments, onSetComments, closePopup]);

  return (
    <div className="flex-1 flex flex-col min-w-0 relative bg-surface">
      <div
        className="flex items-center justify-between px-3 py-1 border-b border-border shrink-0 bg-surface-light"
        onDoubleClick={onToggleFullWidth}
      >
        <div className="flex items-center gap-1.5 truncate cursor-default">
          <span className="text-[10px] text-violet-400 shrink-0">◆</span>
          <span className="text-[12px] font-mono text-violet-300 truncate">plan</span>
        </div>
        <Button isIconOnly size="sm" variant="ghost" onPress={onClose} aria-label="Close plan" className="text-zinc-500 hover:text-zinc-200 text-sm px-1 h-auto min-w-0 shrink-0">
          <span>×</span>
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 pt-6 pb-24">
          {blocks.length === 0 ? (
            <p className="text-[12px] text-zinc-500">No plan content</p>
          ) : (
            blocks.map((block, i) => {
              const blockComments = commentsByBlock[i] || [];
              const isListItem = isListItemLine(block);
              const isChanged = recentlyChanged.has(block);
              return (
                <div
                  key={i}
                  ref={el => { blockRefs.current[i] = el; }}
                  className={`group relative -mx-3 px-3 rounded transition-colors hover:bg-surface-light/60 ${isListItem ? 'py-0.5' : 'pt-2 pb-1'} ${isChanged ? 'plan-block-highlight' : ''}`}
                >
                  <div className="absolute right-1 top-1 z-10 flex items-center gap-0.5 px-0.5 py-0.5 rounded bg-[#1f1f1f]/95 border border-border-light shadow-md opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 h-auto rounded text-[11px] text-zinc-400 hover:text-violet-200 hover:bg-violet-500/15 transition-colors"
                      onPress={() => openNewComment(i)}
                      aria-label="Comment on this block"
                    >
                      <span className="text-[12px] leading-none">+</span>
                      <span>Comment</span>
                    </Button>
                  </div>
                  {blockComments.length > 0 && (
                    <div className="mb-1 flex flex-wrap gap-1">
                      {blockComments.map(c => (
                        <Button
                          key={c.id}
                          size="sm"
                          variant="ghost"
                          onPress={() => openExistingComment(c)}
                          className="inline-flex items-center gap-1 max-w-full px-1.5 py-0.5 h-auto rounded bg-violet-500/15 border border-violet-500/30 text-violet-200 text-[11px] hover:bg-violet-500/25 transition-colors"
                          aria-label="Edit comment"
                        >
                          <span className="w-3.5 h-3.5 rounded-full bg-violet-500/40 text-[9px] flex items-center justify-center shrink-0">
                            {comments.findIndex(x => x.id === c.id) + 1}
                          </span>
                          <span className="truncate">{c.text}</span>
                        </Button>
                      ))}
                    </div>
                  )}
                  <Markdown text={block} />
                </div>
              );
            })
          )}

          {allowedPrompts && allowedPrompts.length > 0 && (
            <div className="mt-6 pt-3 border-t border-border">
              <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">Allowed actions</p>
              <div className="flex flex-wrap gap-1">
                {allowedPrompts.map((p, i) => (
                  <span key={i} className="text-[11px] bg-surface-light text-zinc-400 px-2 py-0.5 rounded">{p.prompt}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {comments.length > 0 && (
        <div className="absolute bottom-4 right-4 z-20 flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="text-[11px] px-3 py-1.5 h-auto rounded-full bg-[#1f1f1f]/85 border border-border-light backdrop-blur text-zinc-400 hover:text-violet-200 hover:bg-violet-500/15 transition-colors"
            onPress={() => {
              const md = buildChatMessage(comments, blocks);
              if (md) onWriteToChat(md);
            }}
            aria-label="Insert the comments into the chat input without sending"
          >
            Write to input
          </Button>
          <Button
            isIconOnly
            className="relative w-[52px] h-[52px] min-w-0 p-0 rounded-full bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-500/40 inline-flex items-center justify-center transition-transform hover:scale-[1.04]"
            onPress={() => {
              const md = buildChatMessage(comments, blocks);
              if (md) onSendToChat(md);
            }}
            aria-label={`Send ${comments.length} to chat`}
          >
            <SendIcon className="w-[22px] h-[22px]" />
            <span
              className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold border-[1.5px] border-surface inline-flex items-center justify-center leading-none"
              aria-hidden
            >
              {comments.length > 99 ? '99+' : comments.length}
            </span>
          </Button>
        </div>
      )}

      {popup && (
        <div
          className="absolute z-30 right-6 top-12 w-[320px] bg-[#1f1f1f] border border-violet-500/40 rounded-lg shadow-2xl text-zinc-200"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-border-light">
            <span className="text-[10px] text-violet-400 shrink-0">◆</span>
            <span className="text-[11px] font-mono text-zinc-400 truncate" title={popup.blockPreview}>
              {popup.blockPreview}
            </span>
          </div>
          <TextField
            value={popup.text}
            onChange={(v) => setPopup(p => p ? { ...p, text: v } : p)}
            aria-label="Block comment"
          >
            <TextArea
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); closePopup(); }
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); savePopup(); }
              }}
              placeholder="Comment on this block… (Cmd+Enter to save, Esc to cancel)"
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
  );
}

