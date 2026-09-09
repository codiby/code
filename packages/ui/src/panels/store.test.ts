import { describe, expect, it } from 'bun:test';
import { getPanelsStore } from './store';
import type { LayoutNode, SplitNode, Tab } from './types';

let n = 0;
const freshStore = () => getPanelsStore(`test-ws-${n++}`);

const tab = (id: string, zone: string): Tab => ({ id, kind: 'test', title: id, zone });

/** Seed the default two-panel layout: chat on the left, files on the right. */
function seeded() {
  const store = freshStore();
  store.reconcileTabs([tab('chat', 'chat'), tab('editor:a.ts', 'main')]);
  return store;
}

const root = (store: ReturnType<typeof freshStore>) => store.getSnapshot().root as SplitNode;
const panelIdFor = (node: LayoutNode, tabId: string): string => {
  if (node.type === 'panel') return node.tabIds.includes(tabId) ? node.id : '';
  return node.children.map((c) => panelIdFor(c, tabId)).find(Boolean) ?? '';
};
const shares = (s: SplitNode) => {
  const total = s.sizes.reduce((a, b) => a + b, 0);
  return s.sizes.map((v) => Math.round((v / total) * 1000) / 1000);
};

describe('expandPanel', () => {
  it('gives the panel 75% of its row split', () => {
    const store = seeded();
    store.expandPanel(panelIdFor(root(store), 'editor:a.ts'));
    expect(shares(root(store))).toEqual([0.25, 0.75]);
  });

  it('restores the previous ratios on a second call', () => {
    const store = seeded();
    const before = [...root(store).sizes];
    const panelId = panelIdFor(root(store), 'editor:a.ts');
    store.expandPanel(panelId);
    store.expandPanel(panelId);
    expect(root(store).sizes).toEqual(before);
  });

  it('honors a custom share', () => {
    const store = seeded();
    store.expandPanel(panelIdFor(root(store), 'editor:a.ts'), 0.9);
    expect(shares(root(store))).toEqual([0.1, 0.9]);
  });

  it('is a no-op for a lone panel that already fills the workspace', () => {
    const store = freshStore();
    store.reconcileTabs([tab('editor:a.ts', 'main')]);
    const snapshot = store.getSnapshot();
    store.expandPanel(panelIdFor(snapshot.root!, 'editor:a.ts'));
    expect(store.getSnapshot()).toBe(snapshot);
  });

  it('expands the nearest row ancestor, not an inner column split', () => {
    const store = seeded();
    const filesPanel = panelIdFor(root(store), 'editor:a.ts');
    store.reconcileTabs([tab('chat', 'chat'), tab('editor:a.ts', 'main'), tab('editor:b.ts', 'main')]);
    // Stack b.ts under a.ts inside the right-hand panel.
    store.splitPanelWithTab(filesPanel, 'editor:b.ts', 'col');
    store.expandPanel(panelIdFor(root(store), 'editor:b.ts'));
    // The outer row split widened; the inner column split kept its even sizes.
    expect(shares(root(store))).toEqual([0.25, 0.75]);
    expect((root(store).children[1] as SplitNode).sizes).toEqual([1, 1]);
  });
});
