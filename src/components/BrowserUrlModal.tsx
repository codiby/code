import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Globe, X } from 'lucide-react';
import { Button } from '@heroui/react';

interface Props {
  open: boolean;
  initialName?: string;
  initialUrl?: string;
  onCancel: () => void;
  onConfirm: (name: string, url: string) => void;
}

/**
 * Name + URL entry modal for the "Open Browser…" command-palette action.
 *
 * Replaces a `window.prompt(...)` call — Chromium disabled `prompt()` in
 * Electron in 2021, and Tauri's WKWebView host doesn't wire up
 * `runJavaScriptTextInputPanelWithPrompt` either. Either way `prompt()`
 * returned `null` immediately and the action silently no-op'd.
 *
 * The `name` field exists because every browser preview is keyed by a
 * stable kebab/snake-case identifier (e.g. "qa-admin-workflow") so a
 * single session can hold multiple browsers side-by-side. Validation
 * mirrors the bridge-side `sanitizeBrowserName` (letters/digits/dash/
 * underscore, 1–40 chars, must start with letter or digit).
 */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;

export function BrowserUrlModal({ open, initialName, initialUrl, onCancel, onConfirm }: Props) {
  const [name, setName] = useState(initialName ?? '');
  const [value, setValue] = useState(initialUrl ?? 'https://');
  const nameRef = useRef<HTMLInputElement | null>(null);
  const urlRef = useRef<HTMLInputElement | null>(null);

  // Reset on every open so a cancelled session doesn't bleed a half-typed
  // name/URL into the next attempt. Focus the name field first since
  // that's the new required input — URL has a sensible default already.
  useEffect(() => {
    if (!open) return;
    setName(initialName ?? '');
    setValue(initialUrl ?? 'https://');
    const handle = requestAnimationFrame(() => {
      const el = nameRef.current;
      el?.focus();
      el?.select();
    });
    return () => cancelAnimationFrame(handle);
  }, [open, initialName, initialUrl]);

  // Escape closes the modal globally — `onKeyDown` on a field only fires
  // while that field has focus.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const trimmedName = name.trim();
  const trimmedUrl = value.trim();
  const nameValid = trimmedName.length > 0 && NAME_RE.test(trimmedName);
  const canSubmit = nameValid && trimmedUrl.length > 0;

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    onConfirm(trimmedName, trimmedUrl);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="browser-url-title"
    >
      <form
        onSubmit={handleSubmit}
        className="bg-surface border border-sky-500/40 rounded-xl shadow-2xl flex flex-col overflow-hidden w-full"
        style={{ maxWidth: 460 }}
      >
        <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <Globe size={16} className="text-sky-300 shrink-0" />
            <h2 id="browser-url-title" className="text-sm font-semibold text-zinc-100">
              Open in browser preview
            </h2>
          </div>
          <Button isIconOnly size="sm" variant="ghost" onPress={onCancel} aria-label="Close">
            <X size={16} />
          </Button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="browser-name-input" className="block text-[11px] uppercase tracking-wide text-zinc-500">
              Name
            </label>
            <input
              id="browser-name-input"
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="qa-admin-workflow"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); urlRef.current?.focus(); urlRef.current?.select(); } }}
              className="w-full bg-[#0f172a]/60 text-[13px] font-mono text-zinc-100 rounded px-3 py-2 border border-border focus:border-sky-500/60 focus:outline-none placeholder:text-zinc-600"
            />
            <p className={`text-[11px] ${trimmedName && !nameValid ? 'text-amber-400' : 'text-zinc-500'}`}>
              {trimmedName && !nameValid
                ? 'Letters/digits/dash/underscore only, 1–40 chars, must start with a letter or digit.'
                : 'Stable identifier — reuse it to drive the same browser later.'}
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="browser-url-input" className="block text-[11px] uppercase tracking-wide text-zinc-500">
              URL
            </label>
            <input
              id="browser-url-input"
              ref={urlRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="https://…"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="w-full bg-[#0f172a]/60 text-[13px] font-mono text-zinc-100 rounded px-3 py-2 border border-border focus:border-sky-500/60 focus:outline-none placeholder:text-zinc-600"
            />
            <p className="text-[11px] text-zinc-500">
              Bare hosts get <code className="font-mono text-zinc-400">https://</code> unless they look local
              (<code className="font-mono text-zinc-400">localhost</code>, <code className="font-mono text-zinc-400">*.local</code>, RFC1918), in which case <code className="font-mono text-zinc-400">http://</code>.
            </p>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2 shrink-0">
          <Button size="sm" variant="ghost" onPress={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            type="submit"
            isDisabled={!canSubmit}
            className="bg-sky-500 text-white hover:bg-sky-400 font-medium"
          >
            Open
          </Button>
        </div>
      </form>
    </div>
  );
}
