import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { AppState } from './types';
import { createPreferencesSlice } from './slices/preferencesSlice';
import { createTabGroupsSlice } from './slices/tabGroupsSlice';
import { createGitSlice } from './slices/gitSlice';
import { createPrSlice } from './slices/prSlice';
import { createKeybindingsSlice } from './slices/keybindingsSlice';
import { createWorkspacesSlice } from './slices/workspacesSlice';
import { createTerminalsSlice } from './slices/terminalsSlice';
import { createSessionsSlice } from './slices/sessionsSlice';
import { createClientSlice } from './slices/clientSlice';

/** The single global app store. State that used to live as ~90 `useState`
 *  hooks inside the ChatApp god component is being migrated here slice by
 *  slice; components subscribe directly via selectors, which also retires the
 *  prop-drilling that threaded that state through the tree. */
export const useAppStore = create<AppState>()((...args) => ({
  ...createPreferencesSlice(...args),
  ...createTabGroupsSlice(...args),
  ...createGitSlice(...args),
  ...createPrSlice(...args),
  ...createKeybindingsSlice(...args),
  ...createWorkspacesSlice(...args),
  ...createTerminalsSlice(...args),
  ...createSessionsSlice(...args),
  ...createClientSlice(...args),
}));

/** Re-exported for object/array selectors so consumers get referential
 *  stability without every component importing from `zustand/react/shallow`. */
export { useShallow };
