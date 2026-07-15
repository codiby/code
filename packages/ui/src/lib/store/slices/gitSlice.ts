import type { Dispatch, SetStateAction } from 'react';
import type { GitModifiedState } from '../../../components/FileExplorer';
import type { SliceCreator } from '../types';
import { apply } from '../apply';

/** Git working-tree state for the active session's repo: current branch, the
 *  branch-switcher popover, its filter, the modified-file sets, and the diff
 *  comparison base. Setters keep the `useState` signature. */
export interface GitSlice {
  gitBranch: string | null;
  branchMenu: { local: string[]; remote: string[]; current: string; rect: DOMRect } | null;
  branchFilter: string;
  gitModified: GitModifiedState;
  changesCompare: 'vs-main' | 'uncommitted';
  baseBranch: string;

  setGitBranch: Dispatch<SetStateAction<string | null>>;
  setBranchMenu: Dispatch<SetStateAction<{ local: string[]; remote: string[]; current: string; rect: DOMRect } | null>>;
  setBranchFilter: Dispatch<SetStateAction<string>>;
  setGitModified: Dispatch<SetStateAction<GitModifiedState>>;
  setChangesCompare: Dispatch<SetStateAction<'vs-main' | 'uncommitted'>>;
  setBaseBranch: Dispatch<SetStateAction<string>>;
}

export const createGitSlice: SliceCreator<GitSlice> = (set) => ({
  gitBranch: null,
  branchMenu: null,
  branchFilter: '',
  gitModified: { staged: new Set(), unstaged: new Set(), untracked: new Set(), stats: new Map() },
  changesCompare: 'vs-main',
  baseBranch: 'main',

  setGitBranch: (u) => set(s => ({ gitBranch: apply(s.gitBranch, u) })),
  setBranchMenu: (u) => set(s => ({ branchMenu: apply(s.branchMenu, u) })),
  setBranchFilter: (u) => set(s => ({ branchFilter: apply(s.branchFilter, u) })),
  setGitModified: (u) => set(s => ({ gitModified: apply(s.gitModified, u) })),
  setChangesCompare: (u) => set(s => ({ changesCompare: apply(s.changesCompare, u) })),
  setBaseBranch: (u) => set(s => ({ baseBranch: apply(s.baseBranch, u) })),
});
