import type { Dispatch, SetStateAction } from 'react';
import { loadInitialWorkspaces, type Workspace } from '../../../components/ChatFocusLayout';
import type { SliceCreator } from '../types';
import { apply } from '../apply';

type LayoutMode = 'standard' | 'horizontal' | 'focus';

function initialLayoutMode(): LayoutMode {
  try {
    const v = localStorage.getItem('claude-ui-layout-mode');
    if (v === 'focus' || v === 'horizontal' || v === 'standard') return v;
  } catch {}
  return 'standard';
}

/** Top-level layout mode plus focus-mode workspace state. Persistence stays at
 *  the call sites (localStorage for the mode, persistWorkspaces for the rest),
 *  so these setters keep the `useState` signature. ChatFocusLayout remains
 *  prop-driven — it must NOT import the store, to avoid an import cycle. */
export interface WorkspacesSlice {
  layoutMode: LayoutMode;
  focusWorkspaces: Workspace[];
  activeWorkspaceId: string;

  setLayoutMode: Dispatch<SetStateAction<LayoutMode>>;
  setFocusWorkspaces: Dispatch<SetStateAction<Workspace[]>>;
  setActiveWorkspaceId: Dispatch<SetStateAction<string>>;
}

export const createWorkspacesSlice: SliceCreator<WorkspacesSlice> = (set) => {
  const initial = loadInitialWorkspaces([]);
  return {
    layoutMode: initialLayoutMode(),
    focusWorkspaces: initial.workspaces,
    activeWorkspaceId: initial.activeId,

    setLayoutMode: (u) => set(s => ({ layoutMode: apply(s.layoutMode, u) })),
    setFocusWorkspaces: (u) => set(s => ({ focusWorkspaces: apply(s.focusWorkspaces, u) })),
    setActiveWorkspaceId: (u) => set(s => ({ activeWorkspaceId: apply(s.activeWorkspaceId, u) })),
  };
};
