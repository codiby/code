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
}

export function ChatComposer(props: Props) {
  const {
    input, onChangeInput, pastedImages, onChangePastedImages,
    active, activeSession, connectionStatus, opencodeInfo, claudeModels,
    slashCommands, client, cwd,
    onSend, onInterrupt, onSelectModel, onSelectPermissionMode, onFocus,
    autoFocus,
  } = props;

  // Per-pane refs. Hooks live here (not in the host) so each composer
  // instance has independent slash / file-mention picker state.
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
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
              {isTerminalMode && (
                <span className="text-green-500 text-sm font-mono pr-1 py-0.5 select-none shrink-0">&gt;</span>
              )}
              <textarea
                ref={inputRef}
                value={isTerminalMode ? cmdText : input}
                onChange={(e) => {
                  if (isTerminalMode) {
                    const v = e.target.value;
                    onChangeInput(v ? `> ${v}` : '> ');
                  } else {
                    onChangeInput(e.target.value);
                  }
                }}
                onFocus={onFocus}
                disabled={isTerminalMode && connectionStatus !== 'connected'}
                placeholder={
                  isTerminalMode
                    ? 'command...'
                    : connectionStatus !== 'connected'
                      ? 'Session offline — message will send on reconnect…'
                      : streaming
                        ? 'Queue a follow-up message…'
                        : 'Send a message...'
                }
                onKeyDown={(e) => {
                  if (isTerminalMode && e.key === 'Backspace' && !cmdText) {
                    e.preventDefault();
                    onChangeInput('');
                    return;
                  }
                  // Double-ESC to interrupt while streaming. First press arms
                  // the action and shows the hint; second press within
                  // ESC_WINDOW_MS calls onInterrupt. Skip when a picker is open
                  // so it can consume the key to close itself first.
                  if (e.key === 'Escape' && streaming && !slash.isActive && !fileMention.isActive) {
                    e.preventDefault();
                    if (escArmed) {
                      disarmEsc();
                      onInterrupt();
                    } else {
                      armEsc();
                    }
                    return;
                  }
                  if (e.key === 'ArrowUp' && !e.shiftKey && !slash.isActive && !fileMention.isActive) {
                    const el = e.currentTarget;
                    if (el.selectionStart === 0 && el.selectionEnd === 0) {
                      e.preventDefault();
                      const hist = active.inputHistory;
                      if (hist.length === 0) return;
                      if (historyIdxRef.current === -1) historyDraftRef.current = input;
                      const newIdx = historyIdxRef.current === -1 ? hist.length - 1 : Math.max(0, historyIdxRef.current - 1);
                      historyIdxRef.current = newIdx;
                      onChangeInput(hist[newIdx]!);
                      return;
                    }
                  }
                  if (e.key === 'ArrowDown' && !e.shiftKey && !slash.isActive && !fileMention.isActive) {
                    const el = e.currentTarget;
                    if (el.selectionStart === el.value.length) {
                      e.preventDefault();
                      const hist = active.inputHistory;
                      if (historyIdxRef.current === -1) return;
                      const newIdx = historyIdxRef.current + 1;
                      if (newIdx >= hist.length) {
                        historyIdxRef.current = -1;
                        onChangeInput(historyDraftRef.current);
                      } else {
                        historyIdxRef.current = newIdx;
                        onChangeInput(hist[newIdx]!);
                      }
                      return;
                    }
                  }
                  if (fileMention.isActive) {
                    fileMention.onKeyDown(e, handleFileMentionSelect);
                  } else {
                    slash.onKeyDown(e, handleSlashSelect);
                  }
                  if (e.key === 'Enter' && !e.shiftKey && !slash.isActive && !fileMention.isActive) {
                    e.preventDefault();
                    onSend();
                  }
                }}
                autoFocus={autoFocus}
                rows={1}
                className={`flex-1 bg-transparent border-0 outline-none resize-none text-[14px] leading-6 placeholder:text-zinc-500 disabled:opacity-50 ${
                  isTerminalMode ? 'font-mono text-green-300' : 'text-zinc-200'
                }`}
                style={{ minHeight: 24, maxHeight: 200 }}
                onPaste={(e) => {
                  const items = e.clipboardData?.items;
                  if (!items) return;
                  for (const item of items) {
                    if (item.type.startsWith('image/')) {
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
                }}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = 'auto';
                  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
                }}
              />
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
