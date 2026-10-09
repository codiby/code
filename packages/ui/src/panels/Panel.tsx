/**
 * A single leaf panel: a tab strip on top, the active tab's content below.
 * Tabs are moved between panels via the split buttons (which peel the active
 * tab into a new sibling panel, row/col) and the store's tab ops — there is no
 * drag-and-drop here.
 */
import type { ReactNode } from 'react';
import type { PanelNode, Tab } from './types';
import { langColor } from '../lib/lang-color';

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
  /** Double-click a tab pill. The caller decides what it means (pin a preview
   *  tab, or maximize this panel when the tab is already permanent). */
  onDoubleClickTab?: (tabId: string) => void;
  /** Host-rendered actions pinned to the right of this panel's tab strip
   *  (e.g. the session Resources chip on the chat panel). */
  renderTabBarExtra?: (node: PanelNode) => ReactNode;
}

/** One tab in a strip. Also used by the standalone editor so both strips match. */
export function TabPill({
  tab, active, focused, onActivate, onClose, onDoubleClick,
}: { tab: Tab; active: boolean; focused: boolean; onActivate: () => void; onClose: () => void; onDoubleClick?: () => void }) {
  // File tabs get a language-colored dot; the rest keep their glyph, muted so
  // the strip stays quiet. Only the active tab is underlined — brighter when
  // its panel holds focus.
  const isFile = tab.kind === 'editor' || tab.kind === 'diff';
  return (
    <div
      onMouseDown={onActivate}
      onDoubleClick={onDoubleClick}
      className={`group relative flex items-center gap-1.5 h-full px-2.5 text-[12px] whitespace-nowrap cursor-default select-none transition-colors ${
        active
          ? `text-zinc-100 after:content-[''] after:absolute after:left-2.5 after:right-2.5 after:bottom-0 after:h-[2px] after:rounded-full ${focused ? 'after:bg-zinc-100' : 'after:bg-zinc-500'}`
          : 'text-zinc-500 hover:text-zinc-200'
      }`}
      title={tab.title}
    >
      {isFile
        ? <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: langColor(tab.title) }} />
        : tab.icon && <span className="text-[11px] leading-none grayscale opacity-70">{tab.icon}</span>}
      <span className={`truncate max-w-[160px] ${tab.preview ? 'italic' : ''} ${tab.deleted ? 'line-through opacity-60' : ''}`}>{tab.title}</span>
      {tab.badge && (
        <span className="shrink-0 rounded border border-[#d97757]/30 px-1 text-[10px] leading-[14px] text-[#d97757]">{tab.badge}</span>
      )}
      {tab.closable !== false ? (
        <span
          role="button"
          tabIndex={-1}
          aria-label={`Close ${tab.title}`}
          onMouseDown={(e) => { e.stopPropagation(); }}
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="relative -mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[13px] leading-none text-zinc-500 hover:bg-surface-lighter hover:text-zinc-100 cursor-pointer"
        >
          {/* Dirty dot doubles as the close button: it turns into × on hover. */}
          {tab.dirty && <span className="absolute h-1.5 w-1.5 rounded-full bg-zinc-300 group-hover:opacity-0" />}
          <span className={tab.dirty ? 'opacity-0 group-hover:opacity-100' : active ? '' : 'opacity-0 group-hover:opacity-100'}>×</span>
        </span>
      ) : tab.dirty ? (
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-300 shrink-0" />
      ) : null}
    </div>
  );
}

export function Panel({ node, tabs, focused, renderTab, onActivate, onClose, onFocus, onSplit, onDoubleClickTab, renderTabBarExtra }: PanelProps) {
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
  // A lone, non-closable tab (the Chat panel / group composer) draws a pill
  // that just labels the panel with itself — a redundant "Chat" tab that reads
  // as a stray, misaligned chip. Suppress the pill in that case; the header bar
  // still renders for the Resources chip and split controls.
  const hidePills = orderedTabs.length === 1 && orderedTabs[0]?.closable === false;

  // The focus outline is blue always, brighter when this panel holds focus and
  // fainter when it doesn't — so it reads as "active" without going invisible.
  const edge = focused ? 'border-blue-500/60' : 'border-blue-500/25';

  // Split / Resources controls shared by both layouts (pill-less chat panel and
  // the Chrome/Edge tabbed panel).
  const barExtras = (
    <>
      <div className="flex-1" />
      {renderTabBarExtra && (
        <div className="flex items-center shrink-0 mr-0.5" onMouseDown={(e) => e.stopPropagation()}>
          {renderTabBarExtra(node)}
        </div>
      )}
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
    </>
  );

  const body = (
    activeTab ? renderTab(activeTab) : (
      <div className="h-full flex items-center justify-center text-[12px] text-zinc-600">Empty panel</div>
    )
  );

  // Chat / group-composer panel: a lone non-closable tab draws no pill, so there
  // is nothing to wrap — keep the classic closed rounded frame.
  if (hidePills) {
    return (
      <div
        onMouseDownCapture={onFocus}
        className={`flex flex-col min-w-0 min-h-0 h-full w-full rounded-lg overflow-hidden bg-base border ${edge}`}
      >
        <div className="flex items-stretch h-[32px] shrink-0 px-1 gap-0.5 border-b border-border bg-surface">
          {barExtras}
        </div>
        <div className="flex-1 min-h-0 min-w-0 relative">{body}</div>
      </div>
    );
  }

  // Underline tabs: one rounded frame holds the strip and the body; the strip
  // sits on the surface with a hairline below it, and the active tab is just
  // brighter text plus a 2px underline resting on that hairline.
  return (
    <div
      onMouseDownCapture={onFocus}
      className={`flex flex-col min-w-0 min-h-0 h-full w-full rounded-lg overflow-hidden bg-surface border ${edge}`}
    >
      <div className="flex items-stretch h-[32px] shrink-0 px-1 gap-0.5 border-b border-border bg-surface">
        {/* Tabs truncate (max-w) instead of scrolling. */}
        <div className="flex items-stretch min-w-0">
          {orderedTabs.map((t) => (
            <TabPill
              key={t.id}
              tab={t}
              active={t.id === activeTabId}
              focused={focused}
              onActivate={() => onActivate(t.id)}
              onClose={() => onClose(t)}
              onDoubleClick={onDoubleClickTab ? () => onDoubleClickTab(t.id) : undefined}
            />
          ))}
        </div>
        {barExtras}
      </div>

      <div className="flex-1 min-h-0 min-w-0 relative">
        {body}
      </div>
    </div>
  );
}
