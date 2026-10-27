import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FolderClosed, X } from 'lucide-react';
import { Button } from '@heroui/react';

interface Props {
  open: boolean;
  groupName: string;
  /** The group's folder, or empty when it has none. */
  initialPath: string;
  onCancel: () => void;
  /** `''` clears the folder. */
  onSave: (path: string) => void;
}

/**
 * Optional folder for a sidebar group. With one, "New session in group"
 * starts there straight away; without one (a group that mixes repos), it
 * opens the composer so the folder is picked each time.
 */
export function GroupFolderDialog({ open, groupName, initialPath, onCancel, onSave }: Props) {
  const [path, setPath] = useState(initialPath);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setPath(initialPath);
    const handle = requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
    return () => cancelAnimationFrame(handle);
  }, [open, initialPath]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const electron = (window as any).electronAPI || (window as any).electron;
  const canBrowse = typeof electron?.pickFolder === 'function';

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    onSave(path.trim().replace(/(.)[\\/]+$/, '$1'));
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="group-folder-title"
    >
      <form
        onSubmit={handleSubmit}
        className="bg-surface border border-border-light rounded-xl shadow-2xl flex flex-col overflow-hidden w-full"
        style={{ maxWidth: 480 }}
      >
        <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <FolderClosed size={16} className="text-zinc-400 shrink-0" />
            <h2 id="group-folder-title" className="text-sm font-semibold text-zinc-100 truncate">
              Folder for {groupName}
            </h2>
          </div>
          <Button isIconOnly size="sm" variant="ghost" onPress={onCancel} aria-label="Close">
            <X size={16} />
          </Button>
        </div>

        <div className="px-5 py-4 space-y-1.5">
          <label htmlFor="group-folder-input" className="block text-[11px] uppercase tracking-wide text-zinc-500">
            Path <span className="normal-case tracking-normal text-zinc-600">(optional)</span>
          </label>
          <div className="flex items-center gap-2">
            <input
              id="group-folder-input"
              ref={inputRef}
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="No folder"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="flex-1 min-w-0 bg-black/20 text-[13px] font-mono text-zinc-100 rounded px-3 py-2 border border-border focus:border-zinc-500 focus:outline-none placeholder:text-zinc-600"
            />
            {canBrowse && (
              <Button size="sm" variant="secondary" onPress={async () => {
                try {
                  const picked = await electron.pickFolder();
                  if (picked) setPath(picked);
                } catch { /* picker dismissed */ }
              }}>
                Browse…
              </Button>
            )}
          </div>
          <p className="text-[11px] text-zinc-500">
            New sessions in this group start here, on whichever machine has the folder.
            Leave it empty for a group that mixes folders; you'll pick one for each new session.
          </p>
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-between gap-2">
          <Button size="sm" variant="ghost" isDisabled={!path} onPress={() => setPath('')}>
            Clear
          </Button>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onPress={onCancel}>Cancel</Button>
            <Button size="sm" variant="primary" type="submit">Save</Button>
          </div>
        </div>
      </form>
    </div>
  );
}
