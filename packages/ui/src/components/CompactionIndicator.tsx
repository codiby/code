import { LoaderCircle } from 'lucide-react';

export function CompactionIndicator({ active }: { active: boolean }) {
  if (!active) return null;
  return <div role="status" aria-live="polite" className="relative z-10 flex items-center gap-2 px-3 py-2 text-xs text-violet-300">
    <LoaderCircle size={14} className="animate-spin shrink-0" aria-hidden="true" />
    <span>Compacting history… <span className="text-zinc-500">Preparing context to continue.</span></span>
  </div>;
}
