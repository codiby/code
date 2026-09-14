import type { Dispatch, SetStateAction } from 'react';
import type { SliceCreator } from '../types';
import { apply } from '../apply';

/** `repo` and `cwd` are optional: links persisted before multi-repo support
 *  have neither, and a PR resolved without a GitHub remote has no repo. */
export type PrLink = {
  prNumber: number;
  title: string;
  url: string;
  headRefName: string;
  state: string;
  repo?: string;
  cwd?: string;
  linkedAt?: number;
  linkedBy?: 'user' | 'agent';
};
type SessionPr = { number: number; title: string; headRefName: string; state: string; url: string; isDraft: boolean };

/** "https://github.com/acme/api/pull/42" -> "acme/api". Mirrors the server-side
 *  parse in mcp.ts so a link made from the picker and one made by the agent
 *  carry the same identity and de-duplicate against each other. */
export function repoFromPrUrl(url: string | undefined): string | undefined {
  const m = String(url ?? '').match(/^https:\/\/[\w.-]+\/([\w.-]+\/[\w.-]+)\/pull\/\d+$/);
  return m ? m[1] : undefined;
}

/** Pull-request state: the PRs linked to each session (a session that touched
 *  two repos has two), the header dropdown, and the fetched list for the active
 *  repo. Setters keep the `useState` signature.
 *
 *  Which PR is *open in the side panel* is deliberately not here — it lives on
 *  the session (`LocalSessionState.openPR`), because a global value followed
 *  the user across tabs and rendered one session's PR inside another's. */
export interface PrSlice {
  prLinks: Record<string, PrLink[]>;
  showPrDropdown: boolean;
  sessionPrs: SessionPr[];

  setPrLinks: Dispatch<SetStateAction<Record<string, PrLink[]>>>;
  setShowPrDropdown: Dispatch<SetStateAction<boolean>>;
  setSessionPrs: Dispatch<SetStateAction<SessionPr[]>>;
}

export const createPrSlice: SliceCreator<PrSlice> = (set) => ({
  prLinks: {},
  showPrDropdown: false,
  sessionPrs: [],

  setPrLinks: (u) => set(s => ({ prLinks: apply(s.prLinks, u) })),
  setShowPrDropdown: (u) => set(s => ({ showPrDropdown: apply(s.showPrDropdown, u) })),
  setSessionPrs: (u) => set(s => ({ sessionPrs: apply(s.sessionPrs, u) })),
});
