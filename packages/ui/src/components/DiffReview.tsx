import { useState, useRef, useEffect, useCallback } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { Button, TextField, TextArea } from '@heroui/react';
import { isDotenvPath } from '../lib/monaco-dotenv';
import { MONO_FONT_STACK } from '../lib/fonts';

export interface ReviewComment {
  id: string;
  startLine: number;
  endLine: number;
  side: 'original' | 'modified';
  text: string;
  timestamp: number;
}

interface Props {
  original: string;
  modified: string;
  filePath: string;
  comments: ReviewComment[];
  onAddComment: (comment: ReviewComment) => void;
  onDeleteComment: (id: string) => void;
}

export function DiffReview({ original, modified, filePath, comments, onAddComment, onDeleteComment }: Props) {
  const diffEditorRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null);
  const [commentInput, setCommentInput] = useState<{ startLine: number; endLine: number; side: 'original' | 'modified'; top: number } | null>(null);
  const [commentText, setCommentText] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const commentsListRef = useRef<HTMLDivElement>(null);
  const gutterDragRef = useRef<{ side: 'original' | 'modified'; startLine: number } | null>(null);
  const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null);

  const getTopForLine = useCallback((ed: MonacoEditor.ICodeEditor, line: number) => {
    const topPx = ed.getTopForLineNumber(line) - ed.getScrollTop();
    const editorDom = ed.getDomNode();
    if (!editorDom || !containerRef.current) return 0;
    const editorRect = editorDom.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();
    return editorRect.top - containerRect.top + topPx + 20;
  }, []);

  const handleMount = useCallback((editor: MonacoEditor.IStandaloneDiffEditor) => {
    diffEditorRef.current = editor;

    const modifiedEditor = editor.getModifiedEditor();
    const originalEditor = editor.getOriginalEditor();

    // type 2=GUTTER_GLYPH_MARGIN, 3=GUTTER_LINE_NUMBERS, 4=GUTTER_LINE_DECORATIONS
    const isGutter = (type: number) => type === 2 || type === 3 || type === 4;

    const addGutterHandler = (ed: MonacoEditor.ICodeEditor, side: 'original' | 'modified') => {
      ed.onMouseDown((e) => {
        if (!isGutter(e.target.type)) return;
        const line = e.target.position?.lineNumber;
        if (!line) return;
        const shiftKey = (e.event as any).browserEvent?.shiftKey ?? e.event.shiftKey;

        // Check if clicking on a line that has an existing comment
        const existing = comments.find(c => c.side === side && line >= c.startLine && line <= c.endLine);
        if (existing && !shiftKey) {
          // Scroll to and highlight the existing comment
          setFocusedCommentId(existing.id);
          setCommentInput(null);
          setTimeout(() => {
            const el = document.getElementById(`review-comment-${existing.id}`);
            el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }, 50);
          return;
        }

        if (shiftKey && gutterDragRef.current && gutterDragRef.current.side === side) {
          // Shift+click: extend range
          const start = Math.min(gutterDragRef.current.startLine, line);
          const end = Math.max(gutterDragRef.current.startLine, line);
          const top = getTopForLine(ed, end);
          setCommentInput({ startLine: start, endLine: end, side, top });
          setCommentText('');
          setTimeout(() => inputRef.current?.focus(), 50);
        } else {
          // Normal click: start new / reset
          setFocusedCommentId(null);
          gutterDragRef.current = { side, startLine: line };
          const top = getTopForLine(ed, line);
          setCommentInput({ startLine: line, endLine: line, side, top });
          setCommentText('');
        }
      });
    };

    addGutterHandler(originalEditor, 'original');
    addGutterHandler(modifiedEditor, 'modified');

    // Cmd+Option+C: open comment for selection/cursor line
    const addCommentAction = (ed: MonacoEditor.ICodeEditor, side: 'original' | 'modified') => {
      ed.addAction({
        id: 'add-review-comment',
        label: 'Add Review Comment',
        keybindings: [
          (window as any).monaco?.KeyMod.CtrlCmd | (window as any).monaco?.KeyMod.Alt | (window as any).monaco?.KeyCode.KeyC,
        ].filter(Boolean),
        run: (runner) => {
          const sel = runner.getSelection();
          if (!sel) return;
          const startLine = sel.startLineNumber;
          let endLine = sel.isEmpty() ? startLine : sel.endLineNumber;
          // When selection ends at column 1 of next line (e.g. double-click), adjust back
          if (!sel.isEmpty() && sel.endColumn === 1 && endLine > startLine) {
            endLine--;
          }
          gutterDragRef.current = { side, startLine };
          const top = getTopForLine(ed, endLine);
          setCommentInput({ startLine, endLine, side, top });
          setCommentText('');
          setTimeout(() => inputRef.current?.focus(), 50);
        },
      });
    };

    addCommentAction(originalEditor, 'original');
    addCommentAction(modifiedEditor, 'modified');
  }, [getTopForLine]);

  // Render comment + selection decorations
  useEffect(() => {
    const editor = diffEditorRef.current;
    if (!editor) return;

    const modifiedEditor = editor.getModifiedEditor();
    const originalEditor = editor.getOriginalEditor();

    const addDecorations = (ed: MonacoEditor.ICodeEditor, side: 'original' | 'modified') => {
      const decorations: MonacoEditor.IModelDeltaDecoration[] = [];

      // Existing comments: green glyph on start line, highlight on full range
      for (const c of comments.filter(c => c.side === side)) {
        decorations.push({
          range: { startLineNumber: c.startLine, startColumn: 1, endLineNumber: c.startLine, endColumn: 1 },
          options: { isWholeLine: false, glyphMarginClassName: 'comment-glyph' },
        });
        decorations.push({
          range: { startLineNumber: c.startLine, startColumn: 1, endLineNumber: c.endLine, endColumn: 1 },
          options: { isWholeLine: true, className: 'comment-line-highlight' },
        });
      }

      // Active selection: blue
      if (commentInput && commentInput.side === side) {
        decorations.push({
          range: { startLineNumber: commentInput.startLine, startColumn: 1, endLineNumber: commentInput.endLine, endColumn: 1 },
          options: { isWholeLine: true, className: 'comment-selection-highlight' },
        });
      }

      (ed as any).__commentDecorations = ed.deltaDecorations(
        (ed as any).__commentDecorations || [],
        decorations,
      );
    };

    addDecorations(originalEditor, 'original');
    addDecorations(modifiedEditor, 'modified');
  }, [comments, commentInput]);

  const submitComment = () => {
    if (!commentInput || !commentText.trim()) return;
    onAddComment({
      id: crypto.randomUUID(),
      startLine: commentInput.startLine,
      endLine: commentInput.endLine,
      side: commentInput.side,
      text: commentText.trim(),
      timestamp: Date.now(),
    });
    setCommentInput(null);
    setCommentText('');
  };

  // Group comments by endLine and side for positioning
  const commentsByPosition = comments.reduce<Record<string, ReviewComment[]>>((acc, c) => {
    const key = `${c.side}:${c.endLine}`;
    (acc[key] ||= []).push(c);
    return acc;
  }, {});

  const langFromPath = (p: string) => {
    if (isDotenvPath(p)) return 'dotenv';
    const ext = p.split('.').pop()?.toLowerCase();
    const map: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      json: 'json', md: 'markdown', css: 'css', scss: 'scss', less: 'less',
      html: 'html', xml: 'xml', yaml: 'yaml', yml: 'yaml', py: 'python',
      rs: 'rust', go: 'go', java: 'java', rb: 'ruby', sh: 'shell', bash: 'shell',
      sql: 'sql', graphql: 'graphql', svg: 'xml', vue: 'html', toml: 'ini',
    };
    return map[ext || ''] || 'plaintext';
  };

  return (
    <div ref={containerRef} className="flex-1 flex flex-col relative">
      <div className="flex-1 relative">
        <DiffEditor
          original={original}
          modified={modified}
          language={langFromPath(filePath)}
          theme="vs-dark"
          onMount={handleMount}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            fontFamily: MONO_FONT_STACK,
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            renderSideBySide: true,
            glyphMargin: true,
            padding: { top: 8 },
          }}
        />

      </div>

      {/* Comment input — pinned at bottom */}
      {commentInput && (
        <div className="border-t border-border shrink-0">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface-light">
            <span className="text-[11px] text-blue-400">
              {commentInput.startLine === commentInput.endLine
                ? `Line ${commentInput.startLine}`
                : `Lines ${commentInput.startLine}-${commentInput.endLine}`}
              {' '}({commentInput.side})
            </span>
            {commentInput.startLine === commentInput.endLine && (
              <span className="text-[10px] text-zinc-600 ml-auto">Shift+click to select range</span>
            )}
          </div>
          <TextField
            value={commentText}
            onChange={setCommentText}
            aria-label="Review comment"
            className="w-full"
          >
            <TextArea
              ref={inputRef}
              placeholder="Add a review comment... (Cmd+Enter to submit)"
              rows={2}
              className="w-full bg-surface px-3 py-2 text-[13px] text-zinc-200 placeholder:text-zinc-600 resize-none border-0"
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submitComment();
                }
                if (e.key === 'Escape') {
                  setCommentInput(null);
                }
              }}
            />
          </TextField>
          <div className="flex justify-end gap-2 px-3 py-1.5 bg-surface">
            <Button size="sm" variant="ghost" className="text-[12px] text-zinc-500 hover:text-zinc-300 px-2 py-1 h-auto" onPress={() => setCommentInput(null)}>Cancel</Button>
            <Button size="sm" className="text-[12px] bg-green-600 text-white rounded px-3 py-1 h-auto hover:bg-green-500" isDisabled={!commentText.trim()} onPress={submitComment}>Comment</Button>
          </div>
        </div>
      )}

      {/* Existing comments — listed below editor */}
      {comments.length > 0 && !commentInput && (
        <div ref={commentsListRef} className="border-t border-border shrink-0 max-h-48 overflow-y-auto">
          {comments.map(c => (
            <div
              key={c.id}
              id={`review-comment-${c.id}`}
              className={`flex items-start gap-2 px-3 py-2 border-b border-border/50 transition-colors ${focusedCommentId === c.id ? 'bg-blue-500/15 border-l-2 border-l-blue-400' : 'hover:bg-surface-light/30'}`}
              onClick={() => setFocusedCommentId(focusedCommentId === c.id ? null : c.id)}
            >
              <span className="text-[10px] text-blue-400 shrink-0 pt-0.5 font-mono">
                {c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}-${c.endLine}`}
              </span>
              <p className="text-[12px] text-zinc-300 flex-1 whitespace-pre-wrap min-w-0">{c.text}</p>
              <span onClick={(e) => e.stopPropagation()} className="shrink-0">
                <Button isIconOnly size="sm" variant="ghost" className="text-zinc-600 hover:text-red-400 text-[11px] h-auto p-0 min-w-0" onPress={() => onDeleteComment(c.id)} aria-label="Delete comment">×</Button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
