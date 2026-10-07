import type { Dispatch, SetStateAction } from 'react';
import type { TerminalInfo } from '../../claude-client';
import type { SliceCreator } from '../types';
import { apply } from '../apply';

type TabContextMenu = { shellId: string; procId: string; running: boolean; x: number; y: number } | null;

/** The bottom terminals dock: the terminal resources (keyed by sessionId),
 *  panel expand/maximize/height/resize chrome, per-shell renames,
 *  context-menu state, and which shell is active per session.
 *  Setters keep the `useState` signature; prefs persistence stays at the call
 *  sites (shellRenames / terminalsPanelHeight). */
export interface TerminalsSlice {
  terminals: Record<string, TerminalInfo[]>;
  terminalsPanelExpanded: boolean;
  termDockHost: HTMLDivElement | null;
  terminalsFocused: boolean;
  terminalsPanelMaximized: boolean;
  terminalsPanelHeight: number;
  panelResizing: boolean;
  shellRenames: Record<string, Record<string, string>>;
  renamingShellId: string | null;
  tabContextMenu: TabContextMenu;
  minimizedShells: Set<string>;
  activeShellBySession: Record<string, string>;

  setTerminals: Dispatch<SetStateAction<Record<string, TerminalInfo[]>>>;
  setTerminalsPanelExpanded: Dispatch<SetStateAction<boolean>>;
  setTermDockHost: Dispatch<SetStateAction<HTMLDivElement | null>>;
  setTerminalsFocused: Dispatch<SetStateAction<boolean>>;
  setTerminalsPanelMaximized: Dispatch<SetStateAction<boolean>>;
  setTerminalsPanelHeight: Dispatch<SetStateAction<number>>;
  setPanelResizing: Dispatch<SetStateAction<boolean>>;
  setShellRenames: Dispatch<SetStateAction<Record<string, Record<string, string>>>>;
  setRenamingShellId: Dispatch<SetStateAction<string | null>>;
  setTabContextMenu: Dispatch<SetStateAction<TabContextMenu>>;
  setMinimizedShells: Dispatch<SetStateAction<Set<string>>>;
  setActiveShellBySession: Dispatch<SetStateAction<Record<string, string>>>;
}

export const createTerminalsSlice: SliceCreator<TerminalsSlice> = (set) => ({
  terminals: {},
  terminalsPanelExpanded: false,
  termDockHost: null,
  terminalsFocused: false,
  terminalsPanelMaximized: false,
  terminalsPanelHeight: 340,
  panelResizing: false,
  shellRenames: {},
  renamingShellId: null,
  tabContextMenu: null,
  minimizedShells: new Set(),
  activeShellBySession: {},

  setTerminals: (u) => set(s => ({ terminals: apply(s.terminals, u) })),
  setTerminalsPanelExpanded: (u) => set(s => ({ terminalsPanelExpanded: apply(s.terminalsPanelExpanded, u) })),
  setTermDockHost: (u) => set(s => ({ termDockHost: apply(s.termDockHost, u) })),
  setTerminalsFocused: (u) => set(s => ({ terminalsFocused: apply(s.terminalsFocused, u) })),
  setTerminalsPanelMaximized: (u) => set(s => ({ terminalsPanelMaximized: apply(s.terminalsPanelMaximized, u) })),
  setTerminalsPanelHeight: (u) => set(s => ({ terminalsPanelHeight: apply(s.terminalsPanelHeight, u) })),
  setPanelResizing: (u) => set(s => ({ panelResizing: apply(s.panelResizing, u) })),
  setShellRenames: (u) => set(s => ({ shellRenames: apply(s.shellRenames, u) })),
  setRenamingShellId: (u) => set(s => ({ renamingShellId: apply(s.renamingShellId, u) })),
  setTabContextMenu: (u) => set(s => ({ tabContextMenu: apply(s.tabContextMenu, u) })),
  setMinimizedShells: (u) => set(s => ({ minimizedShells: apply(s.minimizedShells, u) })),
  setActiveShellBySession: (u) => set(s => ({ activeShellBySession: apply(s.activeShellBySession, u) })),
});
