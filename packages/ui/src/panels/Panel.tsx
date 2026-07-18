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
  /** Host-rendered actions pinned to the right of this panel's tab strip
   *  (e.g. the session Resources chip on the chat panel). */
  renderTabBarExtra?: (node: PanelNode) => ReactNode;
}

function TabPill({
  tab, active, focused, onActivate, onClose, onPin,
}: { tab: Tab; active: boolean; focused: boolean; onActivate: () => void; onClose: () => void; onPin?: () => void }) {
  return (
    <div
      onMouseDown={onActivate}
      onDoubleClick={onPin}
      // Active pill: bordered on top/sides only; the ::after strip paints
      // surface-colored over the tab bar's bottom border so the pill's open
      // bottom merges into the body (Chrome/Edge style). The pseudo-element is
      // load-bearing: a -mb-px overlap alone does NOT reliably cover the strip
      // border (h-full inside a definite-height flex row + zoom rounding can
      // leave the pill flush above the border line, re-exposing the seam).
      className={`group flex items-center gap-1.5 h-full px-2.5 rounded-t-lg text-[12px] whitespace-nowrap cursor-default select-none border-b-0 ${
        active
          ? `relative z-10 -mb-px bg-surface text-zinc-100 border-t border-x after:content-[''] after:absolute after:left-0 after:right-0 after:-bottom-0.5 after:h-1 after:bg-surface ${focused ? 'border-blue-500/60' : 'border-blue-500/25'}`
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

export function Panel({ node, tabs, focused, renderTab, onActivate, onClose, onFocus, onSplit, onPin, renderTabBarExtra }: PanelProps) {
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
        className={`flex flex-col min-w-0 min-h-0 h-full w-full rounded-lg overflow-hidden bg-surface border ${edge}`}
      >
        <div className="flex items-stretch h-[28px] shrink-0 px-1 gap-0.5 border-b border-border bg-base">
          {barExtras}
        </div>
        <div className="flex-1 min-h-0 min-w-0 relative">{body}</div>
      </div>
    );
  }

  // Chrome/Edge tabs: the body is a fully rounded bordered box; the strip is a
  // borderless row floating above it. The active pill's surface-colored ::after
  // erases the body's top border underneath it, so a single continuous outline
  // runs up and around the active tab with rounded corners at all four joints.
  // Strip pl-2 (= the 8px --radius) keeps the first pill — and its ::after
  // eraser — clear of the body's top-left corner curve.
  return (
    <div
      onMouseDownCapture={onFocus}
      className="flex flex-col min-w-0 min-h-0 h-full w-full"
    >
      <div className="flex items-stretch h-[28px] shrink-0 pl-2 pr-1 gap-0.5 bg-base">
        {/* No overflow clip here: overflow-x-auto forces overflow-y to clip,
            which would shave off the active pill's 1px overhang and re-expose
            the seam under the tab. Tabs truncate (max-w) instead of scrolling. */}
        <div className="flex items-stretch gap-0.5 min-w-0">
          {orderedTabs.map((t) => (
            <TabPill
              key={t.id}
              tab={t}
              active={t.id === activeTabId}
              focused={focused}
              onActivate={() => onActivate(t.id)}
              onClose={() => onClose(t)}
              onPin={onPin ? () => onPin(t.id) : undefined}
            />
          ))}
        </div>
        {barExtras}
      </div>

      <div className={`flex-1 min-h-0 min-w-0 relative rounded-lg overflow-hidden bg-surface border ${edge}`}>
        {body}
      </div>
    </div>
  );
}
