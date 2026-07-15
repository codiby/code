import type { Dispatch, SetStateAction } from 'react';
import type { PRInfo } from '../../../components/PRDetail';
import type { SliceCreator } from '../types';
import { apply } from '../apply';

type PrLink = { prNumber: number; title: string; url: string; headRefName: string; state: string };
type SessionPr = { number: number; title: string; headRefName: string; state: string; url: string; isDraft: boolean };

/** Pull-request state: per-branch PR links (keyed by branch), the header
 *  dropdown of open PRs, the fetched list, and the PR opened in the side
 *  panel. Setters keep the `useState` signature. */
export interface PrSlice {
  prLinks: Record<string, PrLink>;
  showPrDropdown: boolean;
  sessionPrs: SessionPr[];
  openPR: PRInfo | null;

  setPrLinks: Dispatch<SetStateAction<Record<string, PrLink>>>;
  setShowPrDropdown: Dispatch<SetStateAction<boolean>>;
  setSessionPrs: Dispatch<SetStateAction<SessionPr[]>>;
  setOpenPR: Dispatch<SetStateAction<PRInfo | null>>;
}

export const createPrSlice: SliceCreator<PrSlice> = (set) => ({
  prLinks: {},
  showPrDropdown: false,
  sessionPrs: [],
  openPR: null,

  setPrLinks: (u) => set(s => ({ prLinks: apply(s.prLinks, u) })),
  setShowPrDropdown: (u) => set(s => ({ showPrDropdown: apply(s.showPrDropdown, u) })),
  setSessionPrs: (u) => set(s => ({ sessionPrs: apply(s.sessionPrs, u) })),
  setOpenPR: (u) => set(s => ({ openPR: apply(s.openPR, u) })),
});
