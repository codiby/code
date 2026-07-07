// Collapse a worktree cwd back to its main repo. Worktrees live at
// `<repo>/.wt/<branch>`, so a session inside one belongs to the repo.
export function projectRootOf(cwd: string): string {
  if (!cwd) return '';
  const idx = cwd.indexOf('/.wt/');
  return idx >= 0 ? cwd.slice(0, idx) : cwd;
}
