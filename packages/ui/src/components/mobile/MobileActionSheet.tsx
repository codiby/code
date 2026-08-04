import { Image as ImageIcon, LayoutGrid, Mic, Plus, Terminal, type LucideIcon } from 'lucide-react';
import { Button, Drawer, ListBox, ListBoxItem, Select, SelectIndicator, SelectPopover, SelectTrigger, SelectValue } from '@heroui/react';

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
  /** Provider of the active session — only Claude and OpenCode support effort. */
  provider?: string;
  /** Current reasoning-effort level ('low' … 'max'), null = default. */
  effort?: string | null;
  /** Change handler for effort. null = back to default. */
  onEffortChange?: (effort: string | null) => void;
  /** Current permission mode of the active session ('default' | 'acceptEdits' | 'plan' | 'bypassPermissions'). */
  permissionMode?: string;
  /** Change handler for permission mode. */
  onPermissionModeChange?: (mode: string) => void;
}

const EFFORT_OPTIONS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'X-High' },
  { id: 'max', label: 'Max' },
];

const PERMISSION_MODES = [
  { value: 'default', label: 'Default', desc: 'Prompt for every tool' },
  { value: 'acceptEdits', label: 'Accept edits', desc: 'Auto-approve file edits' },
  { value: 'plan', label: 'Plan', desc: 'Read-only, no writes' },
  { value: 'bypassPermissions', label: 'Bypass', desc: 'Auto-approve everything' },
];

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
export function MobileActionSheet({ open, onClose, onAction, sessionName, model, modelOptions = [], onModelChange, provider, effort, onEffortChange, permissionMode, onPermissionModeChange }: Props) {
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
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold shrink-0">Model</div>
                    <Select
                      aria-label="Model"
                      selectedKey={model || 'default'}
                      onSelectionChange={(key) => onModelChange(key === 'default' ? null : String(key))}
                      className="flex-1 min-w-0"
                    >
                      <SelectTrigger className="min-h-0 h-9 py-0 px-2.5 rounded-lg bg-white/5 border border-white/10 text-[13px] text-zinc-200 shadow-none flex items-center justify-between gap-2 w-full">
                        <SelectValue className="truncate text-left" />
                        <SelectIndicator className="shrink-0 text-zinc-400" />
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
              {sessionName && onEffortChange && ((provider ?? 'claude') === 'claude' || provider === 'opencode') && (
                <div className="mb-4 rounded-2xl bg-zinc-900/55 border border-white/10 px-3 py-3">
                  <label className="flex items-center gap-3 min-w-0">
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold shrink-0">Effort</div>
                    <Select
                      aria-label="Effort"
                      selectedKey={effort || 'default'}
                      onSelectionChange={(key) => onEffortChange(key === 'default' ? null : String(key))}
                      className="flex-1 min-w-0"
                    >
                      <SelectTrigger className="min-h-0 h-9 py-0 px-2.5 rounded-lg bg-white/5 border border-white/10 text-[13px] text-zinc-200 shadow-none flex items-center justify-between gap-2 w-full">
                        <SelectValue className="truncate text-left" />
                        <SelectIndicator className="shrink-0 text-zinc-400" />
                      </SelectTrigger>
                      <SelectPopover>
                        <ListBox>
                          <ListBoxItem key="default" id="default" textValue="Default">
                            <span className="text-xs">Default</span>
                          </ListBoxItem>
                          {EFFORT_OPTIONS.map((o) => (
                            <ListBoxItem key={o.id} id={o.id} textValue={o.label}>
                              <span className="text-xs">{o.label}</span>
                            </ListBoxItem>
                          ))}
                        </ListBox>
                      </SelectPopover>
                    </Select>
                  </label>
                </div>
              )}
              {onPermissionModeChange && (
                <div className="mb-4">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2 px-1">
                    Permission mode
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {PERMISSION_MODES.map((m) => {
                      const isActive = m.value === (permissionMode || 'default');
                      return (
                        <Button
                          key={m.value}
                          variant="ghost"
                          onPress={() => onPermissionModeChange(m.value)}
                          className={`w-full h-auto min-w-0 justify-start text-left p-2.5 rounded-xl border transition ${
                            isActive
                              ? 'bg-indigo-500/15 border-indigo-500/40'
                              : 'bg-zinc-900/55 border-white/10 active:bg-white/10'
                          }`}
                        >
                          <div className="w-full">
                            <div className="text-[13px] font-medium text-zinc-100">{m.label}</div>
                            <div className="text-[10px] text-zinc-500 mt-0.5 truncate">{m.desc}</div>
                          </div>
                        </Button>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="grid grid-cols-4 gap-3 pt-2">
                {TILES.map(({ id, label, icon: Icon }) => (
                  <Button
                    key={id}
                    variant="ghost"
                    onPress={() => { onAction(id); onClose(); }}
                    className="w-full aspect-square h-auto min-w-0 px-1! flex flex-col items-center justify-center gap-2 rounded-2xl bg-zinc-900/55 border border-white/10 text-zinc-200 active:bg-zinc-900/85"
                    style={{
                      backdropFilter: 'blur(28px) saturate(180%)',
                      WebkitBackdropFilter: 'blur(28px) saturate(180%)',
                    }}
                  >
                    <Icon size={24} className="text-zinc-100" strokeWidth={1.6} />
                    <span className="text-[10px] leading-tight text-zinc-300 truncate max-w-full">{label}</span>
                  </Button>
                ))}
              </div>
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}
