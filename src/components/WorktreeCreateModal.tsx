import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  Button,
  TextField, Input,
  Checkbox, CheckboxControl, CheckboxIndicator, CheckboxContent,
  Autocomplete, AutocompleteTrigger, AutocompleteValue, AutocompleteIndicator,
  AutocompletePopover, AutocompleteFilter,
  SearchField, SearchFieldInput,
  ListBox, ListBoxItem,
  ToggleButtonGroup, ToggleButton,
} from '@heroui/react';
import type { ClaudeClient } from '../lib/claude-client';

const PM_OPTIONS = ['bun', 'npm', 'yarn', 'pnpm'] as const;
type PackageManager = typeof PM_OPTIONS[number];

type DepsMode = 'install' | 'copy' | 'link' | 'none';

interface Props {
  open: boolean;
  /** Close the create dialog without spawning a session — returns the
   *  user to the parent worktree picker. */
  onClose: () => void;
  client: ClaudeClient;
  repoPath: string;
  hasEnv?: boolean;
  detectedPackageManager?: string;
  /** Called when the user confirms the freshly-created worktree via
   *  "Use it". Receives the absolute path of the new checkout. */
  onCreated: (path: string) => void;
}

/**
 * Stacked sub-modal opened from `WorktreeModal` when the user clicks
 * "+ New worktree". Owns the branch / source / deps form, runs
 * `client.createWorktree()`, and streams logs into a console. Bubbles
 * the resulting path up via `onCreated` once the user confirms.
 */
export function WorktreeCreateModal({
  open, onClose, client, repoPath, hasEnv, detectedPackageManager, onCreated,
}: Props) {
  const [branch, setBranch] = useState('');
  const [copyEnv, setCopyEnv] = useState(!!hasEnv);
  const [depsMode, setDepsMode] = useState<DepsMode>('link');
  const [packageManager, setPackageManager] = useState<PackageManager>(
    PM_OPTIONS.includes(detectedPackageManager as PackageManager)
      ? (detectedPackageManager as PackageManager)
      : 'npm',
  );
  const [sourceBranch, setSourceBranch] = useState('');
  const [pullSource, setPullSource] = useState(true);
  const [branchesInfo, setBranchesInfo] = useState<{ current: string; local: string[]; remote: string[] } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [resultPath, setResultPath] = useState<string | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<{ abort: () => void } | null>(null);

  useEffect(() => {
    if (!open) return;
    setBranch('');
    setLogs([]);
    setStatus('idle');
    setResultPath(null);
    setCopyEnv(!!hasEnv);
    setDepsMode('link');
    setPackageManager(
      PM_OPTIONS.includes(detectedPackageManager as PackageManager)
        ? (detectedPackageManager as PackageManager)
        : 'npm',
    );
  }, [open, hasEnv, detectedPackageManager]);

  useEffect(() => {
    if (!open || !repoPath) return;
    let cancelled = false;
    (async () => {
      try {
        const info = await client.listBranches(repoPath);
        if (cancelled) return;
        setBranchesInfo(info);
        setSourceBranch(info.current || info.local[0] || '');
      } catch {
        if (!cancelled) setBranchesInfo({ current: '', local: [], remote: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [open, repoPath, client]);

  const availableBranches = useMemo(() => {
    if (!branchesInfo) return [] as string[];
    const seen = new Set<string>();
    const all: string[] = [];
    for (const b of [...branchesInfo.local, ...branchesInfo.remote]) {
      if (!seen.has(b)) { seen.add(b); all.push(b); }
    }
    const priority = (b: string) => {
      if (b === branchesInfo.current) return 0;
      if (b === 'main' || b === 'master') return 1;
      if (b === 'develop' || b === 'dev') return 2;
      return 3;
    };
    all.sort((a, b) => {
      const d = priority(a) - priority(b);
      return d !== 0 ? d : a.localeCompare(b);
    });
    return all;
  }, [branchesInfo]);

  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [logs]);

  const start = () => {
    const trimmed = branch.trim();
    if (!trimmed || !repoPath || status === 'running') return;
    setStatus('running');
    setLogs([]);
    setResultPath(null);
    abortRef.current = client.createWorktree(
      repoPath,
      trimmed,
      {
        copy_env: copyEnv,
        install_deps: depsMode === 'install',
        copy_node_modules: depsMode === 'copy',
        link_node_modules: depsMode === 'link',
        package_manager: packageManager,
        source_branch: sourceBranch.trim() || undefined,
        pull_source: !!sourceBranch.trim() && pullSource,
      },
      {
        onLog: (line) => setLogs((prev) => [...prev, line]),
        onDone: (result) => {
          setLogs((prev) => [...prev, '', `Done. Worktree ready at ${result.path}`]);
          setStatus('done');
          setResultPath(result.path);
        },
        onError: (err) => {
          setLogs((prev) => [...prev, `ERROR: ${err}`]);
          setStatus('error');
        },
      },
    );
  };

  const canClose = status !== 'running';

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget && canClose) onClose(); }}
    >
      <div
        className="bg-surface border border-border-light rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: 480, maxHeight: '85vh' }}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-border flex items-center justify-between shrink-0">
          <h2 className="text-sm font-semibold text-zinc-100">New Worktree</h2>
          {canClose && (
            <Button isIconOnly size="sm" variant="ghost" onPress={onClose} aria-label="Close">
              <X size={16} />
            </Button>
          )}
        </div>

        {/* Form */}
        {status !== 'done' && (
          <div className="px-5 py-3 space-y-3 shrink-0 border-b border-border">
            <div>
              <label className="block text-[10px] text-zinc-500 mb-1 font-semibold uppercase tracking-wider">New Branch</label>
              <TextField
                value={branch}
                onChange={setBranch}
                isDisabled={status === 'running'}
                aria-label="New branch name"
                autoFocus
              >
                <Input
                  placeholder="new-branch-name"
                  className="font-mono text-[13px]"
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                />
              </TextField>
            </div>

            <div>
              <label className="block text-[10px] text-zinc-500 mb-1 font-semibold uppercase tracking-wider">Source Branch</label>
              <Autocomplete
                aria-label="Source branch"
                selectedKey={sourceBranch || null}
                onSelectionChange={(key) => setSourceBranch((key as string) || '')}
                isDisabled={status === 'running' || !branchesInfo}
              >
                <AutocompleteTrigger className="w-full">
                  <AutocompleteValue className="font-mono text-[13px] truncate" />
                  <AutocompleteIndicator />
                </AutocompleteTrigger>
                <AutocompletePopover>
                  <AutocompleteFilter filter={(textValue, inputValue) => textValue.toLowerCase().includes(inputValue.toLowerCase())}>
                    <SearchField aria-label="Filter branches" autoFocus>
                      <SearchFieldInput placeholder="Search branches…" className="font-mono text-[12px] text-zinc-100" />
                    </SearchField>
                    <ListBox>
                      {availableBranches.map((b) => (
                        <ListBoxItem key={b} id={b} textValue={b}>
                          <span className="w-1.5 h-1.5 rounded-full mr-2 inline-block align-middle bg-green-400 data-[current=false]:bg-zinc-600" data-current={b === branchesInfo?.current} />
                          <span className="font-mono">{b}</span>
                          {b === branchesInfo?.current && <span className="text-[10px] text-green-400 ml-1.5">current</span>}
                        </ListBoxItem>
                      ))}
                    </ListBox>
                  </AutocompleteFilter>
                </AutocompletePopover>
              </Autocomplete>
              <Checkbox
                isSelected={pullSource}
                onChange={setPullSource}
                isDisabled={status === 'running' || !sourceBranch}
                className="mt-1.5"
              >
                <CheckboxControl><CheckboxIndicator /></CheckboxControl>
                <CheckboxContent>
                  <span className="text-[12px] text-zinc-300">
                    Pull <code className="text-zinc-400 font-mono">origin/{sourceBranch || '…'}</code> first
                  </span>
                </CheckboxContent>
              </Checkbox>
            </div>

            <div>
              <label className="block text-[10px] text-zinc-500 mb-1 font-semibold uppercase tracking-wider">node_modules</label>
              <ToggleButtonGroup
                aria-label="node_modules strategy"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={new Set([depsMode])}
                onSelectionChange={(keys) => {
                  const k = Array.from(keys as Set<string>)[0];
                  if (k) setDepsMode(k as DepsMode);
                }}
                isDisabled={status === 'running'}
                fullWidth
              >
                <ToggleButton id="install">Install</ToggleButton>
                <ToggleButton id="copy">Copy</ToggleButton>
                <ToggleButton id="link">Link</ToggleButton>
                <ToggleButton id="none">Skip</ToggleButton>
              </ToggleButtonGroup>
            </div>

            {depsMode === 'install' && (
              <div>
                <label className="block text-[10px] text-zinc-500 mb-1 font-semibold uppercase tracking-wider">Package Manager</label>
                <ToggleButtonGroup
                  aria-label="Package manager"
                  selectionMode="single"
                  disallowEmptySelection
                  selectedKeys={new Set([packageManager])}
                  onSelectionChange={(keys) => {
                    const k = Array.from(keys as Set<string>)[0];
                    if (k) setPackageManager(k as PackageManager);
                  }}
                  isDisabled={status === 'running'}
                  fullWidth
                >
                  {PM_OPTIONS.map((pm) => (
                    <ToggleButton key={pm} id={pm}>
                      <span className="font-mono">{pm}</span>
                      {pm === detectedPackageManager && <span className="text-[9px] opacity-60 ml-1">•</span>}
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
              </div>
            )}

            <Checkbox
              isSelected={copyEnv}
              onChange={setCopyEnv}
              isDisabled={status === 'running' || !hasEnv}
            >
              <CheckboxControl><CheckboxIndicator /></CheckboxControl>
              <CheckboxContent>
                <span className="text-[12px] text-zinc-300">
                  Copy <code className="text-zinc-400 font-mono">.env</code>
                  {!hasEnv && <span className="text-zinc-600"> (repo has none)</span>}
                </span>
              </CheckboxContent>
            </Checkbox>
          </div>
        )}

        {/* Console — only after a creation run starts */}
        {status !== 'idle' && (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex items-center justify-between px-5 py-1.5 border-b border-border shrink-0">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Console</span>
              <span className={`text-[11px] ${
                status === 'running' ? 'text-amber-400' :
                status === 'done' ? 'text-green-400' :
                status === 'error' ? 'text-red-400' : 'text-zinc-600'
              }`}>
                {status === 'running' && 'running…'}
                {status === 'done' && 'complete'}
                {status === 'error' && 'failed'}
              </span>
            </div>
            <div
              ref={consoleRef}
              className="flex-1 overflow-y-auto px-5 py-2 font-mono text-[11px] leading-5 bg-black/40 min-h-[120px]"
            >
              {logs.length === 0 && status === 'running' && (
                <div className="text-zinc-600">Waiting for output…</div>
              )}
              {logs.map((line, i) => (
                <div
                  key={i}
                  className={
                    line.startsWith('$') ? 'text-blue-400' :
                    line.startsWith('ERROR') ? 'text-red-400' :
                    line.startsWith('Done.') ? 'text-green-400 font-medium' :
                    line.startsWith('Copied') || line.startsWith('Worktree created') ? 'text-amber-400' :
                    'text-zinc-500'
                  }
                >
                  {line || ' '}
                </div>
              ))}
              {status === 'running' && logs.length > 0 && (
                <span className="inline-block w-2 h-3 bg-amber-400/60 animate-pulse mt-1" />
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2 shrink-0">
          <Button size="sm" variant="ghost" onPress={onClose} isDisabled={!canClose}>
            {status === 'done' ? 'Close' : 'Cancel'}
          </Button>
          {status === 'done' && resultPath ? (
            <Button size="sm" onPress={() => { onCreated(resultPath); }}>
              Use it
            </Button>
          ) : (
            <Button size="sm" onPress={start} isDisabled={!branch.trim() || status === 'running'}>
              {status === 'error' ? 'Retry' : status === 'running' ? 'Creating…' : 'Create worktree'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
