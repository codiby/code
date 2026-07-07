/**
 * PanelsWorkspace — layout model.
 *
 * A workspace is a recursive tree of nodes. A `SplitNode` divides its area
 * row-wise or column-wise between children (each child gets a flex ratio in
 * `sizes`). A `PanelNode` is a leaf that holds an ordered set of tab ids and
 * tracks which one is active. Tabs themselves are *not* stored in the tree —
 * only their ids — so the same id can be reconciled against externally-owned
 * tab descriptors (see `store.reconcileTabs`). This keeps the layout (a thing
 * we persist) decoupled from tab content (a thing the host renders live).
 */

export type SplitDirection = 'row' | 'col';

export interface SplitNode {
  id: string;
  type: 'split';
  /** `row` = children side-by-side, `col` = children stacked vertically. */
  direction: SplitDirection;
  children: LayoutNode[];
  /** Flex ratios, one per child. `sizes.length === children.length`. */
  sizes: number[];
}

export interface PanelNode {
  id: string;
  type: 'panel';
  /** Ordered tab ids living in this panel. */
  tabIds: string[];
  /** Currently visible tab. `null` only transiently (empty panel, pruned). */
  activeTabId: string | null;
}

export type LayoutNode = SplitNode | PanelNode;

/**
 * A tab descriptor. The host (e.g. ChatApp) owns the live list of tabs and
 * passes it to the workspace; the engine only positions them. `kind` is what
 * a registry / `renderTab` switch keys on to decide which React component to
 * mount. `props`/content are intentionally absent here — rendering is the
 * host's job via `renderTab(tab)`.
 */
export interface Tab {
  id: string;
  kind: string;
  title: string;
  /** Optional short icon (emoji or single glyph). */
  icon?: string;
  /** Dotted "dirty" indicator in the tab. */
  dirty?: boolean;
  /** When false the × is hidden and the tab can't be closed by the user. */
  closable?: boolean;
  /** Italic "preview" tab (VSCode style): replaced when the next file opens,
   *  unless the user pins it (double-click) or modifies it. Host-managed. */
  preview?: boolean;
  /** Strike-through title: the file backing this tab was deleted on disk. The
   *  buffer is kept so the user can re-save (Cmd+S) to resurrect it. */
  deleted?: boolean;
  /** Placement hint. Tabs sharing a zone land in the same panel; a new zone
   *  spawns a new panel split to the right of the existing tree. Defaults to
   *  'main'. Used to seed the chat-left / resources-right default layout. */
  zone?: string;
}

export interface WorkspaceState {
  /** Root of the layout tree. `null` when no panels are open. */
  root: LayoutNode | null;
  /** Panel that receives newly-opened tabs and shows the focus ring. */
  focusedPanelId: string | null;
}

export const emptyWorkspace = (): WorkspaceState => ({ root: null, focusedPanelId: null });
