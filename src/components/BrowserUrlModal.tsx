import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Globe, X } from 'lucide-react';
import { Button } from '@heroui/react';

interface Props {
  open: boolean;
  initialUrl?: string;
  onCancel: () => void;
  onConfirm: (url: string) => void;
}

/**
 * URL-entry modal for the "Open Browser…" command-palette action.
 *
 * Replaces a `window.prompt(...)` call — Chromium disabled `prompt()` in
 * Electron in 2021, and Tauri's WKWebView host doesn't wire up
 * `runJavaScriptTextInputPanelWithPrompt` either. Either way `prompt()`
 * returned `null` immediately and the action silently no-op'd.
 */
export function BrowserUrlModal({ open, initialUrl, onCancel, onConfirm }: Props) {
  const [value, setValue] = useState(initialUrl ?? 'https://');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset the value to the initial URL each time the modal opens (so a
  // cancelled session doesn't bleed a half-typed URL into the next one).
  // Focus + select on the next frame so the user can immediately type to
  // replace, or arrow-edit to tweak the scheme.
  useEffect(() => {
    if (!open) return;
    setValue(initialUrl ?? 'https://');
    const handle = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(handle);
  }, [open, initialUrl]);

  // Escape closes the modal globally — `onKeyDown` on the input only
  // catches keys while the input has focus, which it does in the happy
  // path but not if the user tabs out.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
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

        <div className="px-5 py-4 space-y-2">
          <label htmlFor="browser-url-input" className="block text-[11px] uppercase tracking-wide text-zinc-500">
            URL
          </label>
          <input
            id="browser-url-input"
            ref={inputRef}
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

        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2 shrink-0">
          <Button size="sm" variant="ghost" onPress={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            type="submit"
            isDisabled={!value.trim()}
            className="bg-sky-500 text-white hover:bg-sky-400 font-medium"
          >
            Open
          </Button>
        </div>
      </form>
    </div>
  );
}
