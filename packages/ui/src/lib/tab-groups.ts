/** Canonical shape of a tab group (a.k.a. "project") as persisted in
 *  ~/.codiby/ui-preferences.json under `tabGroups[groupId]`. The original
 *  five fields (id/name/color/cwd/icon) describe how the group looks in the
 *  sidebar. The remaining fields are per-project overrides edited from the
 *  Project Settings modal — all optional; absence means "fall back to global". */

export interface ProjectEnvVar {
  key: string;
  value: string;
}

export interface ProjectAutoApproveRule {
  id: string;
  /** Tool name (e.g. "Bash", "Edit", "Write"). */
  tool: string;
  /** Glob/command patterns matched by this rule. */
  patterns: string[];
}

export interface ProjectMcpOverrides {
  /** MCP server names disabled in this project. */
  disabled?: string[];
}

/** Format of a `PortlessExport` value. `url`/`host`/`port` are presets the
 *  bridge renders from the source action's config. `custom` lets the user
 *  write a template with `{host}` / `{url}` / `{port}` / `{scheme}`
 *  placeholders so things like `http://{host}/api` are possible. */
export type PortlessExportFormat = 'url' | 'host' | 'port' | 'custom';

/** A single env var the project publishes for taskr-spawned processes
 *  (other actions, /terminal shells, spawn_terminal MCP shells). The
 *  value comes from `sourceActionId`'s configured URL — computed at spawn
 *  time, no runtime dependency. The source action never receives its own
 *  exports (would be a self-reference). */
export interface PortlessExport {
  id: string;
  name: string;
  /** Action whose URL drives this export's value. */
  sourceActionId: string;
  format: PortlessExportFormat;
  /** Only honoured when `format === 'custom'`. Supports the placeholders
   *  `{host}` `{url}` `{port}` `{scheme}` — substituted from the source
   *  action's config at spawn time. */
  template?: string;
}

/** A named server command this project can run. Each action can optionally
 *  route through Portless (when `portless` is true, the command is wrapped
 *  with `portless <slug> --` and served at `hostname`); otherwise it runs
 *  as a plain shell command inside a tracked terminal.
 *
 *  Compat note: actions created before the per-action flag was introduced
 *  have `portless === undefined` and are treated as portless-enabled, so
 *  existing setups don't silently change behavior. */
export interface PortlessAction {
  id: string;
  name: string;
  command: string;
  /** When true (or undefined, for legacy actions), the command is wrapped
   *  with `portless <slug> --`. When false, the command runs raw. */
  portless?: boolean;
  /** Used only when portless is on. Full local hostname (e.g.
   *  "api.localhost"); when blank we derive it from `name` + the project
   *  TLD default. */
  hostname?: string;
}

export interface PortlessConfig {
  /** Master switch. When false the actions are still listed in the UI but
   *  taskr won't spawn portless — useful for temporarily falling back to
   *  raw `bun run dev`. Defaults to true when at least one action exists. */
  enabled?: boolean;
  /** @deprecated TLD is now a global pref (`portlessTld` on ui-preferences).
   *  Left here so old projects still load without errors; the new code
   *  ignores it. */
  tld?: string;
  /** HTTPS via the portless local CA. Defaults to true. */
  tls?: boolean;
  /** Prefix the active worktree's branch onto each action's hostname so
   *  every worktree gets its own subdomain. */
  worktreeSubdomains?: boolean;
  actions?: PortlessAction[];
  /** Project-level list of env vars to inject into spawned processes.
   *  Each entry references a source action by id; the value is computed
   *  from that action's hostname + the project's tls/tld settings at
   *  spawn time. */
  exports?: PortlessExport[];
}

/** `manual` groups are user- (or autogroup-) created and persisted.
 *  `worktree` groups are derived at render time from sessions sharing a
 *  worktree cwd — see `lib/group-tree.ts`. They never reach preferences. */
export type TabGroupKind = 'manual' | 'worktree';

export interface TabGroupInfo {
  id: string;
  name: string;
  /** Absent on nested subgroups, which inherit the nearest ancestor's colour
   *  (`resolveGroupColor`). Top-level groups always carry one. */
  color?: string;
  cwd?: string;
  icon?: string;

  /** Parent group, or null/absent for a root-level group. Nesting is
   *  unbounded; cycles are defensively flattened when the tree is built. */
  parentId?: string | null;
  /** Defaults to `manual` when absent (every group predating nesting). */
  kind?: TabGroupKind;
  /** Only set on derived worktree groups: the shared cwd they group. */
  worktreePath?: string;
  /** Survives having no members. Set on groups the user creates explicitly as
   *  empty folders, so the orphan-pruning pass leaves them alone. */
  allowEmpty?: boolean;

  /** When true, new sessions whose cwd matches this group's cwd are
   *  auto-claimed into this group. Distinct from the global
   *  `autoGroupSessions` toggle which is opt-in for *any* new project. */
  autoClaim?: boolean;

  /** Model id (e.g. "claude-opus-4-7"). Empty/undefined = global default. */
  defaultModel?: string;
  /** Agent name (e.g. "claude", "Plan", "Explore"). */
  defaultAgent?: string;
  /** Extra text prepended to the system prompt for sessions in this project. */
  systemPromptAddition?: string;

  envVars?: ProjectEnvVar[];
  autoApproveRules?: ProjectAutoApproveRule[];
  mcpOverrides?: ProjectMcpOverrides;

  /** Per-project override for the global `autoFocusBrowserOnAction` toggle.
   *  `undefined` = inherit global. When true, action-style browser_* SDK
   *  tools (click/type/scroll/…) bring the targeted preview to the front
   *  before they run, so the user sees the action happen even when another
   *  preview was active. */
  autoFocusBrowserOnAction?: boolean;

  /** Portless config + named dev-server actions for this project. */
  portless?: PortlessConfig;
}

export const GROUP_COLORS = ['blue', 'green', 'amber', 'violet', 'red', 'pink'] as const;
export type GroupColor = typeof GROUP_COLORS[number];

export const GROUP_DOT_COLOR: Record<string, string> = {
  blue:   'bg-blue-400',
  green:  'bg-green-400',
  amber:  'bg-amber-400',
  violet: 'bg-violet-400',
  red:    'bg-red-400',
  pink:   'bg-pink-400',
};

export const GROUP_HEX_COLOR: Record<string, string> = {
  blue:   '#60a5fa',
  green:  '#34d399',
  amber:  '#fbbf24',
  violet: '#a78bfa',
  red:    '#f87171',
  pink:   '#f472b6',
};
