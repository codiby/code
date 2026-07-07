/**
 * Keyboard Shortcuts editor — a VSCode-style window listing every rebindable
 * global command with its Action, Condition, and Shortcut. Recording a new
 * chord, detecting conflicts, unbinding, and resetting are all handled here;
 * persistence is delegated to the parent via `onChange` (which writes the full
 * override map to `~/.codiby/keybindings.json` through the bridge).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  COMMANDS,
  resolveBindings,
  chordTokens,
  eventToChord,
  findConflict,
  applyOverride,
  chordHasRequiredModifier,
  whenLabel,
  type KeybindingOverrides,
} from '../lib/keybindings';

interface Props {
  open: boolean;
  onClose: () => void;
  overrides: KeybindingOverrides;
  /** Receives the full next override map; the parent persists + broadcasts. */
  onChange: (next: KeybindingOverrides) => void;
}

/** Render a chord as a row of <kbd> chips with `+` separators. */
function Keys({ chord }: { chord: string }) {
  const tokens = chordTokens(chord);
  return (
    <span className="inline-flex items-center gap-1">
      {tokens.map((t, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-[10px] text-zinc-600">+</span>}
          <kbd className="font-mono text-[11px] leading-none bg-surface-lighter border border-border-light border-b-2 rounded-[5px] px-[7px] py-1 text-zinc-200 min-w-[20px] text-center">
            {t}
          </kbd>
        </span>
      ))}
    </span>
  );
}

type Recording = { id: string; chord: string | null }; // chord: null=waiting, ''=unbind

export function KeyboardShortcutsModal({ open, onClose, overrides, onChange }: Props) {
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState<Recording | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const bindings = useMemo(() => resolveBindings(overrides), [overrides]);

  // Conflict for the in-progress capture (if any captured, modifier-bearing chord).
  const conflict = useMemo(() => {
    if (!recording || !recording.chord) return null;
    return findConflict(recording.chord, bindings, recording.id);
  }, [recording, bindings]);

  // Esc closes the modal — but only when not mid-capture (capture owns Esc to
  // cancel itself). Backdrop click also closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !recording) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, recording, onClose]);

  // Reset transient UI state whenever the window is dismissed.
  useEffect(() => {
    if (!open) { setRecording(null); setQuery(''); }
  }, [open]);

  // Capture listener — active only while recording a row. Runs in the capture
  // phase and stops the event so global shortcuts don't fire while the user is
  // assigning a new combo.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const bare = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
      if (bare && e.key === 'Escape') { setRecording(null); return; }
      if (bare && e.key === 'Enter') { commit(); return; }
      if (bare && (e.key === 'Backspace' || e.key === 'Delete')) {
        setRecording(r => (r ? { ...r, chord: '' } : r));
        return;
      }
      const chord = eventToChord(e);
      if (chord) setRecording(r => (r ? { ...r, chord } : r));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // commit reads the latest `recording` via the closure recreated each change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, bindings]);

  const startRecording = (id: string) => setRecording({ id, chord: null });

  const commit = () => {
    setRecording(cur => {
      if (!cur) return null;
      if (cur.chord === null) return cur;            // nothing captured yet — keep waiting
      if (cur.chord === '') {                        // explicit unbind
        onChange(applyOverride(overrides, cur.id, ''));
        return null;
      }
      if (!chordHasRequiredModifier(cur.chord)) return cur; // needs ⌘/⌥ — keep waiting
      if (findConflict(cur.chord, bindings, cur.id)) return cur; // blocked on conflict
      onChange(applyOverride(overrides, cur.id, cur.chord));
      return null;
    });
  };

  const resetOne = (id: string) => {
    if (!(id in overrides)) return;
    const next = { ...overrides };
    delete next[id];
    onChange(next);
  };

  const resetAll = () => onChange({});

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COMMANDS;
    return COMMANDS.filter(c => {
      const chord = bindings[c.id];
      const hay = [
        c.title, c.category, c.when, whenLabel(c.when),
        chord ? chordTokens(chord).join(' ') : '',
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [query, bindings]);

  if (!open) return null;

  const overrideCount = Object.keys(overrides).length;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-[920px] h-full max-h-[600px] bg-surface border border-border rounded-[10px] shadow-[0_20px_60px_rgba(0,0,0,0.55)] flex flex-col overflow-hidden"
      >
        {/* Titlebar */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <h1 className="text-[13px] font-semibold tracking-[0.2px] text-zinc-100">Keyboard Shortcuts</h1>
          <span className="text-[11px] text-zinc-600 ml-1">{COMMANDS.length} commands</span>
          <button
            className="ml-auto w-[22px] h-[22px] grid place-items-center rounded-[5px] text-zinc-600 hover:bg-surface-lighter hover:text-zinc-200 transition-colors"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 bg-base border border-border-light rounded-md px-[10px] py-[7px]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-50 text-zinc-400 shrink-0">
              <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Type to search by action, shortcut or condition…"
              className="flex-1 bg-transparent border-0 outline-none text-zinc-200 text-[12.5px] placeholder:text-zinc-600"
            />
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          <table className="w-full border-collapse">
            <colgroup>
              <col style={{ width: '38%' }} /><col style={{ width: '30%' }} /><col style={{ width: '32%' }} />
            </colgroup>
            <thead>
              <tr>
                {['Action', 'Condition', 'Shortcut'].map(h => (
                  <th
                    key={h}
                    className="sticky top-0 bg-surface text-left text-[10.5px] font-semibold tracking-[0.6px] uppercase text-zinc-600 px-4 py-[9px] border-b border-border z-[2]"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(cmd => {
                const chord = bindings[cmd.id];
                const isEditing = recording?.id === cmd.id;
                const overridden = cmd.id in overrides;
                return (
                  <tr
                    key={cmd.id}
                    className={`group border-b border-border/50 ${isEditing ? 'bg-blue-500/[0.08] shadow-[inset_2px_0_0_var(--color-blue,#3b82f6)]' : 'hover:bg-surface-light'}`}
                  >
                    {/* Action */}
                    <td className="px-4 py-2 align-middle">
                      <div className="text-[13px] font-medium text-zinc-200 leading-[1.3]">{cmd.title}</div>
                      <div className="mt-[2px] text-[10px] tracking-[0.5px] uppercase text-zinc-600">{cmd.category}</div>
                    </td>

                    {/* Condition */}
                    <td className="px-4 py-2 align-middle">
                      {cmd.when === 'always'
                        ? <span className="text-[11.5px] italic text-zinc-600">always</span>
                        : <span className="text-[11.5px] text-zinc-400">{whenLabel(cmd.when)}</span>}
                    </td>

                    {/* Shortcut */}
                    <td className="px-4 py-2 align-middle">
                      {isEditing ? (
                        <div className="flex flex-col gap-[6px] w-full">
                          <div className="flex items-center gap-[7px] min-h-[32px] bg-base border border-blue-500 rounded-[7px] px-[10px] py-[6px] shadow-[0_0_0_3px_rgba(59,130,246,0.16)]">
                            <span className="flex-1">
                              {recording!.chord === '' ? (
                                <span className="text-[11.5px] italic text-zinc-500">No binding</span>
                              ) : recording!.chord ? (
                                <Keys chord={recording!.chord} />
                              ) : (
                                <span className="text-[11.5px] text-zinc-500">Press a key combination…</span>
                              )}
                            </span>
                            <span className="w-[2px] h-[15px] rounded-[1px] bg-blue-500 animate-pulse" />
                          </div>
                          <div className="flex items-center gap-[14px] text-[10.5px] text-zinc-600 pl-[2px]">
                            <span className="inline-flex items-center gap-[5px]"><kbd className="px-[5px] py-[2px] text-[9.5px] bg-surface border border-border-light rounded text-zinc-400">↵</kbd> save</span>
                            <span className="inline-flex items-center gap-[5px]"><kbd className="px-[5px] py-[2px] text-[9.5px] bg-surface border border-border-light rounded text-zinc-400">esc</kbd> cancel</span>
                            <span className="inline-flex items-center gap-[5px]"><kbd className="px-[5px] py-[2px] text-[9.5px] bg-surface border border-border-light rounded text-zinc-400">⌫</kbd> unbind</span>
                            {conflict ? (
                              <span className="ml-auto text-red-400">in use by “{conflict.title}”</span>
                            ) : recording!.chord && !chordHasRequiredModifier(recording!.chord) ? (
                              <span className="ml-auto text-amber-400">add ⌘ or ⌥</span>
                            ) : recording!.chord && recording!.chord !== '' ? (
                              <span className="ml-auto text-green-400 inline-flex items-center gap-[5px]"><span className="w-[6px] h-[6px] rounded-full bg-green-400 inline-block" />available</span>
                            ) : null}
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between gap-2">
                          <button
                            className="text-left"
                            onClick={() => startRecording(cmd.id)}
                            title="Click to change"
                          >
                            {chord
                              ? <Keys chord={chord} />
                              : <span className="text-[11.5px] italic text-zinc-600 hover:text-zinc-400">Unbound — click to add</span>}
                          </button>
                          <div className="flex items-center gap-[6px] opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              className="w-6 h-6 grid place-items-center rounded-[5px] text-zinc-600 hover:bg-surface-lighter hover:text-zinc-200"
                              onClick={() => startRecording(cmd.id)}
                              title="Edit"
                            >
                              ✎
                            </button>
                            {overridden && (
                              <button
                                className="w-6 h-6 grid place-items-center rounded-[5px] text-zinc-600 hover:bg-surface-lighter hover:text-zinc-200"
                                onClick={() => resetOne(cmd.id)}
                                title="Reset to default"
                              >
                                ↺
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={3} className="px-4 py-8 text-center text-[12px] text-zinc-600">No commands match “{query}”.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-4 py-[10px] border-t border-border text-[11px] text-zinc-600">
          <span className="bg-surface-lighter border border-border rounded px-[6px] py-[2px] text-zinc-400">
            Stored in <span className="font-mono">~/.codiby/keybindings.json</span>
          </span>
          <span className="flex-1" />
          {overrideCount > 0 && <span>{overrideCount} customized</span>}
          <button
            className="text-zinc-400 hover:text-zinc-200 disabled:opacity-40 disabled:hover:text-zinc-400"
            onClick={resetAll}
            disabled={overrideCount === 0}
          >
            Reset all to defaults
          </button>
        </div>
      </div>
    </div>
  );
}
