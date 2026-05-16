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

export interface TabGroupInfo {
  id: string;
  name: string;
  color: string;
  cwd?: string;
  icon?: string;

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
