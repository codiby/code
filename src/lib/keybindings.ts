/**
 * Central keybinding registry — the single source of truth for every
 * rebindable global command in the app.
 *
 * Historically each global shortcut lived as a hand-rolled `case` in a window
 * keydown switch inside ChatApp. That made them undiscoverable, impossible to
 * remap, and easy to let drift out of sync with the command palette. This
 * module centralizes the command list, the chord encoding, and the
 * default→override resolution so a single editor window can drive them all.
 *
 * Persistence: user overrides live in `~/.codiby/keybindings.json` (only the
 * deltas — defaults stay in code here), read/written through the bridge's
 * `/keybindings` endpoint and broadcast to every window over the websocket.
 *
 * Scope: this owns *command-style* shortcuts (one chord → fire one action).
 * Stateful interaction modes — the Ctrl+Tab session switcher and the Shift+Tab
 * permission-mode cycle — keep their own dedicated handlers in ChatApp and are
 * intentionally not part of the rebindable set. Monaco's in-editor actions
 * (Reference in Chat, Fix with AI) are owned by Monaco's own keybinding API.
 */

/** The conditions a command's binding can be gated on. `'always'` is app-wide;
 *  the rest map to a boolean flag supplied at match time via {@link CommandContext}. */
export type WhenCondition = 'always' | 'terminalsFocused';

/** Runtime flags the active keydown handler feeds to {@link matchCommand} so
 *  condition-gated commands (e.g. `terminalsFocused`) only fire in context. */
export interface CommandContext {
  terminalsFocused?: boolean;
}

export interface CommandDef {
  /** Stable id — used as the key in the overrides file and the handler map. */
  id: string;
  title: string;
  /** Grouping shown as the secondary line in the Action column. */
  category: string;
  /** Condition gating when the binding may fire (also shown in the editor's
   *  Condition column). `'always'` fires app-wide; `'terminalsFocused'` only
   *  fires while keyboard focus is inside the terminals dock. Unknown values
   *  are treated as `'always'` (display-only) so the table stays forgiving. */
  when: WhenCondition;
  /** Canonical default chord (e.g. `'mod+k'`), or null for "unbound by
   *  default — bindable by the user". */
  defaultChord: string | null;
}

/** A user override map: command id → chord, or null to force-unbind a command
 *  that has a non-null default. Absent keys fall back to the default. */
export type KeybindingOverrides = Record<string, string | null>;

/**
 * The rebindable command set. `mod` collapses Cmd (macOS) and Ctrl
 * (Windows/Linux) into one token, matching how the app has always fired these
 * (metaKey || ctrlKey). Modifier order in a canonical chord is fixed:
 * `mod` → `alt` → `shift` → key.
 */
export const COMMANDS: CommandDef[] = [
  { id: 'command-palette',  title: 'Command Palette',      category: 'Navigation', when: 'always', defaultChord: 'mod+k' },
  { id: 'toggle-explorer',  title: 'Toggle File Explorer', category: 'Navigation', when: 'always', defaultChord: 'mod+b' },
  { id: 'toggle-terminals', title: 'Toggle Terminals',     category: 'Navigation', when: 'always', defaultChord: 'mod+j' },
  { id: 'new-terminal',     title: 'New Terminal',         category: 'Terminal',   when: 'terminalsFocused', defaultChord: 'mod+t' },
  { id: 'focus-chat-input', title: 'Focus Chat Input',     category: 'Navigation', when: 'always', defaultChord: 'mod+l' },
  { id: 'find-in-chat',     title: 'Find in Chat',         category: 'Chat',       when: 'always', defaultChord: 'mod+f' },
  { id: 'search-files',     title: 'Search Files',         category: 'Navigation', when: 'always', defaultChord: 'mod+shift+f' },
  { id: 'save-file',        title: 'Save File',            category: 'Editor',     when: 'always', defaultChord: 'mod+s' },
  { id: 'new-file',         title: 'New File',             category: 'Editor',     when: 'always', defaultChord: 'mod+n' },
  { id: 'close-tab',        title: 'Close Editor / Tab',   category: 'Navigation', when: 'always', defaultChord: 'mod+w' },
  { id: 'new-session',      title: 'New Session',          category: 'Sessions',   when: 'always', defaultChord: null },
  { id: 'clear-chat',       title: 'Clear Chat',           category: 'Session',    when: 'always', defaultChord: null },
  // Defaults mirror VS Code's activity-bar shortcuts where an equivalent view
  // exists: Files→Explorer (⇧⌘E), Changes→Source Control (⇧⌘G). The rest have
  // no VS Code counterpart, so they ship unbound and can be assigned in the UI.
  { id: 'sidebar-files',     title: 'Show Explorer Card',  category: 'Sidebar', when: 'always', defaultChord: 'mod+shift+e' },
  { id: 'sidebar-changes',   title: 'Show Changes Card',   category: 'Sidebar', when: 'always', defaultChord: 'mod+shift+g' },
  { id: 'sidebar-toolsmcp',  title: 'Show Tools & MCP Card', category: 'Sidebar', when: 'always', defaultChord: null },
  { id: 'sidebar-processes', title: 'Show Processes Card', category: 'Sidebar', when: 'always', defaultChord: null },
  { id: 'sidebar-prs',       title: 'Show Pull Requests Card', category: 'Sidebar', when: 'always', defaultChord: null },
];

const COMMAND_IDS = new Set(COMMANDS.map(c => c.id));

export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');

/** Modifier set required for a chord to be usable as a global shortcut. A bare
 *  key (or shift-only) would fire while the user is just typing, so the editor
 *  rejects it. */
export function chordHasRequiredModifier(chord: string): boolean {
  const segs = chord.split('+');
  return segs.includes('mod') || segs.includes('alt');
}

/** Normalize a KeyboardEvent's `key` to a chord key token, or null for a pure
 *  modifier / unusable key. */
function normalizeEventKey(e: KeyboardEvent): string | null {
  const k = e.key;
  if (!k || k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta' || k === 'CapsLock' || k === 'Dead') {
    return null;
  }
  if (k === ' ' || k === 'Spacebar') return 'space';
  if (k.length === 1) return k.toLowerCase();
  return k.toLowerCase(); // 'Tab' → 'tab', 'Enter' → 'enter', 'ArrowUp' → 'arrowup'
}

/**
 * Encode a KeyboardEvent into a canonical chord string, or null if the event
 * is a modifier-only press. Cmd and Ctrl both map to `mod` so a macOS user
 * pressing ⌘ and a Windows user pressing Ctrl record (and trigger) the same
 * binding.
 */
export function eventToChord(e: KeyboardEvent): string | null {
  const key = normalizeEventKey(e);
  if (!key) return null;
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

const KEY_LABELS: Record<string, string> = {
  tab: 'Tab', enter: 'Enter', escape: 'Esc', space: 'Space',
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
  backspace: '⌫', delete: 'Del', '.': '.', ',': ',', '/': '/', '\\': '\\',
};

/** Break a canonical chord into display tokens (e.g. ['⌘','⇧','F'] on macOS,
 *  ['Ctrl','Shift','F'] elsewhere), suitable for rendering as <kbd> chips. */
export function chordTokens(chord: string): string[] {
  return chord.split('+').map(seg => {
    if (seg === 'mod') return isMac ? '⌘' : 'Ctrl';
    if (seg === 'shift') return isMac ? '⇧' : 'Shift';
    if (seg === 'alt') return isMac ? '⌥' : 'Alt';
    return KEY_LABELS[seg] || (seg.length === 1 ? seg.toUpperCase() : seg.charAt(0).toUpperCase() + seg.slice(1));
  });
}

/** Resolve the effective binding for every command: default unless the user
 *  has an override (a chord string, or null to force-unbind). */
export function resolveBindings(overrides: KeybindingOverrides): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  for (const c of COMMANDS) map[c.id] = c.defaultChord;
  for (const [id, chord] of Object.entries(overrides)) {
    if (COMMAND_IDS.has(id)) map[id] = chord;
  }
  return map;
}

/** Whether a command's `when` condition is satisfied by the current context.
 *  Unknown conditions fall back to always-on so display-only labels never
 *  silently swallow a binding. */
export function whenSatisfied(when: WhenCondition, ctx: CommandContext): boolean {
  switch (when) {
    case 'terminalsFocused':
      return !!ctx.terminalsFocused;
    case 'always':
    default:
      return true;
  }
}

/** Human-readable label for a command's `when` condition, used by the editor's
 *  Condition column. */
export function whenLabel(when: WhenCondition): string {
  switch (when) {
    case 'terminalsFocused':
      return 'Terminal focused';
    default:
      return when;
  }
}

/** Find which command (if any) a KeyboardEvent triggers, given resolved
 *  bindings and the current runtime context. A command whose `when` condition
 *  isn't satisfied is skipped, so the same chord can drive different commands
 *  in different contexts. Returns the command id or null. */
export function matchCommand(
  e: KeyboardEvent,
  bindings: Record<string, string | null>,
  ctx: CommandContext = {},
): string | null {
  const chord = eventToChord(e);
  if (!chord) return null;
  for (const c of COMMANDS) {
    if (bindings[c.id] && bindings[c.id] === chord && whenSatisfied(c.when, ctx)) return c.id;
  }
  return null;
}

/** The command currently bound to `chord`, excluding `exceptId` — used to warn
 *  about (and block) duplicate assignments in the editor. */
export function findConflict(
  chord: string,
  bindings: Record<string, string | null>,
  exceptId: string,
): CommandDef | null {
  for (const c of COMMANDS) {
    if (c.id !== exceptId && bindings[c.id] === chord) return c;
  }
  return null;
}

/**
 * Apply a new binding for `commandId` into an overrides map and return the next
 * map (immutably). Keeps the persisted file minimal:
 *  - chord equal to the command's default → drop the override entirely
 *  - chord === '' (explicit unbind) → store null, unless the default is already
 *    null, in which case drop the key
 *  - otherwise store the chord string
 */
export function applyOverride(
  overrides: KeybindingOverrides,
  commandId: string,
  chord: string | null,
): KeybindingOverrides {
  const cmd = COMMANDS.find(c => c.id === commandId);
  if (!cmd) return overrides;
  const next = { ...overrides };
  if (chord === null || chord === '') {
    // explicit unbind
    if (cmd.defaultChord === null) delete next[commandId];
    else next[commandId] = null;
  } else if (chord === cmd.defaultChord) {
    delete next[commandId];
  } else {
    next[commandId] = chord;
  }
  return next;
}
