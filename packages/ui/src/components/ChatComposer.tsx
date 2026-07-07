/**
 * Chat composer — input area for a single Claude session.
 *
 * Owns no host state: input, paste buffer, streaming flag, permission
 * request, supported-models list, session metadata, etc. all flow in via
 * props. That makes it safe to mount one instance per pane in the focus-
 * mode layout — each composer is bound to its own `sessionId` and so the
 * "agent is thinking" ambient animation can be visible in every pane.
 *
 * Internally the composer owns:
 *   - inputRef / history navigation refs (one focused textarea at a time);
 *   - the slash-command and file-mention pickers (called as hooks here so
 *     each instance gets its own picker state — `useSlashCommands` and
 *     `useFileMention` keyed on this pane's input string);
 *   - selection completion handlers for slash and file-mention (they only
 *     manipulate this pane's input via `onChangeInput`).
 */
import { useRef, useState } from 'react';
import { Send as SendIcon } from 'lucide-react';
import { Button, Select, SelectTrigger, SelectValue, SelectPopover, SelectIndicator, ListBox, ListBoxItem } from '@heroui/react';
import { SlashCommandList, useSlashCommands } from './SlashCommandPicker';
import { FileMentionList, useFileMention } from './FileMentionPicker';
import {
  type EditResult,
  fenceEnter,
  insertText,
  isInsideCodeFence,
  wrapCodeBlock,
  wrapSelection,
} from '../lib/composer-markdown';
import { detectLanguage, displayLang, extForLang, isLikelyCode } from '../lib/detect-language';
import { getCaret } from '../lib/contenteditable';
import { RichInput } from './RichInput';
import { useFileIndex, type FileEntry } from '../lib/fuzzy-file-search';
import type { ConnectionStatus, ClaudeClient } from '../lib/claude-client';

export type PastedImage = { media_type: string; data: string; preview: string };

interface ActiveLike {
  isStreaming: boolean;
  permRequest: unknown;
  inputHistory: string[];
  supportedModels?: { id: string; label: string }[];
}

interface ActiveSessionLike {
  model?: string | null;
  permission_mode?: string;
  provider?: string;
}

interface OpencodeInfoLike {
  models?: { id: string; providerName: string; label: string }[];
}

interface Props {
  /** Identifier of the session this composer renders for. Currently only
   *  surfaced for keying/forwarding — handlers (onSend, onChangeInput, …)
   *  are pre-bound by the host. */
  sessionId: string;
  /** True when this is the only composer on screen (standard mode) or when
   *  this pane has keyboard focus. Drives `autoFocus` so we don't fight
   *  over the cursor when several panes mount at once. */
  autoFocus?: boolean;

  input: string;
  onChangeInput: (val: string | ((prev: string) => string)) => void;
  pastedImages: PastedImage[];
  onChangePastedImages: (
    val: PastedImage[] | ((prev: PastedImage[]) => PastedImage[]),
  ) => void;

  active: ActiveLike;
  activeSession?: ActiveSessionLike;
  connectionStatus: ConnectionStatus;
  opencodeInfo: OpencodeInfoLike | null;
  /** Shared snapshot of the Claude Agent SDK's supportedModels() — used as a
   *  cross-session fallback when this session hasn't yet reported its own
   *  list (e.g. just spawned). The SDK is the single source of truth: there
   *  is no hardcoded backup. Empty until the bridge has seen at least one
   *  Claude session boot since the cache was created. */
  claudeModels: { id: string; label: string }[];

  /** Slash commands available for this session (builtins + SDK-published).
   *  Computed in the host because it depends on `initInfo` shape. */
  slashCommands: string[];
  /** Used by the file-mention picker. The composer calls `useFileIndex`
   *  itself when given a client + cwd so each pane has its own index. */
  client: ClaudeClient | null;
  cwd: string | null;

  onSend: () => void;
  onInterrupt: () => void;
  onSelectModel: (modelId: string) => void;
  onSelectPermissionMode: (mode: string) => void;
  /** Optional callback fired when the textarea gains focus — host uses this
   *  to mirror "focused pane" → "active session". */
  onFocus?: () => void;
  /** Register a `codeBlock → badge` substitution for the next send. Used when a
   *  large paste is saved to a file: the composer shows the block, but the sent
   *  message swaps it for a file-reference badge (see ChatApp.handleSend). */
  onRegisterSnippet?: (block: string, badge: string) => void;
}

export function ChatComposer(props: Props) {
  const {
    input, onChangeInput, pastedImages, onChangePastedImages,
    active, activeSession, connectionStatus, opencodeInfo, claudeModels,
    slashCommands, client, cwd,
    onSend, onInterrupt, onSelectModel, onSelectPermissionMode, onFocus,
    onRegisterSnippet, autoFocus,
  } = props;

  // Per-pane refs. Hooks live here (not in the host) so each composer
  // instance has independent slash / file-mention picker state.
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const historyIdxRef = useRef(-1);
  const historyDraftRef = useRef('');

  // Double-ESC to interrupt. First ESC arms; second within the window calls
  // onInterrupt. The armed state drives the visual hint below the composer.
  const [escArmed, setEscArmed] = useState(false);
  const escTimerRef = useRef<number | null>(null);
  const ESC_WINDOW_MS = 1500;
  const armEsc = () => {
    setEscArmed(true);
    if (escTimerRef.current !== null) window.clearTimeout(escTimerRef.current);
    escTimerRef.current = window.setTimeout(() => {
      setEscArmed(false);
      escTimerRef.current = null;
    }, ESC_WINDOW_MS);
  };
  const disarmEsc = () => {
    if (escTimerRef.current !== null) {
      window.clearTimeout(escTimerRef.current);
      escTimerRef.current = null;
    }
    setEscArmed(false);
  };

  const fileIndex: FileEntry[] = useFileIndex(client, cwd);
  const slash = useSlashCommands(input, slashCommands);
  const fileMention = useFileMention(input, fileIndex, client, cwd);

  // In-place syntax highlighting (Slack-style): a backdrop layer renders the
  // tinted/tokenised draft directly behind a transparent textarea. The two must
  // stay glyph-aligned, so the backdrop mirrors the textarea's typography and
  // its scroll offset.
  // Programmatic edits (formatting shortcuts, history) stash the desired caret
  // here; RichInput restores it right after `input` re-renders.
  const desiredCaretRef = useRef<{ start: number; end: number } | null>(null);
  const applyEdit = (r: EditResult) => {
    desiredCaretRef.current = { start: r.selectionStart, end: r.selectionEnd };
    onChangeInput(r.text);
  };
  // Current selection as character offsets into `input` (chat-mode editor).
  const caret = (): { start: number; end: number } => {
    const el = editorRef.current;
    return (el && getCaret(el)) || { start: input.length, end: input.length };
  };

  // ---- Paste-as-code -------------------------------------------------------
  // Medium snippets get wrapped in a fenced block inline; large ones are saved
  // to a file (~/.codiby/<sid>/<uuid>) and referenced by a badge so they don't
  // flood the chat. Prose pastes fall through to the browser's default.
  const SNIPPET_FILE_LINES = 30;
  const SNIPPET_FILE_BYTES = 10_000;

  // Drop `snippet` at the current caret, ensuring it sits on its own line(s).
  // Caret lands just after it (or after a trailing space when nothing follows).
  const insertSnippet = (start: number, end: number, snippet: string) => {
    const before = input.slice(0, start);
    const after = input.slice(end);
    const nlB = before && !before.endsWith('\n') ? '\n' : '';
    const nlA = after && !after.startsWith('\n') ? '\n' : '';
    const piece = nlB + snippet + (after ? nlA : ' ');
    const caret = (before + nlB + snippet).length + (after ? 0 : 1);
    applyEdit({ text: before + piece + after, selectionStart: caret, selectionEnd: caret });
  };

  const fenceFor = (text: string, lang: string) => '```' + (lang || '') + '\n' + text + '\n```';

  // Large paste: the code is saved to a file in the background, but the composer
  // still shows the full code block. We register a `block → badge` mapping so
  // that at send time the block is swapped for a file-reference badge — the
  // agent gets the path, not 200 lines of inline code.
  const registerSnippet = async (block: string, text: string, lang: string, lineCount: number) => {
    const ext = extForLang(lang);
    const res = await client!.saveSnippet(props.sessionId, text, ext);
    if (!res) return; // save failed → block stays inline (full code is sent)
    const kb = (text.length / 1024).toFixed(1);
    const name = `snippet-${res.uuid.slice(0, 6)}${ext ? '.' + ext : ''}`;
    const sub = `${lang ? displayLang(lang) + ' · ' : ''}${lineCount} líneas · ${kb} KB`;
    onRegisterSnippet?.(block, `[${name} · ${sub}](codiby-snippet:${res.path})`);
  };

  const handleCodePaste = (raw: string) => {
    const { start, end } = caret();
    const text = raw.replace(/\n+$/, '');
    const lang = detectLanguage(text);
    const lineCount = text.split('\n').length;
    const block = fenceFor(text, lang);
    // Always show the code block in the composer.
    insertSnippet(start, end, block);
    // If it's large, save it to a file and remember to swap it for a badge on send.
    const isLarge = lineCount > SNIPPET_FILE_LINES || text.length > SNIPPET_FILE_BYTES;
    if (isLarge && client && props.sessionId && onRegisterSnippet) {
      void registerSnippet(block, text, lang, lineCount);
    }
  };

  // Selection completion — slash command picker → "/cmd " prefix.
  const handleSlashSelect = (cmd: string) => {
    onChangeInput(`/${cmd} `);
  };
  // File-mention picker → substitute `@query` with `@relpath[/]`.
  const handleFileMentionSelect = (
    file: { name: string; path: string; rel: string; type?: 'file' | 'dir' },
  ) => {
    const before = input.slice(0, fileMention.atIdx);
    const suffix = file.type === 'dir' ? '/' : '';
    onChangeInput(`${before}@${file.rel}${suffix} `);
  };

  const isTerminalMode = input.startsWith('>');
  const cmdText = isTerminalMode ? input.slice(1).replace(/^ /, '') : input;
  const streaming = active.isStreaming;

  // Chat-mode key handling on the contenteditable editor. Selection comes from
  // `caret()` (character offsets), and edits go through `applyEdit`.
  const handleChatKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    // Wrap selection: Mod+E inline `code`, Mod+Shift+E ``` block.
    if (mod && (e.key === 'e' || e.key === 'E')) {
      e.preventDefault();
      const c = caret();
      applyEdit(e.shiftKey ? wrapCodeBlock(input, c.start, c.end) : wrapSelection(input, c.start, c.end, '`', '`'));
      return;
    }
    // Type a backtick over a selection → wrap it.
    if (e.key === '`' && !mod) {
      const c = caret();
      if (c.start !== c.end) { e.preventDefault(); applyEdit(wrapSelection(input, c.start, c.end, '`', '`')); return; }
    }
    // Tab indents inside a fence.
    if (e.key === 'Tab' && !mod && !slash.isActive && !fileMention.isActive) {
      const c = caret();
      if (isInsideCodeFence(input, c.start)) { e.preventDefault(); applyEdit(insertText(input, c.start, c.end, '  ')); return; }
    }
    // Double-ESC interrupt while streaming.
    if (e.key === 'Escape' && streaming && !slash.isActive && !fileMention.isActive) {
      e.preventDefault();
      if (escArmed) { disarmEsc(); onInterrupt(); } else { armEsc(); }
      return;
    }
    // History: Up at the very start, Down at the very end.
    if (e.key === 'ArrowUp' && !e.shiftKey && !slash.isActive && !fileMention.isActive) {
      const c = caret();
      if (c.start === 0 && c.end === 0) {
        e.preventDefault();
        const hist = active.inputHistory;
        if (hist.length === 0) return;
        if (historyIdxRef.current === -1) historyDraftRef.current = input;
        const ni = historyIdxRef.current === -1 ? hist.length - 1 : Math.max(0, historyIdxRef.current - 1);
        historyIdxRef.current = ni;
        onChangeInput(hist[ni]!);
        return;
      }
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && !slash.isActive && !fileMention.isActive) {
      const c = caret();
      if (c.start === input.length && c.end === input.length) {
        e.preventDefault();
        const hist = active.inputHistory;
        if (historyIdxRef.current === -1) return;
        const ni = historyIdxRef.current + 1;
        if (ni >= hist.length) { historyIdxRef.current = -1; onChangeInput(historyDraftRef.current); }
        else { historyIdxRef.current = ni; onChangeInput(hist[ni]!); }
        return;
      }
    }
    if (fileMention.isActive) fileMention.onKeyDown(e as unknown as React.KeyboardEvent<HTMLTextAreaElement>, handleFileMentionSelect);
    else slash.onKeyDown(e as unknown as React.KeyboardEvent<HTMLTextAreaElement>, handleSlashSelect);
    // Enter: break/auto-close inside a fence, otherwise send. Shift+Enter falls
    // through to the browser's native line break.
    if (e.key === 'Enter' && !e.shiftKey && !slash.isActive && !fileMention.isActive) {
      const c = caret();
      const edit = fenceEnter(input, c.start, c.end);
      if (edit) { e.preventDefault(); applyEdit(edit); return; }
      e.preventDefault();
      onSend();
    }
  };

  const handleChatPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData?.items;
    let hadImage = false;
    if (items) {
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          hadImage = true;
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const [header, data] = dataUrl.split(',');
            const media_type = header!.match(/:(.*?);/)?.[1] || 'image/png';
            onChangePastedImages(prev => [...prev, { media_type, data: data!, preview: dataUrl }]);
          };
          reader.readAsDataURL(file);
        }
      }
    }
    if (hadImage) return;
    const pasted = e.clipboardData?.getData('text') ?? '';
    if (!pasted.trim()) return;
    // Always handle the paste ourselves so contenteditable never injects rich
    // HTML: code is wrapped/offloaded, prose is inserted as plain text.
    e.preventDefault();
    if (isLikelyCode(pasted)) handleCodePaste(pasted);
    else document.execCommand('insertText', false, pasted);
  };

  const handleTerminalKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Backspace' && !cmdText) { e.preventDefault(); onChangeInput(''); return; }
    if (e.key === 'Escape' && streaming) {
      e.preventDefault();
      if (escArmed) { disarmEsc(); onInterrupt(); } else { armEsc(); }
      return;
    }
    const el = e.currentTarget;
    if (e.key === 'ArrowUp' && !e.shiftKey && el.selectionStart === 0 && el.selectionEnd === 0) {
      e.preventDefault();
      const hist = active.inputHistory;
      if (hist.length === 0) return;
      if (historyIdxRef.current === -1) historyDraftRef.current = input;
      const ni = historyIdxRef.current === -1 ? hist.length - 1 : Math.max(0, historyIdxRef.current - 1);
      historyIdxRef.current = ni;
      onChangeInput(hist[ni]!);
      return;
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && el.selectionStart === el.value.length) {
      e.preventDefault();
      const hist = active.inputHistory;
      if (historyIdxRef.current === -1) return;
      const ni = historyIdxRef.current + 1;
      if (ni >= hist.length) { historyIdxRef.current = -1; onChangeInput(historyDraftRef.current); }
      else { historyIdxRef.current = ni; onChangeInput(hist[ni]!); }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
  };
  const refs = input.match(/@[\w.\/\-:]+/g);
  const isOpenCode = activeSession?.provider === 'opencode';
  const ocModels = isOpenCode ? (opencodeInfo?.models ?? null) : undefined;
  const ocLoading = isOpenCode && opencodeInfo === null;
  // Prefer this session's own SDK-reported list once it lands, then fall
  // back to the cross-session cache. Both come from the Agent SDK — there
  // is no hardcoded list anywhere.
  const claudeModelChoices = isOpenCode
    ? []
    : (active.supportedModels && active.supportedModels.length > 0
        ? active.supportedModels
        : claudeModels);
  // Terminal commands can't be queued offline (they run on the live pane), so
  // they still require a live connection. Chat messages, however, can be
  // composed while the session is closed — they're staged with a "sending"
  // loader and delivered when the remote session reconnects.
  const sendDisabled = isTerminalMode
    ? !cmdText.trim() || connectionStatus !== 'connected'
    : !input.trim();
  const triggerCls =
    'min-h-0 h-[26px] py-0 px-2.5 rounded-full bg-transparent hover:bg-white/5 data-[hovered]:bg-white/5 text-[12px] text-zinc-400 hover:text-zinc-200 border-0 shadow-none transition-colors whitespace-nowrap overflow-hidden';

  return (
    <div className="p-3 shrink-0 relative">
      <div className="max-w-4xl mx-auto relative">
        {slash.isActive && (
          <SlashCommandList
            filtered={slash.filtered}
            selectedIndex={slash.selectedIndex}
            onSelect={handleSlashSelect}
            onHover={() => {}}
          />
        )}
        {fileMention.isActive && (
          <FileMentionList
            results={fileMention.results}
            selectedIndex={fileMention.selectedIndex}
            onSelect={handleFileMentionSelect}
          />
        )}
        {/* Double-ESC interrupt hint — fades in for ESC_WINDOW_MS after the
            first ESC while streaming, instructing the user to press again. */}
        <div
          aria-live="polite"
          className={`pointer-events-none absolute left-1/2 -top-2 -translate-x-1/2 -translate-y-full z-50 transition-opacity duration-150 ${
            escArmed && streaming ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <div className="bg-zinc-900/95 border border-amber-500/40 text-amber-300 text-[11px] px-2.5 py-1 rounded-full shadow-lg whitespace-nowrap">
            Press <kbd className="font-mono px-1 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-amber-200">Esc</kbd> again to stop
          </div>
        </div>
        <div className="relative">
          {/* Ambient color spots — four point-lights bouncing in pairs.
              Clipped to the composer's rounded bounds. Fades in while
              the session is streaming. */}
          <div
            aria-hidden
            className="absolute inset-0 overflow-hidden pointer-events-none transition-opacity duration-300 ease-out"
            style={{
              opacity: active.isStreaming && !active.permRequest ? 1 : 0,
              borderRadius: isTerminalMode ? '1rem' : '18px',
            }}
          >
            <span className="composer-spot composer-spot--b1" />
            <span className="composer-spot composer-spot--b3" />
            <span className="composer-spot composer-spot--b4" />
            <span className="composer-spot composer-spot--b5" />
          </div>
          <div
            className={`relative transition-colors ${
              isTerminalMode
                ? 'rounded-2xl border shadow-lg shadow-black/30 bg-[#141414] border-green-900/50 focus-within:border-green-700/60'
                : 'composer-glass-frame bg-[rgba(28,28,33,0.6)]'
            }`}
            style={isTerminalMode ? undefined : {
              backdropFilter: 'blur(28px) saturate(180%)',
              WebkitBackdropFilter: 'blur(28px) saturate(180%)',
            }}
          >
            {refs && refs.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
                {refs.map((ref, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-light text-[11px] font-mono text-amber-400/80 border border-border-light"
                  >
                    {ref}
                    <button
                      className="text-zinc-500 hover:text-zinc-300 ml-0.5"
                      onClick={() => onChangeInput(prev => prev.replace(ref, '').replace(/  +/g, ' ').trim())}
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
            )}

            {pastedImages.length > 0 && (
              <div className="flex gap-2 px-3 pt-2.5 flex-wrap">
                {pastedImages.map((img, i) => (
                  <div key={i} className="relative group">
                    <img src={img.preview} alt="" className="h-16 rounded border border-border object-cover" />
                    <button
                      className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-zinc-700 text-zinc-300 text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
                      onClick={() => onChangePastedImages(prev => prev.filter((_, j) => j !== i))}
                    >
                      &times;
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-start px-4 pt-3.5 pb-1">
              {isTerminalMode ? (
                <>
                  <span className="text-green-500 text-sm font-mono pr-1 py-0.5 select-none shrink-0">&gt;</span>
                  <textarea
                    ref={inputRef}
                    value={cmdText}
                    onChange={(e) => { const v = e.target.value; onChangeInput(v ? `> ${v}` : '> '); }}
                    onFocus={onFocus}
                    disabled={connectionStatus !== 'connected'}
                    placeholder="command..."
                    onKeyDown={handleTerminalKeyDown}
                    autoFocus={autoFocus}
                    rows={1}
                    className="flex-1 w-full p-0 bg-transparent border-0 outline-none resize-none text-[14px] leading-6 font-mono text-green-300 placeholder:text-zinc-500 disabled:opacity-50"
                    style={{ minHeight: 24, maxHeight: 200 }}
                    onInput={(e) => {
                      const el = e.currentTarget;
                      el.style.height = 'auto';
                      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
                    }}
                  />
                </>
              ) : (
                <RichInput
                  ref={editorRef}
                  value={input}
                  onChange={(t) => onChangeInput(t)}
                  desiredCaretRef={desiredCaretRef}
                  onFocus={onFocus}
                  autoFocus={autoFocus}
                  placeholder={
                    connectionStatus !== 'connected'
                      ? 'Session offline — message will send on reconnect…'
                      : streaming
                        ? 'Queue a follow-up message…'
                        : 'Send a message...'
                  }
                  onKeyDown={handleChatKeyDown}
                  onPaste={handleChatPaste}
                  className="rc-editor cm-highlight flex-1 w-full text-[14px] leading-6 text-zinc-200 outline-none break-words"
                />
              )}
            </div>

            <div className="flex items-center gap-1 px-2 pb-2 pt-1.5">
              <Select
                aria-label="Model"
                selectedKey={activeSession?.model || 'default'}
                onSelectionChange={(key) => {
                  const modelId = key === 'default' ? '' : String(key);
                  onSelectModel(modelId);
                }}
                className={isOpenCode ? 'w-56' : 'w-32'}
                isDisabled={ocLoading}
              >
                <SelectTrigger className={triggerCls}>
                  <SelectValue className="min-w-0 flex-1 truncate" />
                  <SelectIndicator className="size-3.5 shrink-0" />
                </SelectTrigger>
                <SelectPopover>
                  <ListBox>
                    <ListBoxItem key="default" id="default" textValue="Default"><span className="text-xs">Default</span></ListBoxItem>
                    {isOpenCode
                      ? (ocModels ?? []).map(m => (
                          <ListBoxItem key={m.id} id={m.id} textValue={`${m.providerName} ${m.label}`}>
                            <span className="text-xs">
                              <span className="text-zinc-500">{m.providerName}</span>{' '}
                              {m.label}
                            </span>
                          </ListBoxItem>
                        ))
                      : claudeModelChoices.map(m => (
                          <ListBoxItem key={m.id} id={m.id} textValue={m.label}>
                            <span className="text-xs">{m.label}</span>
                          </ListBoxItem>
                        ))}
                  </ListBox>
                </SelectPopover>
              </Select>

              <Select
                aria-label="Permission mode"
                selectedKey={activeSession?.permission_mode || 'default'}
                onSelectionChange={(key) => onSelectPermissionMode(String(key))}
                className="w-36"
              >
                <SelectTrigger className={triggerCls}>
                  <SelectValue className="min-w-0 flex-1 truncate" />
                  <SelectIndicator className="size-3.5 shrink-0" />
                </SelectTrigger>
                <SelectPopover>
                  <ListBox>
                    <ListBoxItem key="default" id="default" textValue="Default"><span className="text-xs">Default</span></ListBoxItem>
                    <ListBoxItem key="acceptEdits" id="acceptEdits" textValue="Accept Edits"><span className="text-xs">Accept Edits</span></ListBoxItem>
                    <ListBoxItem key="plan" id="plan" textValue="Plan"><span className="text-xs">Plan</span></ListBoxItem>
                    <ListBoxItem key="bypassPermissions" id="bypassPermissions" textValue="Bypass"><span className="text-xs">Bypass All</span></ListBoxItem>
                  </ListBox>
                </SelectPopover>
              </Select>

              <div className="flex-1" />

              {streaming && (
                <button
                  type="button"
                  onClick={onInterrupt}
                  className="text-amber-400 hover:text-amber-300 text-[12px] h-[26px] px-2.5 rounded-full hover:bg-white/5 transition-colors"
                >
                  Stop
                </button>
              )}

              <Button
                isIconOnly
                onPress={onSend}
                isDisabled={sendDisabled}
                aria-label={isTerminalMode ? 'Run' : (streaming ? 'Queue message' : 'Send message')}
                className={`rounded-full w-[30px] h-[30px] min-w-[30px] min-h-0 p-0 flex items-center justify-center transition-colors disabled:bg-surface-light disabled:text-zinc-600 ${
                  isTerminalMode
                    ? 'bg-green-600 hover:bg-green-500 text-white'
                    : 'bg-[#ececef] text-[#07070a] hover:bg-white'
                }`}
              >
                <SendIcon className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
