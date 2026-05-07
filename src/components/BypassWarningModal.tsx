import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

const STORAGE_KEY = 'claude-ui-bypass-warning-acknowledged';

export function shouldWarnBypass(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) !== '1'; }
  catch { return true; }
}

export function setBypassWarningAcknowledged(): void {
  try { localStorage.setItem(STORAGE_KEY, '1'); } catch {}
}

interface Props {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function BypassWarningModal({ open, onCancel, onConfirm }: Props) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  useEffect(() => {
    if (open) setDontShowAgain(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const handleConfirm = () => {
    if (dontShowAgain) setBypassWarningAcknowledged();
    onConfirm();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="bypass-warning-title"
    >
      <div
        className="bg-surface border border-amber-500/40 rounded-xl shadow-2xl flex flex-col overflow-hidden w-full"
        style={{ maxWidth: 460 }}
      >
        <div className="px-5 py-3 border-b border-border flex items-start justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-amber-400 shrink-0" />
            <h2 id="bypass-warning-title" className="text-sm font-semibold text-zinc-100">
              Enable Bypass Permissions?
            </h2>
          </div>
          <button
            type="button"
            className="text-zinc-500 hover:text-zinc-300"
            onClick={onCancel}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3 text-[13px] text-zinc-300 leading-relaxed">
          <p>
            Bypass mode <span className="text-amber-300 font-medium">auto-approves every tool call</span>{' '}
            for this session — including file edits, shell commands, and network requests — without
            asking you first.
          </p>
          <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 space-y-1.5 text-[12px]">
            <div className="font-medium text-amber-200">The agent will be able to:</div>
            <ul className="list-disc list-inside space-y-0.5 text-amber-100/90">
              <li>Modify or delete files anywhere it has access</li>
              <li>Run arbitrary shell commands (including <code className="font-mono">rm</code>, <code className="font-mono">curl</code>, <code className="font-mono">git push</code>)</li>
              <li>Reach external services and exfiltrate data</li>
            </ul>
          </div>
          <p className="text-zinc-400 text-[12px]">
            Only enable this in trusted sandboxes (e.g. a worktree, container, or VM) where mistakes
            are cheap to undo.
          </p>

          <label className="flex items-center gap-2 pt-1 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
              className="w-3.5 h-3.5 accent-amber-500"
            />
            <span className="text-[12px] text-zinc-400">Don&apos;t show this warning again</span>
          </label>
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 px-3 rounded-md text-[13px] text-zinc-300 hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="h-8 px-3 rounded-md text-[13px] font-medium bg-amber-500 text-black hover:bg-amber-400"
          >
            Enable Bypass
          </button>
        </div>
      </div>
    </div>
  );
}
