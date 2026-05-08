import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@heroui/react';
import { BottomSheet } from './BottomSheet';
import { MobileDiffModal } from './MobileDiffModal';
import type { ClaudeClient } from '../../lib/claude-client';

interface Props {
  open: boolean;
  onClose: () => void;
  client: ClaudeClient;
  cwd: string;
}

interface ModifiedFile {
  path: string;
  staged: boolean;
  untracked?: boolean;
}

export function MobileGitSheet({ open, onClose, client, cwd }: Props) {
  const [info, setInfo] = useState<{ branch?: string; top_level?: string; is_git: boolean } | null>(null);
  const [modified, setModified] = useState<ModifiedFile[]>([]);
  const [branches, setBranches] = useState<{ current: string; local: string[]; remote: string[] }>({ current: '', local: [], remote: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [showBranches, setShowBranches] = useState(false);
  // Diff viewer — opens when a modified file is tapped.
  const [diffFile, setDiffFile] = useState<{ path: string; status: 'modified' | 'staged' | 'untracked' } | null>(null);

  const refresh = async () => {
    if (!cwd) return;
    setLoading(true);
    setError(null);
    try {
      const [g, m, br] = await Promise.all([
        client.getGitInfo(cwd),
        client.getGitModified(cwd),
        client.listBranches(cwd),
      ]);
      setInfo(g);
      setModified(m);
      setBranches(br);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (open) refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, cwd]);

  const switchBranch = async (branch: string) => {
    if (switchingTo) return;
    setSwitchingTo(branch);
    setError(null);
    try {
      const res = await client.checkoutBranch(cwd, branch);
      if (!res.ok) setError(res.error || 'Checkout failed');
      else await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSwitchingTo(null);
    }
  };

  const staged = modified.filter((f) => f.staged);
  const unstaged = modified.filter((f) => !f.staged && !f.untracked);
  const untracked = modified.filter((f) => f.untracked);

  return (
    <BottomSheet open={open} onClose={onClose} title="Git">
      {loading && !info && <div className="text-sm text-zinc-500 py-2">Loading…</div>}
      {error && (
        <div className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-3">
          {error}
        </div>
      )}

      {info && !info.is_git && (
        <p className="text-sm text-zinc-500">Not a git repository.</p>
      )}

      {info?.is_git && (
        <div className="space-y-4">
          {/* Branch */}
          <div className="rounded-xl bg-white/5 border border-white/10 p-3">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Branch</div>
            <Button
              variant="ghost"
              onPress={() => setShowBranches((v) => !v)}
              className="w-full h-auto min-w-0 justify-between text-left text-base font-mono text-zinc-100 active:opacity-70 flex items-center px-0"
            >
              <span className="truncate">{info.branch || '(detached)'}</span>
              <span className="text-zinc-500 shrink-0">
                {showBranches ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </span>
            </Button>
            {showBranches && (
              <ul className="mt-3 max-h-72 overflow-y-auto divide-y divide-white/5">
                {branches.local.map((b) => {
                  const isCurrent = b === branches.current;
                  return (
                    <li key={b}>
                      <Button
                        variant="ghost"
                        isDisabled={isCurrent || switchingTo !== null}
                        onPress={() => switchBranch(b)}
                        className={`w-full h-auto min-w-0 justify-between text-left flex items-center py-2.5 px-1 ${
                          isCurrent ? 'text-indigo-300' : 'text-zinc-300 active:bg-white/5'
                        }`}
                      >
                        <span className="font-mono text-sm truncate">{b}</span>
                        {isCurrent && <span className="text-[10px] uppercase tracking-wider">current</span>}
                        {switchingTo === b && <span className="text-[10px]">switching…</span>}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Modified files */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                {modified.length === 0 ? 'No changes' : `${modified.length} changed file${modified.length === 1 ? '' : 's'}`}
              </div>
              <Button
                variant="ghost"
                onPress={refresh}
                className="h-auto min-w-0 text-[11px] text-zinc-400 active:text-zinc-200 px-2 py-1 rounded-md bg-white/5 active:bg-white/10"
              >
                Refresh
              </Button>
            </div>

            {staged.length > 0 && (
              <FileGroup
                title="Staged"
                color="text-green-400"
                files={staged}
                onOpen={(path) => setDiffFile({ path, status: 'staged' })}
              />
            )}
            {unstaged.length > 0 && (
              <FileGroup
                title="Modified"
                color="text-amber-400"
                files={unstaged}
                onOpen={(path) => setDiffFile({ path, status: 'modified' })}
              />
            )}
            {untracked.length > 0 && (
              <FileGroup
                title="Untracked"
                color="text-blue-400"
                files={untracked}
                onOpen={(path) => setDiffFile({ path, status: 'untracked' })}
              />
            )}
          </div>
        </div>
      )}

      <MobileDiffModal
        open={!!diffFile}
        onClose={() => setDiffFile(null)}
        client={client}
        filePath={diffFile?.path ?? null}
        status={diffFile?.status}
      />
    </BottomSheet>
  );
}

function FileGroup({
  title, color, files, onOpen,
}: {
  title: string;
  color: string;
  files: ModifiedFile[];
  onOpen: (path: string) => void;
}) {
  return (
    <div className="mb-3">
      <div className={`text-[11px] font-semibold ${color} mb-1`}>{title} ({files.length})</div>
      <ul className="rounded-xl bg-white/5 border border-white/10 divide-y divide-white/5">
        {files.map((f) => {
          const fileName = f.path.split('/').pop() || f.path;
          const dirPart = f.path.slice(0, f.path.length - fileName.length).replace(/\/$/, '');
          return (
            <li key={f.path}>
              <Button
                variant="ghost"
                onPress={() => onOpen(f.path)}
                className="w-full h-auto min-w-0 justify-start text-left px-3 py-2.5 min-h-11 text-[12px] font-mono text-zinc-200 active:bg-white/5 flex items-center gap-2"
              >
                <span className="truncate flex-1">
                  <span className="text-zinc-100">{fileName}</span>
                  {dirPart && <span className="text-zinc-600">  {dirPart}</span>}
                </span>
                <ChevronRight size={14} className="shrink-0 text-zinc-600" />
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
