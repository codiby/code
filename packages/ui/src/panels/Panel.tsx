/**
 * A single leaf panel: a tab strip on top, the active tab's content below.
 * Tabs are moved between panels via the split buttons (which peel the active
 * tab into a new sibling panel, row/col) and the store's tab ops — there is no
 * drag-and-drop here.
 */
import type { ReactNode } from 'react';
import type { PanelNode, Tab } from './types';

export interface PanelProps {
  node: PanelNode;
  tabs: Map<string, Tab>;
  focused: boolean;
  /** Render the live content for a tab id (host-owned). */
  renderTab: (tab: Tab) => ReactNode;
  onActivate: (tabId: string) => void;
  onClose: (tab: Tab) => void;
  onFocus: () => void;
  onSplit: (dir: 'row' | 'col') => void;
  /** Double-click a tab pill — used to pin a preview tab. */
  onPin?: (tabId: string) => void;
}

function TabPill({
  tab, active, onActivate, onClose, onPin,
}: { tab: Tab; active: boolean; onActivate: () => void; onClose: () => void; onPin?: () => void }) {
  return (
    <div
      onMouseDown={onActivate}
      onDoubleClick={onPin}
      className={`group flex items-center gap-1.5 h-full px-2.5 rounded-t-md text-[12px] whitespace-nowrap cursor-default select-none border-b-0 ${
        active
          ? 'bg-surface text-zinc-100 border border-border'
          : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
      }`}
      title={tab.title}
    >
      {tab.icon && <span className="text-[11px] leading-none opacity-80">{tab.icon}</span>}
      <span className={`truncate max-w-[160px] ${tab.preview ? 'italic' : ''} ${tab.deleted ? 'line-through opacity-60' : ''}`}>{tab.title}</span>
      {tab.dirty && <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 shrink-0" />}
      {tab.closable !== false && (
        <span
          role="button"
          tabIndex={-1}
          onMouseDown={(e) => { e.stopPropagation(); }}
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-[12px] leading-none px-0.5 cursor-pointer"
        >
          ×
        </span>
      )}
    </div>
  );
}

export function Panel({ node, tabs, focused, renderTab, onActivate, onClose, onFocus, onSplit, onPin }: PanelProps) {
  const orderedTabs = node.tabIds.map((id) => tabs.get(id)).filter((t): t is Tab => !!t);
  // Resolve the active tab against the *live* tab set, falling back to the last
  // surviving tab. When a tab is closed the host drops it from `tabs` a render
  // before the store's reconcile effect runs, so `activeTabId` briefly points
  // at a tab that no longer exists. Without this fallback the panel paints an
  // "Empty panel" frame (and the pill loses its active highlight) until the
  // effect settles — a visible flash. The fallback mirrors what `fixActives`
  // ultimately picks (the last tab id), so the content stays stable.
  const activeTab = (node.activeTabId ? tabs.get(node.activeTabId) : undefined)
    ?? orderedTabs[orderedTabs.length - 1];
  const activeTabId = activeTab?.id ?? null;
  const canSplit = node.tabIds.length > 1;

  return (
    <div
      onMouseDownCapture={onFocus}
      className={`flex flex-col min-w-0 min-h-0 h-full w-full rounded-lg overflow-hidden bg-surface border ${
        focused ? 'border-blue-500/60' : 'border-border'
      }`}
    >
      <div className="flex items-stretch h-[34px] shrink-0 px-1 gap-0.5 border-b border-border bg-base">
        <div className="flex items-stretch gap-0.5 min-w-0 overflow-x-auto no-scrollbar">
          {orderedTabs.map((t) => (
            <TabPill
              key={t.id}
              tab={t}
              active={t.id === activeTabId}
              onActivate={() => onActivate(t.id)}
              onClose={() => onClose(t)}
              onPin={onPin ? () => onPin(t.id) : undefined}
            />
          ))}
        </div>
        <div className="flex-1" />
        {canSplit && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              className="text-zinc-500 hover:text-zinc-200 px-1.5 text-[12px]"
              title="Split right (move active tab)"
              onClick={() => activeTab && onSplit('row')}
            >⬌</button>
            <button
              className="text-zinc-500 hover:text-zinc-200 px-1.5 text-[12px]"
              title="Split down (move active tab)"
              onClick={() => activeTab && onSplit('col')}
            >⬍</button>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 min-w-0 relative">
        {activeTab ? renderTab(activeTab) : (
          <div className="h-full flex items-center justify-center text-[12px] text-zinc-600">Empty panel</div>
        )}
      </div>
    </div>
  );
}
