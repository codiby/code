import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  TextField, Input,
  Checkbox, CheckboxControl, CheckboxIndicator, CheckboxContent,
  Autocomplete, AutocompleteTrigger, AutocompleteValue, AutocompleteIndicator,
  AutocompletePopover, AutocompleteFilter,
  SearchField, SearchFieldInput,
  Select, SelectTrigger, SelectValue, SelectPopover,
  ListBox, ListBoxItem,
} from '@heroui/react';
import type { ClaudeClient } from '../lib/claude-client';

const PM_OPTIONS = ['bun', 'npm', 'yarn', 'pnpm'] as const;
type PackageManager = typeof PM_OPTIONS[number];

type DepsMode = 'install' | 'copy' | 'link' | 'none';

interface Props {
  client: ClaudeClient;
  /** Git top-level of the repo we're creating the worktree under. */
  repoPath: string;
  /** Whether the repo has a `.env` file (prefills the copy-env checkbox). */
  hasEnv?: boolean;
  /** Detected package manager (prefills the picker when depsMode === 'install'). */
  detectedPackageManager?: string;
  /** Already-checked-out worktrees of this repo. We hide their branches
   *  from the "Existing branch" picker because git refuses to attach a
   *  branch that's already checked out in another worktree. */
  existingWorktrees?: { path: string; branch: string }[];
  /** Fired once the worktree is created. The host decides what to do
   *  with the absolute path (navigate, spawn session, etc). */
  onCreated: (path: string) => void;
  /** Hide the inline console / status block. Useful when the host
   *  wants to show its own logs UI. Default: false. */
  hideConsole?: boolean;
  /** When true, the form (and its action button) are read-only. Useful
   *  when the host wants to lock the UI during an unrelated async op. */
  disabled?: boolean;
}

/**
 * Shared worktree-creation form.
 *
 * Used in two places:
 *   - `NewSessionModal`'s right-side panel (full new-session flow that
 *     also has a folder browser).
 *   - `WorktreeCreateModal` (the standalone modal opened from a tab
 *     group's "New session in worktree" dropdown item — repo path is
 *     already inferred from the group).
 *
 * Owns ALL state: branch mode (new/existing), branch input, source
 * picker, deps strategy, package manager, copy .env, plus the create
 * progress + console output. Calls `onCreated(path)` exactly once when
 * the worktree finishes creating successfully.
 */
export function WorktreeCreateForm({
  client,
  repoPath,
  hasEnv,
  detectedPackageManager,
  existingWorktrees,
  onCreated,
  hideConsole = false,
  disabled = false,
}: Props) {
  // 'new'      → create a fresh branch (optionally based on `sourceBranch`).
  // 'existing' → attach an existing branch into the worktree.
  const [mode, setMode] = useState<'new' | 'existing'>('new');
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
  const consoleRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<{ abort: () => void } | null>(null);
  // Guards the auto-fire of onCreated so it only triggers once per run.
  const firedRef = useRef(false);

  // Sync prefill values when the host swaps repos under us.
  useEffect(() => {
    setCopyEnv(!!hasEnv);
  }, [hasEnv]);
  useEffect(() => {
    setPackageManager(
      PM_OPTIONS.includes(detectedPackageManager as PackageManager)
        ? (detectedPackageManager as PackageManager)
        : 'npm',
    );
  }, [detectedPackageManager]);

  // Load branches whenever the repo changes. Default the source picker
  // to the current branch so the common case ("branch off whatever I'm
  // on") is zero-click.
  useEffect(() => {
    if (!repoPath) {
      setBranchesInfo(null);
      setSourceBranch('');
      return;
    }
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
  }, [repoPath, client]);

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

  // Branches eligible for "attach existing" — anything already checked
  // out in a worktree (including the main repo) is filtered out.
  const attachableBranches = useMemo(() => {
    const inUse = new Set((existingWorktrees ?? []).map(w => w.branch));
    return availableBranches.filter(b => !inUse.has(b));
  }, [availableBranches, existingWorktrees]);

  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [logs]);

  // Abort any in-flight SSE stream if the form unmounts mid-creation.
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const start = () => {
    const trimmed = branch.trim();
    if (!trimmed || !repoPath || status === 'running' || disabled) return;
    const isNew = mode === 'new';
    setStatus('running');
    setLogs([]);
    firedRef.current = false;
    abortRef.current = client.createWorktree(
      repoPath,
      trimmed,
      {
        new_branch: isNew,
        copy_env: copyEnv,
        install_deps: depsMode === 'install',
        copy_node_modules: depsMode === 'copy',
        link_node_modules: depsMode === 'link',
        package_manager: packageManager,
        // Source / pull only meaningful when creating a new branch.
        source_branch: isNew ? (sourceBranch.trim() || undefined) : undefined,
        pull_source: isNew && !!sourceBranch.trim() && pullSource,
      },
      {
        onLog: (line) => setLogs(prev => [...prev, line]),
        onDone: (result) => {
          setLogs(prev => [...prev, '', `Done. Worktree ready at ${result.path}`]);
          setStatus('done');
          if (!firedRef.current) {
            firedRef.current = true;
            onCreated(result.path);
          }
        },
        onError: (err) => {
          setLogs(prev => [...prev, `ERROR: ${err}`]);
          setStatus('error');
        },
      },
    );
  };

  const isRunning = status === 'running';
  const locked = disabled || isRunning;

  // --- styles --------------------------------------------------------
  const ROW = 'flex items-center gap-2.5 min-h-[32px]';
  const LABEL = 'text-[11px] uppercase tracking-wider text-zinc-500 w-[90px] shrink-0';
  const TG = 'inline-flex bg-base border border-border-light rounded-md p-0.5 gap-0.5';
  const tgBtn = (on: boolean) =>
    `px-3 h-[26px] rounded text-xs font-medium transition-colors whitespace-nowrap ${
      on ? 'bg-blue-600 text-white hover:bg-blue-700'
         : 'text-zinc-400 hover:text-zinc-100 hover:bg-surface-light'
    } disabled:opacity-50 disabled:cursor-not-allowed`;

  return (
    <div className="space-y-3">
      {/* Mode: New vs Existing. Reset the branch field on switch so the
       *  input/picker start empty. */}
      <div className={ROW}>
        <span className={LABEL}>Mode</span>
        <div className={TG} role="group" aria-label="Branch mode">
          <button
            type="button"
            className={tgBtn(mode === 'new')}
            disabled={locked}
            onClick={() => { if (mode !== 'new') { setMode('new'); setBranch(''); } }}
          >New branch</button>
          <button
            type="button"
            className={tgBtn(mode === 'existing')}
            disabled={locked}
            onClick={() => { if (mode !== 'existing') { setMode('existing'); setBranch(''); } }}
          >Existing branch</button>
        </div>
      </div>

      {/* Branch — input in 'new' mode, picker in 'existing'. */}
      <div className={ROW}>
        <span className={LABEL}>{mode === 'new' ? 'New branch' : 'Branch'}</span>
        <div className="flex-1 min-w-0">
          {mode === 'new' ? (
            <TextField value={branch} onChange={setBranch} isDisabled={locked}>
              <Input placeholder="new-branch-name" autoFocus className="font-mono text-[13px]" />
            </TextField>
          ) : branchesInfo && attachableBranches.length > 0 ? (
            <Autocomplete
              aria-label="Branch to attach"
              selectedKey={branch || null}
              onSelectionChange={(key) => setBranch((key as string) || '')}
              isDisabled={locked}
            >
              <AutocompleteTrigger className="h-8 text-xs w-full">
                <AutocompleteValue className="font-mono truncate" />
                <AutocompleteIndicator />
              </AutocompleteTrigger>
              <AutocompletePopover>
                <AutocompleteFilter filter={(textValue, inputValue) => textValue.toLowerCase().includes(inputValue.toLowerCase())}>
                  <SearchField aria-label="Filter branches" autoFocus>
                    <SearchFieldInput placeholder="Search branches…" className="font-mono text-xs text-zinc-100" />
                  </SearchField>
                  <ListBox>
                    {attachableBranches.map(b => (
                      <ListBoxItem key={b} id={b} textValue={b}>
                        <span className="text-sm font-mono">{b}</span>
                      </ListBoxItem>
                    ))}
                  </ListBox>
                </AutocompleteFilter>
              </AutocompletePopover>
            </Autocomplete>
          ) : (
            <span className="text-xs text-zinc-600">
              {branchesInfo ? 'No detached branches available' : 'Loading branches…'}
            </span>
          )}
        </div>
      </div>

      {/* Source (only when creating a new branch). */}
      {mode === 'new' && (
        <div className={ROW}>
          <span className={LABEL}>Source</span>
          <div className="flex-1 min-w-0">
            {branchesInfo && availableBranches.length > 0 ? (
              <Autocomplete aria-label="Source branch" selectedKey={sourceBranch || null}
                onSelectionChange={(key) => setSourceBranch((key as string) || '')}
                isDisabled={locked}>
                <AutocompleteTrigger className="h-8 text-xs w-full">
                  <AutocompleteValue className="font-mono truncate" />
                  <AutocompleteIndicator />
                </AutocompleteTrigger>
                <AutocompletePopover>
                  <AutocompleteFilter filter={(textValue, inputValue) => textValue.toLowerCase().includes(inputValue.toLowerCase())}>
                    <SearchField aria-label="Filter branches" autoFocus>
                      <SearchFieldInput placeholder="Search branches…" className="font-mono text-xs text-zinc-100" />
                    </SearchField>
                    <ListBox>
                      {availableBranches.map(b => (
                        <ListBoxItem key={b} id={b} textValue={b}>
                          <span className="text-sm font-mono">{b}</span>
                          {b === branchesInfo.current && <span className="text-xs text-zinc-500 ml-1">(current)</span>}
                        </ListBoxItem>
                      ))}
                    </ListBox>
                  </AutocompleteFilter>
                </AutocompletePopover>
              </Autocomplete>
            ) : (
              <span className="text-xs text-zinc-600 font-mono">{branchesInfo ? 'HEAD' : 'loading…'}</span>
            )}
          </div>
        </div>
      )}

      {/* Pull origin/<source> first — only meaningful in new mode + when a source is set. */}
      {mode === 'new' && (
        <div className={ROW}>
          <span className={LABEL}></span>
          <Checkbox isSelected={pullSource} onChange={setPullSource} isDisabled={locked || !sourceBranch}>
            <CheckboxControl><CheckboxIndicator /></CheckboxControl>
            <CheckboxContent>
              <span className="text-xs text-zinc-300">
                Pull <code className="font-mono text-zinc-400">origin/{sourceBranch || '…'}</code> first
              </span>
            </CheckboxContent>
          </Checkbox>
        </div>
      )}

      {/* .env copy */}
      <div className={ROW}>
        <span className={LABEL}>Env</span>
        <Checkbox isSelected={copyEnv} onChange={setCopyEnv} isDisabled={locked || !hasEnv}>
          <CheckboxControl><CheckboxIndicator /></CheckboxControl>
          <CheckboxContent>
            <span className="text-xs text-zinc-300">
              Copy <code className="font-mono text-zinc-400">.env</code>
              {!hasEnv && <span className="text-zinc-600"> (none)</span>}
            </span>
          </CheckboxContent>
        </Checkbox>
      </div>

      {/* node_modules strategy + optional package manager. */}
      <div className={ROW}>
        <span className={LABEL}>node_modules</span>
        <div className="flex items-center gap-2 flex-wrap">
          <div className={TG} role="group" aria-label="node_modules strategy">
            {(['install', 'copy', 'link', 'none'] as const).map(m => (
              <button
                key={m}
                type="button"
                className={tgBtn(depsMode === m)}
                disabled={locked}
                onClick={() => setDepsMode(m)}
              >
                {m === 'install' ? 'Install' : m === 'copy' ? 'Copy' : m === 'link' ? 'Link' : 'Skip'}
              </button>
            ))}
          </div>
          {depsMode === 'install' && (
            <Select aria-label="Package manager" selectedKey={packageManager}
              onSelectionChange={(key) => setPackageManager(key as PackageManager)}
              isDisabled={locked}>
              <SelectTrigger className="h-7 text-xs w-24"><SelectValue /></SelectTrigger>
              <SelectPopover>
                <ListBox>
                  {PM_OPTIONS.map(pm => (
                    <ListBoxItem key={pm} id={pm} textValue={pm}>
                      <span className="text-sm">{pm}</span>
                      {pm === detectedPackageManager && <span className="text-xs text-zinc-500 ml-1">(detected)</span>}
                    </ListBoxItem>
                  ))}
                </ListBox>
              </SelectPopover>
            </Select>
          )}
        </div>
      </div>

      {/* Create button on its own row, separated by a divider. */}
      <div className={`${ROW} pt-3 border-t border-border`}>
        <span className={LABEL}></span>
        <Button
          size="sm"
          isDisabled={!branch.trim() || locked}
          onPress={start}
        >
          {status === 'running' ? 'Creating…'
            : status === 'error' ? 'Retry'
            : 'Create worktree'}
        </Button>
      </div>

      {/* Console — only shown while a creation is in flight or just finished. */}
      {!hideConsole && status !== 'idle' && (
        <div className="border-t border-border -mx-1 mt-2 pt-2">
          <div className="flex items-center justify-between px-1 py-1 border-b border-border/60">
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
            className="overflow-y-auto px-2 py-2 font-mono text-[11px] leading-5 bg-black/40 max-h-[180px]"
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
    </div>
  );
}
