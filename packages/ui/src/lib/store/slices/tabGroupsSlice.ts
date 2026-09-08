import type { Dispatch, SetStateAction } from 'react';
import type { TabGroupInfo } from '../../tab-groups';
import type { SliceCreator } from '../types';
import { apply } from '../apply';

/** Sidebar tab ordering, project groups, pinning and expansion. The setters
 *  mirror `useState`'s API (value or updater) on purpose; persistence to the
 *  server still happens at the call sites via `persistPrefs`, matching the
 *  original handlers. */
export interface TabGroupsSlice {
  tabOrder: string[];
  tabGroups: Record<string, TabGroupInfo>;
  tabGroupMap: Record<string, string>;
  pinnedSessionIds: Set<string>;
  expandedGroupIds: Set<string>;
  /** Group focused in the sidebar; when set, the main pane shows the inline
   *  new-session composer instead of the active session's chat. */
  selectedGroupId: string | null;

  setTabOrder: Dispatch<SetStateAction<string[]>>;
  setTabGroups: Dispatch<SetStateAction<Record<string, TabGroupInfo>>>;
  setTabGroupMap: Dispatch<SetStateAction<Record<string, string>>>;
  setPinnedSessionIds: Dispatch<SetStateAction<Set<string>>>;
  setExpandedGroupIds: Dispatch<SetStateAction<Set<string>>>;
  setSelectedGroupId: Dispatch<SetStateAction<string | null>>;
}

export const createTabGroupsSlice: SliceCreator<TabGroupsSlice> = (set) => ({
  tabOrder: [],
  tabGroups: {},
  tabGroupMap: {},
  pinnedSessionIds: new Set(),
  expandedGroupIds: new Set(),
  selectedGroupId: null,

  setTabOrder: (u) => set(s => ({ tabOrder: apply(s.tabOrder, u) })),
  setTabGroups: (u) => set(s => ({ tabGroups: apply(s.tabGroups, u) })),
  setTabGroupMap: (u) => set(s => ({ tabGroupMap: apply(s.tabGroupMap, u) })),
  setPinnedSessionIds: (u) => set(s => ({ pinnedSessionIds: apply(s.pinnedSessionIds, u) })),
  setExpandedGroupIds: (u) => set(s => ({ expandedGroupIds: apply(s.expandedGroupIds, u) })),
  setSelectedGroupId: (u) => set(s => ({ selectedGroupId: apply(s.selectedGroupId, u) })),
});
