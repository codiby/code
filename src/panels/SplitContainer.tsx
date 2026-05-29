/**
 * Recursive renderer for the layout tree. A `panel` node renders a <Panel/>;
 * a `split` node lays its children out as a flex row/col with draggable
 * resize handles between them. Resizing mutates flex ratios live and commits
 * the final ratios to the store on pointer-up.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Panel } from './Panel';
import type { PanelsStore } from './store';
import type { LayoutNode, SplitNode, Tab } from './types';

export interface RenderCtx {
  tabs: Map<string, Tab>;
  focusedPanelId: string | null;
  store: PanelsStore;
  renderTab: (tab: Tab) => ReactNode;
  onCloseTab: (tab: Tab) => void;
  /** Set by handles so the workspace can drop a pointer-eating overlay. */
  setResizing: (v: boolean) => void;
}

export function NodeView({ node, ctx }: { node: LayoutNode; ctx: RenderCtx }) {
  if (node.type === 'panel') {
    return (
      <Panel
        node={node}
        tabs={ctx.tabs}
        focused={ctx.focusedPanelId === node.id}
        renderTab={ctx.renderTab}
        onActivate={(tabId) => ctx.store.setActiveTab(node.id, tabId)}
        onClose={(tab) => ctx.onCloseTab(tab)}
        onFocus={() => ctx.store.focusPanel(node.id)}
        onSplit={(dir) => node.activeTabId && ctx.store.splitPanelWithTab(node.id, node.activeTabId, dir)}
      />
    );
  }
  return <SplitView node={node} ctx={ctx} />;
}

function SplitView({ node, ctx }: { node: SplitNode; ctx: RenderCtx }) {
  const isRow = node.direction === 'row';
  const ref = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<number[]>(node.sizes);

  // Re-sync when the store changes the layout from elsewhere (split/move).
  useEffect(() => { setSizes(node.sizes); }, [node.sizes]);

  const beginResize = (i: number, e: React.PointerEvent) => {
    e.preventDefault();
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const total = isRow ? rect.width : rect.height;
    const startPos = isRow ? e.clientX : e.clientY;
    const startSizes = [...sizes];
    const totalRatio = startSizes.reduce((a, b) => a + b, 0);
    const minRatio = 0.06 * totalRatio;
    let latest = startSizes;
    ctx.setResizing(true);

    const onMove = (ev: PointerEvent) => {
      const pos = isRow ? ev.clientX : ev.clientY;
      const deltaRatio = ((pos - startPos) / total) * totalRatio;
      let a = startSizes[i] + deltaRatio;
      let b = startSizes[i + 1] - deltaRatio;
      if (a < minRatio) { b -= minRatio - a; a = minRatio; }
      if (b < minRatio) { a -= minRatio - b; b = minRatio; }
      const next = [...startSizes];
      next[i] = a; next[i + 1] = b;
      latest = next;
      setSizes(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      ctx.setResizing(false);
      ctx.store.resize(node.id, latest);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div ref={ref} className={`flex ${isRow ? 'flex-row' : 'flex-col'} min-w-0 min-h-0 h-full w-full gap-0`}>
      {node.children.map((child, i) => (
        <div key={child.id} className="contents">
          <div className="min-w-0 min-h-0 overflow-hidden" style={{ flexGrow: sizes[i] ?? 1, flexBasis: 0 }}>
            <NodeView node={child} ctx={ctx} />
          </div>
          {i < node.children.length - 1 && (
            <div
              onPointerDown={(e) => beginResize(i, e)}
              className={`shrink-0 group flex items-center justify-center ${
                isRow ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize'
              }`}
            >
              <div
                className={`bg-border group-hover:bg-blue-500/50 rounded transition-colors ${
                  isRow ? 'w-0.5 h-8' : 'h-0.5 w-8'
                }`}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
