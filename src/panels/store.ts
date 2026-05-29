/**
 * PanelsWorkspace — per-session layout store.
 *
 * One store instance per session id, cached in `stores`. The store owns the
 * layout tree (which panels exist, how they're split, which tabs live where)
 * and persists it to localStorage. It deliberately does NOT own tab content
 * or even the tab list — the host reconciles the live tab set into the tree
 * via `reconcileTabs`, and renders content itself. Subscribe with the
 * `usePanelsStore` hook (built on `useSyncExternalStore`).
 */
import { useSyncExternalStore } from 'react';
import type { LayoutNode, PanelNode, SplitDirection, SplitNode, Tab, WorkspaceState } from './types';
import { emptyWorkspace } from './types';

let _seq = 0;
const uid = (prefix: string) => `${prefix}_${(_seq++).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

// ---------------------------------------------------------------------------
// Tree helpers (pure)
// ---------------------------------------------------------------------------

const cloneNode = (n: LayoutNode): LayoutNode =>
  n.type === 'split'
    ? { ...n, sizes: [...n.sizes], children: n.children.map(cloneNode) }
    : { ...n, tabIds: [...n.tabIds] };

const isPanel = (n: LayoutNode): n is PanelNode => n.type === 'panel';

/** Depth-first list of every panel in the tree. */
function panels(root: LayoutNode | null): PanelNode[] {
  if (!root) return [];
  if (isPanel(root)) return [root];
  return root.children.flatMap(panels);
}

/** Every tab id currently placed in the tree, in document order. */
function allTabIds(root: LayoutNode | null): string[] {
  return panels(root).flatMap((p) => p.tabIds);
}

function findPanel(root: LayoutNode | null, id: string): PanelNode | null {
  return panels(root).find((p) => p.id === id) ?? null;
}

/**
 * Remove empty panels and collapse single-child / degenerate splits. Returns
 * the simplified tree (or null when everything is gone). Operates on a tree
 * that may already be a clone — it returns new node objects where needed.
 */
function prune(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  if (isPanel(node)) return node.tabIds.length > 0 ? node : null;

  const kids = node.children.map(prune).filter((c): c is LayoutNode => c != null);
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0]; // collapse split with one survivor

  // Re-derive sizes for the survivors, preserving relative ratios where we can.
  const survivorSizes = node.children
    .map((c, i) => [prune(c), node.sizes[i] ?? 1] as const)
    .filter(([c]) => c != null)
    .map(([, s]) => s);
  const sizes = survivorSizes.length === kids.length ? survivorSizes : kids.map(() => 1);
  return { ...node, children: kids, sizes };
}

/** Make sure every panel's activeTabId points at a tab it actually holds. */
function fixActives(root: LayoutNode | null): void {
  for (const p of panels(root)) {
    if (p.activeTabId == null || !p.tabIds.includes(p.activeTabId)) {
      p.activeTabId = p.tabIds[p.tabIds.length - 1] ?? null;
    }
  }
}

function structureKey(s: WorkspaceState): string {
  return JSON.stringify([s.root, s.focusedPanelId]);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const LS_PREFIX = 'codiby-panels-ws:';

class PanelsStore {
  private state: WorkspaceState;
  private listeners = new Set<() => void>();

  constructor(private sessionId: string) {
    this.state = this.load();
  }

  // --- React glue ---
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = (): WorkspaceState => this.state;

  private commit(next: WorkspaceState) {
    if (structureKey(next) === structureKey(this.state)) return; // no-op, keep ref stable
    this.state = next;
    this.save(next);
    this.listeners.forEach((l) => l());
  }

  // --- persistence ---
  private load(): WorkspaceState {
    try {
      const raw = localStorage.getItem(LS_PREFIX + this.sessionId);
      if (raw) {
        const parsed = JSON.parse(raw) as WorkspaceState;
        if (parsed && (parsed.root === null || typeof parsed.root === 'object')) return parsed;
      }
    } catch { /* ignore corrupt persisted layout */ }
    return emptyWorkspace();
  }
  private save(s: WorkspaceState) {
    try { localStorage.setItem(LS_PREFIX + this.sessionId, JSON.stringify(s)); } catch { /* quota */ }
  }

  // --- actions ---

  /**
   * Reconcile the live tab set (owned by the host) into the layout tree:
   * drop ids that vanished, append genuinely-new ids to the focused panel
   * (or seed the first panel), and keep everything else where the user put
   * it. Idempotent — re-running with the same id set is a no-op.
   */
  reconcileTabs(tabs: Tab[]) {
    const desired = tabs.map((t) => t.id);
    const desiredSet = new Set(desired);
    let root = this.state.root ? cloneNode(this.state.root) : null;
    let focusedPanelId = this.state.focusedPanelId;

    // 1. remove vanished ids
    for (const p of panels(root)) {
      p.tabIds = p.tabIds.filter((id) => desiredSet.has(id));
    }
    root = prune(root);

    // 2. find new ids (preserve host order)
    const present = new Set(allTabIds(root));
    const newIds = desired.filter((id) => !present.has(id));

    if (newIds.length > 0) {
      if (!root) {
        // seed a single panel with all current tabs
        const panel: PanelNode = { id: uid('panel'), type: 'panel', tabIds: [...newIds], activeTabId: newIds[newIds.length - 1] };
        root = panel;
        focusedPanelId = panel.id;
      } else {
        const target = (focusedPanelId && findPanel(root, focusedPanelId)) || panels(root)[0];
        target.tabIds.push(...newIds);
        target.activeTabId = newIds[newIds.length - 1];
        focusedPanelId = target.id;
      }
    }

    fixActives(root);
    if (focusedPanelId && !findPanel(root, focusedPanelId)) focusedPanelId = panels(root)[0]?.id ?? null;

    this.commit({ root, focusedPanelId });
  }

  setActiveTab(panelId: string, tabId: string) {
    const root = this.state.root ? cloneNode(this.state.root) : null;
    const p = findPanel(root, panelId);
    if (!p || !p.tabIds.includes(tabId)) return;
    p.activeTabId = tabId;
    this.commit({ root, focusedPanelId: panelId });
  }

  focusPanel(panelId: string) {
    if (this.state.focusedPanelId === panelId) return;
    if (!findPanel(this.state.root, panelId)) return;
    this.commit({ ...this.state, focusedPanelId: panelId });
  }

  /** Remove a tab from the layout (host is responsible for the underlying close). */
  closeTab(tabId: string) {
    let root = this.state.root ? cloneNode(this.state.root) : null;
    for (const p of panels(root)) p.tabIds = p.tabIds.filter((id) => id !== tabId);
    root = prune(root);
    fixActives(root);
    let focusedPanelId = this.state.focusedPanelId;
    if (focusedPanelId && !findPanel(root, focusedPanelId)) focusedPanelId = panels(root)[0]?.id ?? null;
    this.commit({ root, focusedPanelId });
  }

  /** Move a tab to `toPanelId` at `index` (reorder within / across panels). */
  moveTab(tabId: string, toPanelId: string, index: number) {
    const root = this.state.root ? cloneNode(this.state.root) : null;
    const to = findPanel(root, toPanelId);
    if (!to) return;
    // detach from wherever it is
    let from: PanelNode | null = null;
    for (const p of panels(root)) {
      if (p.tabIds.includes(tabId)) { from = p; p.tabIds = p.tabIds.filter((id) => id !== tabId); break; }
    }
    const clamped = Math.max(0, Math.min(index, to.tabIds.length));
    to.tabIds.splice(clamped, 0, tabId);
    to.activeTabId = tabId;
    if (from && from.id !== to.id && from.activeTabId == null) fixActives(root);
    const pruned = prune(root);
    fixActives(pruned);
    this.commit({ root: pruned, focusedPanelId: toPanelId });
  }

  /**
   * Split `panelId` along `direction`, moving `tabId` into a fresh sibling
   * panel. No-op if the panel would be left empty (can't split a 1-tab panel
   * against itself meaningfully — caller should guard, but we guard too).
   */
  splitPanelWithTab(panelId: string, tabId: string, direction: SplitDirection) {
    const root = this.state.root ? cloneNode(this.state.root) : null;
    if (!root) return;
    const source = findPanel(root, panelId);
    if (!source || !source.tabIds.includes(tabId)) return;
    if (source.tabIds.length <= 1) return; // nothing left to keep

    source.tabIds = source.tabIds.filter((id) => id !== tabId);
    fixActives(root);
    const newPanel: PanelNode = { id: uid('panel'), type: 'panel', tabIds: [tabId], activeTabId: tabId };

    // Replace `source` in the tree with a split [source, newPanel].
    const split: SplitNode = { id: uid('split'), type: 'split', direction, children: [source, newPanel], sizes: [1, 1] };
    const nextRoot = replaceNode(root, source.id, split);
    this.commit({ root: nextRoot, focusedPanelId: newPanel.id });
  }

  /** Persist new flex ratios for a split node after a drag-resize. */
  resize(splitId: string, sizes: number[]) {
    const root = this.state.root ? cloneNode(this.state.root) : null;
    const node = findSplit(root, splitId);
    if (!node || sizes.length !== node.children.length) return;
    node.sizes = sizes.map((s) => Math.max(0.05, s));
    this.commit({ ...this.state, root });
  }
}

function replaceNode(root: LayoutNode, targetId: string, replacement: LayoutNode): LayoutNode {
  if (root.id === targetId) return replacement;
  if (isPanel(root)) return root;
  return { ...root, children: root.children.map((c) => replaceNode(c, targetId, replacement)) };
}

function findSplit(root: LayoutNode | null, id: string): SplitNode | null {
  if (!root || isPanel(root)) return null;
  if (root.id === id) return root;
  for (const c of root.children) {
    const found = findSplit(c, id);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Registry + hook
// ---------------------------------------------------------------------------

const stores = new Map<string, PanelsStore>();

export function getPanelsStore(sessionId: string): PanelsStore {
  let s = stores.get(sessionId);
  if (!s) { s = new PanelsStore(sessionId); stores.set(sessionId, s); }
  return s;
}

export type { PanelsStore };

/** Subscribe a component to a session's workspace layout. */
export function usePanelsStore(sessionId: string): { state: WorkspaceState; store: PanelsStore } {
  const store = getPanelsStore(sessionId);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { state, store };
}
