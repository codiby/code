/**
 * Empty-session stage — wraps the live ChatComposer so that a session with no
 * messages reads like the group's new-session screen (GroupComposer): the
 * composer sits in the middle of the pane under a
 * "New session in <folder> with <provider>" headline, with the branch chip
 * below it. Once the first message lands, the headline and the chip collapse
 * away and the composer travels down to its usual slot at the bottom.
 *
 * The composer never changes parent: it always lives in the pane's bottom
 * slot, and "centred" is nothing but a `translateY` on the wrapper. That
 * keeps the transition to a single tween and — more importantly — keeps the
 * contenteditable mounted, so focus, caret position and any in-flight IME
 * composition survive the animation. Reparenting it into a centred container
 * would remount the editor and drop all three.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import gsap from 'gsap';
import {
  Select, SelectTrigger, SelectValue, SelectPopover, SelectIndicator,
  ListBox, ListBoxItem,
} from '@heroui/react';
import { Bot, FolderClosed, GitBranch, Plus } from 'lucide-react';

interface Props {
  /** Session this stage is bound to. A change re-lays out without animating —
   *  switching tabs should never look like a send. */
  sessionId: string;
  /** True while the session has no messages: composer centred, chrome shown. */
  centered: boolean;
  /** Basename of the session's cwd, shown in the headline. */
  folderName: string;
  /** Human label for the session's provider ("Claude", "Codex", …). */
  providerLabel: string;
  /** With these, the provider becomes a picker — the session has no messages
   *  yet, so it can still be recreated under another provider. */
  provider?: string;
  providerOptions?: { key: string; label: string }[];
  onProviderChange?: (provider: string) => void;
  /** A provider or host switch is in flight. */
  switchingProvider?: boolean;
  /** Machines the session can move to (`id: null` = this one). With
   *  `onHostChange`, the headline gets a host picker; absent when no remote
   *  is configured. */
  hosts?: { id: string | null; name: string; color?: string }[];
  host?: string | null;
  onHostChange?: (remoteId: string | null) => void;
  /** Why the last host switch didn't happen (folder missing there, …). */
  hostError?: string | null;
  /** A project's "+": the headline names the project, and the folder becomes
   *  a picker of that project's folders only. The folder carries its host, so
   *  the host picker is left out. */
  project?: { name: string; color?: string };
  folders?: { key: string; name: string; hostName?: string; hostColor?: string }[];
  folderKey?: string;
  onFolderChange?: (key: string) => void;
  /** With this, the folder list ends in "Add folder to the project…". */
  onAddFolder?: () => void;
  /** Current git branch of the session's cwd, when known. */
  branch?: string | null;
  /** Chat scroll container — faded up as the composer docks so the first
   *  exchange arrives with the composer rather than popping in behind it. */
  getThreadEl?: () => HTMLElement | null;
  /** Tailwind max-width for the headline/branch chrome, so it lines up with
   *  the composer underneath it. Defaults to the historical `max-w-4xl`. */
  widthClass?: string;
  /** The real composer (ChatComposer and the pills above it). */
  children: ReactNode;
}

/** The folder list's last row: opens the add-folder modal, never selected. */
const ADD_FOLDER_KEY = '__add_folder__';

/** Select keys can't be null; this stands for "this machine". */
const LOCAL_KEY = '__local__';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function EmptyComposerStage({
  sessionId, centered, folderName, providerLabel, provider, providerOptions, onProviderChange,
  switchingProvider, hosts, host = null, onHostChange, hostError, branch, getThreadEl,
  project, folders, folderKey, onFolderChange, onAddFolder,
  widthClass = 'max-w-4xl', children,
}: Props) {
  const stackRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const footRef = useRef<HTMLDivElement>(null);
  // Chrome outlives `centered` by one animation: it has to stay mounted while
  // it fades and collapses, so it's unmounted in the timeline's onComplete.
  const [showChrome, setShowChrome] = useState(centered);
  const animatingRef = useRef(false);
  const prevCenteredRef = useRef(centered);
  const prevSessionRef = useRef(sessionId);

  /** Offset that puts the stack's centre on the pane's centre. The stack is
   *  the pane's bottom-anchored last child, so this is always negative. */
  const centerOffset = () => {
    const stack = stackRef.current;
    const pane = stack?.parentElement;
    if (!stack || !pane) return 0;
    return -Math.max(0, (pane.clientHeight - stack.offsetHeight) / 2);
  };

  // Keep the composer centred as the pane resizes (window, sidebar, panels)
  // and as the composer itself grows while the user types a long first
  // message. Only while centred and idle — mid-tween the timeline owns `y`.
  useLayoutEffect(() => {
    const stack = stackRef.current;
    const pane = stack?.parentElement;
    if (!stack || !pane || !centered) return;
    const recenter = () => {
      if (animatingRef.current) return;
      gsap.set(stack, { y: centerOffset() });
    };
    const ro = new ResizeObserver(recenter);
    ro.observe(pane);
    ro.observe(stack);
    return () => ro.disconnect();
  }, [centered, showChrome]);

  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;

    const sessionChanged = prevSessionRef.current !== sessionId;
    const wasCentered = prevCenteredRef.current;
    prevSessionRef.current = sessionId;
    prevCenteredRef.current = centered;

    const thread = getThreadEl?.() ?? null;
    const chrome = [headRef.current, footRef.current].filter(Boolean) as HTMLElement[];

    const settle = () => {
      gsap.killTweensOf([stack, ...chrome]);
      if (thread) gsap.killTweensOf(thread);
      animatingRef.current = false;
      if (chrome.length) gsap.set(chrome, { clearProps: 'all' });
      if (thread) gsap.set(thread, { clearProps: 'opacity,transform' });
      gsap.set(stack, { y: centered ? centerOffset() : 0 });
      setShowChrome(centered);
    };

    // Centred, or arriving from another session, or already docked: no
    // choreography, just land in the right place.
    if (centered || sessionChanged || !wasCentered) {
      settle();
      return;
    }

    // Centred → docked: the session's first message just landed.
    if (prefersReducedMotion()) { settle(); return; }

    animatingRef.current = true;
    const tl = gsap.timeline({
      defaults: { ease: 'power3.inOut' },
      onComplete: () => { animatingRef.current = false; setShowChrome(false); },
    });
    if (headRef.current) {
      tl.to(headRef.current, { opacity: 0, y: -10, duration: 0.22, ease: 'power2.in' }, 0);
    }
    if (footRef.current) {
      tl.to(footRef.current, { opacity: 0, duration: 0.18, ease: 'power2.in' }, 0);
    }
    if (chrome.length) {
      // Collapsing the chrome's height as the composer travels means the two
      // motions add up instead of the composer jumping at the end.
      tl.to(chrome, { height: 0, duration: 0.45 }, 0.1);
    }
    tl.to(stack, { y: 0, duration: 0.62 }, 0.06);
    if (thread) {
      tl.fromTo(
        thread,
        { opacity: 0, y: 18 },
        { opacity: 1, y: 0, duration: 0.42, ease: 'power2.out', clearProps: 'transform' },
        0.3,
      );
    }
    return () => { tl.kill(); animatingRef.current = false; };
  }, [centered, sessionId]);

  return (
    <div ref={stackRef} className="shrink-0 relative z-10">
      {showChrome && (
        <div ref={headRef} className="overflow-hidden">
          <div className={`${widthClass} mx-auto px-6 pb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[22px] text-zinc-400 font-light`}>
            <span>New session in</span>
            {project && (
              <span className="inline-flex items-center gap-1.5 text-zinc-100">
                <span
                  className="w-[18px] h-[18px] grid place-items-center rounded-[5px] font-mono text-[11px] font-semibold shrink-0"
                  style={{ background: project.color ?? 'var(--color-surface-lighter)', color: project.color ? '#0f1012' : 'var(--color-zinc-300)' }}
                >
                  {project.name.trim().charAt(0).toUpperCase()}
                </span>
                <span className="font-semibold">{project.name}</span>
              </span>
            )}
            {!folders && hosts && onHostChange && (() => {
              const current = hosts.find(h => h.id === host);
              const color = current?.color || (host ? '#a78bfa' : '#71717a');
              return (
                <Select
                  aria-label="Host"
                  selectedKey={host ?? LOCAL_KEY}
                  isDisabled={switchingProvider}
                  onSelectionChange={(key) => {
                    if (key == null) return;
                    const next = key === LOCAL_KEY ? null : String(key);
                    if (next !== host) onHostChange(next);
                  }}
                >
                  <SelectTrigger
                    className="min-h-0 h-auto inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider rounded-md px-2 py-0.5 border shadow-none hover:brightness-125"
                    style={{ color, background: `${color}14`, borderColor: `${color}40` }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
                    <SelectValue className="text-[11px]" style={{ color }} />
                    <SelectIndicator className="!static size-3 opacity-60 shrink-0" />
                  </SelectTrigger>
                  <SelectPopover>
                    <ListBox>
                      {hosts.map(h => (
                        <ListBoxItem key={h.id ?? LOCAL_KEY} id={h.id ?? LOCAL_KEY} textValue={h.name}>
                          <span className="inline-flex items-center gap-2 text-sm">
                            <span className="w-1.5 h-1.5 rounded-full" style={{ background: h.color || '#a78bfa' }} />
                            {h.name}
                          </span>
                        </ListBoxItem>
                      ))}
                    </ListBox>
                  </SelectPopover>
                </Select>
              );
            })()}
            {folders && onFolderChange ? (
              <Select
                aria-label="Folder"
                selectedKey={folderKey ?? null}
                isDisabled={switchingProvider}
                onSelectionChange={(key) => {
                  if (key === ADD_FOLDER_KEY) { onAddFolder?.(); return; }
                  if (key != null && key !== folderKey) onFolderChange(String(key));
                }}
              >
                <SelectTrigger className="min-h-0 h-auto py-0 px-1.5 bg-transparent border-0 shadow-none hover:bg-white/5 data-[hovered]:bg-white/5 rounded-md text-[22px] text-zinc-100">
                  <FolderClosed size={18} className="text-zinc-500 mr-1.5 shrink-0" />
                  {/* Just the name: the item's icon and host chip are for the list. */}
                  <SelectValue className="font-semibold text-zinc-100">{({ selectedText }) => selectedText || folderName}</SelectValue>
                  <SelectIndicator className="!static size-4 text-zinc-600 ml-1 shrink-0" />
                </SelectTrigger>
                <SelectPopover>
                  <ListBox>
                    {folders.map(f => (
                      <ListBoxItem key={f.key} id={f.key} textValue={f.name}>
                        <span className="flex w-full items-center gap-2 text-sm">
                          <FolderClosed size={14} className="text-zinc-500 shrink-0" />
                          <span className="flex-1 truncate">{f.name}</span>
                          {f.hostName && (
                            <span
                              className="text-[9px] font-semibold uppercase tracking-wider px-1 py-0.5 rounded border leading-none shrink-0"
                              style={{ color: f.hostColor || '#a78bfa', background: `${f.hostColor || '#a78bfa'}14`, borderColor: `${f.hostColor || '#a78bfa'}40` }}
                            >
                              {f.hostName}
                            </span>
                          )}
                        </span>
                      </ListBoxItem>
                    ))}
                    {onAddFolder && (
                      <ListBoxItem
                        key={ADD_FOLDER_KEY}
                        id={ADD_FOLDER_KEY}
                        textValue="Add folder to the project"
                        className="mt-1 relative before:absolute before:-top-0.5 before:left-1 before:right-1 before:h-px before:bg-border"
                      >
                        <span className="flex w-full items-center gap-2 text-sm text-zinc-400">
                          <Plus size={14} className="text-zinc-500 shrink-0" />
                          Add folder to the project…
                        </span>
                      </ListBoxItem>
                    )}
                  </ListBox>
                </SelectPopover>
              </Select>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-zinc-100" title={folderName}>
                <FolderClosed size={18} className="text-zinc-500" />
                <span className="font-semibold">{folderName}</span>
              </span>
            )}
            <span>with</span>
            {provider && providerOptions && onProviderChange ? (
              <Select
                aria-label="Provider"
                selectedKey={provider}
                isDisabled={switchingProvider}
                onSelectionChange={(key) => { if (key != null && key !== provider) onProviderChange(String(key)); }}
              >
                <SelectTrigger className="min-h-0 h-auto py-0 px-1.5 bg-transparent border-0 shadow-none hover:bg-white/5 data-[hovered]:bg-white/5 rounded-md text-[22px] text-zinc-100">
                  <Bot size={18} className="text-zinc-500 mr-1.5 shrink-0" />
                  <SelectValue className="font-semibold text-zinc-100" />
                  <SelectIndicator className="!static size-4 text-zinc-600 ml-1 shrink-0" />
                </SelectTrigger>
                <SelectPopover>
                  <ListBox>
                    {providerOptions.map(opt => (
                      <ListBoxItem key={opt.key} id={opt.key} textValue={opt.label}>
                        <span className="text-sm">{opt.label}</span>
                      </ListBoxItem>
                    ))}
                  </ListBox>
                </SelectPopover>
              </Select>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-zinc-100">
                <Bot size={18} className="text-zinc-500" />
                <span className="font-semibold">{providerLabel}</span>
              </span>
            )}
            {switchingProvider && (
              <span role="status" className="inline-flex items-center gap-2 text-xs text-zinc-500">
                <span className="w-3 h-3 rounded-full border-[1.5px] border-zinc-500/25 border-t-teal-400 animate-spin" />
                Switching…
              </span>
            )}
            {hostError && !switchingProvider && (
              <p role="alert" className="basis-full text-xs text-red-400">{hostError}</p>
            )}
          </div>
        </div>
      )}

      {children}

      {showChrome && (
        <div ref={footRef} className="overflow-hidden">
          <div className={`${widthClass} mx-auto px-6 pb-2 -mt-1 flex items-center justify-end text-xs text-zinc-500`}>
            {branch && (
              <span className="inline-flex items-center gap-1.5 px-2 py-1" title={branch}>
                <GitBranch size={12} />
                <span className="font-mono">{branch}</span>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
