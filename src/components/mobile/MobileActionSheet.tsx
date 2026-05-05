import { Image as ImageIcon, LayoutGrid, Mic, Plus, Terminal, type LucideIcon } from 'lucide-react';
import { Drawer, ListBox, ListBoxItem, Select, SelectPopover, SelectTrigger, SelectValue } from '@heroui/react';

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
  sessionName?: string;
  model?: string | null;
  modelOptions?: Array<{ id: string; label: string }>;
  onModelChange?: (model: string | null) => void;
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
export function MobileActionSheet({ open, onClose, onAction, sessionName, model, modelOptions = [], onModelChange }: Props) {
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
              {sessionName && onModelChange && (
                <div className="mb-4 rounded-2xl bg-zinc-900/55 border border-white/10 px-3 py-3">
                  <label className="flex items-center gap-3 min-w-0">
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-0.5">Model</div>
                      <div className="text-[12px] text-zinc-300 truncate">{sessionName}</div>
                    </div>
                    <Select
                      aria-label={`Model for ${sessionName}`}
                      selectedKey={model || 'default'}
                      onSelectionChange={(key) => onModelChange(key === 'default' ? null : String(key))}
                      className="shrink-0 w-44"
                    >
                      <SelectTrigger className="min-h-0 h-9 py-0 px-2.5 rounded-lg bg-white/5 border border-white/10 text-[13px] text-zinc-200 shadow-none">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopover>
                        <ListBox>
                          <ListBoxItem key="default" id="default" textValue="Default">
                            <span className="text-xs">Default</span>
                          </ListBoxItem>
                          {modelOptions.map((m) => (
                            <ListBoxItem key={m.id} id={m.id} textValue={m.label}>
                              <span className="text-xs">{m.label}</span>
                            </ListBoxItem>
                          ))}
                        </ListBox>
                      </SelectPopover>
                    </Select>
                  </label>
                </div>
              )}
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
