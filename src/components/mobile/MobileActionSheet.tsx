import { Image as ImageIcon, LayoutGrid, Mic, Plus, Terminal, type LucideIcon } from 'lucide-react';
import { Drawer } from '@heroui/react';

export type ActionSheetId =
  | 'new-terminal'
  | 'run-command'
  | 'attach-image'
  | 'voice-note'
  | 'new-session';

interface Props {
  open: boolean;
  onClose: () => void;
  onAction: (id: ActionSheetId) => void;
}

interface Tile {
  id: ActionSheetId;
  label: string;
  icon: LucideIcon;
}

const TILES: Tile[] = [
  { id: 'new-terminal', label: 'New terminal', icon: Terminal },
  { id: 'run-command', label: 'Run command', icon: LayoutGrid },
  { id: 'attach-image', label: 'Attach', icon: ImageIcon },
  { id: 'voice-note', label: 'Voice note', icon: Mic },
  { id: 'new-session', label: 'New session', icon: Plus },
];

/**
 * Draggable bottom sheet opened from the dock pill above the mobile composer.
 * Tiles are shortcuts to existing composer affordances — tapping one fires
 * `onAction(id)` and dismisses. Built on HeroUI's `Drawer` so swipe-down /
 * backdrop tap dismiss come for free.
 */
export function MobileActionSheet({ open, onClose, onAction }: Props) {
  return (
    <Drawer isOpen={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <Drawer.Backdrop variant="blur">
        <Drawer.Content placement="bottom">
          <Drawer.Dialog
            className="!bg-zinc-950/95 !p-4 border-t border-white/10"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}
          >
            <Drawer.Handle />
            <Drawer.Body className="!overflow-visible">
              <div className="grid grid-cols-4 gap-3 pt-2">
                {TILES.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => { onAction(id); onClose(); }}
                    className="aspect-square flex flex-col items-center justify-center gap-2 rounded-2xl bg-zinc-900/55 border border-white/10 text-zinc-200 active:bg-zinc-900/85"
                    style={{
                      backdropFilter: 'blur(28px) saturate(180%)',
                      WebkitBackdropFilter: 'blur(28px) saturate(180%)',
                    }}
                  >
                    <Icon size={26} className="text-zinc-100" strokeWidth={1.6} />
                    <span className="text-[11px] leading-tight text-zinc-300">{label}</span>
                  </button>
                ))}
              </div>
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}
