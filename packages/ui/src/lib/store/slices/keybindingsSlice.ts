import type { Dispatch, SetStateAction } from 'react';
import type { KeybindingOverrides } from '../../keybindings';
import type { SliceCreator } from '../types';
import { apply } from '../apply';

/** User keybinding overrides (loaded from the server via `getKeybindings`).
 *  Persistence back to the server is done at the call site (persistKeybindings),
 *  so this setter keeps the plain `useState` signature. */
export interface KeybindingsSlice {
  kbOverrides: KeybindingOverrides;
  setKbOverrides: Dispatch<SetStateAction<KeybindingOverrides>>;
}

export const createKeybindingsSlice: SliceCreator<KeybindingsSlice> = (set) => ({
  kbOverrides: {},
  setKbOverrides: (u) => set(s => ({ kbOverrides: apply(s.kbOverrides, u) })),
});
