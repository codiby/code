import type { Dispatch, SetStateAction } from 'react';
import type { ClaudeClient, SupportedModel } from '../../claude-client';
import type { SliceCreator } from '../types';
import { apply } from '../apply';

type OpencodeInfo = { available: boolean; models: Array<{ id: string; label: string; providerName: string }> } | null;

/** Connection-level state: the live `ClaudeClient`, the OpenCode provider
 *  probe result, and the cached Claude Agent SDK model list. Setters keep the
 *  `useState` signature. */
export interface ClientSlice {
  client: ClaudeClient | null;
  opencodeInfo: OpencodeInfo;
  claudeModels: SupportedModel[];

  setClient: Dispatch<SetStateAction<ClaudeClient | null>>;
  setOpencodeInfo: Dispatch<SetStateAction<OpencodeInfo>>;
  setClaudeModels: Dispatch<SetStateAction<SupportedModel[]>>;
}

export const createClientSlice: SliceCreator<ClientSlice> = (set) => ({
  client: null,
  opencodeInfo: null,
  claudeModels: [],

  setClient: (u) => set(s => ({ client: apply(s.client, u) })),
  setOpencodeInfo: (u) => set(s => ({ opencodeInfo: apply(s.opencodeInfo, u) })),
  setClaudeModels: (u) => set(s => ({ claudeModels: apply(s.claudeModels, u) })),
});
