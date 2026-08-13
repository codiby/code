// Collapse a worktree cwd back to its main repo. Worktrees live at
// `<repo>/.worktrees/<branch>`, so a session inside one belongs to the repo.
// `.wt` is the legacy directory, still recognised for worktrees created by
// older versions. Cuts at the *first* match so a session in a subdirectory of
// a worktree collapses to the repo too.
const WORKTREE_SEGMENT_RE = /[\\/]\.(?:worktrees|wt)[\\/]/;

export function projectRootOf(cwd: string): string {
  if (!cwd) return '';
  const m = cwd.match(WORKTREE_SEGMENT_RE);
  return m?.index !== undefined ? cwd.slice(0, m.index) : cwd;
}
