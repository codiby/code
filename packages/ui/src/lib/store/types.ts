import type { StateCreator } from 'zustand';
import type { PreferencesSlice } from './slices/preferencesSlice';
import type { TabGroupsSlice } from './slices/tabGroupsSlice';
import type { GitSlice } from './slices/gitSlice';
import type { PrSlice } from './slices/prSlice';
import type { KeybindingsSlice } from './slices/keybindingsSlice';
import type { WorkspacesSlice } from './slices/workspacesSlice';
import type { TerminalsSlice } from './slices/terminalsSlice';
import type { SessionsSlice } from './slices/sessionsSlice';
import type { ClientSlice } from './slices/clientSlice';

/** The single app store is composed of independent domain slices. Each new
 *  slice adds its interface to this intersection; consumers subscribe with
 *  fine-grained selectors (`useAppStore(s => s.activeId)`) to avoid needless
 *  re-renders. */
export type AppState =
  & PreferencesSlice
  & TabGroupsSlice
  & GitSlice
  & PrSlice
  & KeybindingsSlice
  & WorkspacesSlice
  & TerminalsSlice
  & SessionsSlice
  & ClientSlice;

/** A slice creator typed against the whole store, so any slice's actions can
 *  read/write across domains via `get()` / `set()` (e.g. closing a session
 *  cleans up tab groups, terminals and workspaces in one action). */
export type SliceCreator<T> = StateCreator<AppState, [], [], T>;
