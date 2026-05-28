/**
 * Cross-action env-var injection.
 *
 * The project carries a single `exports` list at `portless.exports`. Each
 * entry references a source action by id; when a different action (or any
 * taskr-spawned shell) starts, the entry's value is computed from the
 * source action's configured hostname and added to the spawned process's
 * env. The source action never receives its own exports.
 *
 * Why config-time, not runtime:
 *   The URL is a pure function of (hostname, tld, tls). Computing it at
 *   spawn time means circular FE↔API stacks work — the consumer doesn't
 *   wait for the producer to be live, it just reads the configured URL.
 *
 * Precedence: user's session/global env overrides (from Project Settings
 * → Environment) win on conflict — see server/pty.ts's merge order.
 */

import type {
  TabGroupInfo,
  PortlessConfig,
  PortlessAction,
  PortlessExport,
  PortlessExportFormat,
} from '../src/lib/tab-groups';

function slugHostname(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
}

/** Deterministic hostname for an action. The TLD comes from the GLOBAL
 *  Portless preference (not per-project) because portless's proxy serves
 *  one TLD at a time — making it a project setting would be misleading.
 *  Pass it as a 3rd arg; falls back to "localhost" when not provided. */
function configuredHost(action: PortlessAction, _cfg: PortlessConfig | undefined, tld: string): string {
  return (action.hostname && action.hostname.includes('.'))
    ? action.hostname
    : `${slugHostname(action.name)}.${tld}`;
}

/** Pure-config URL derivation — exported for callers that want the same
 *  string the action would advertise to other shells. Returns null when
 *  the action is non-portless (no published URL). */
export function configuredActionUrl(action: PortlessAction, cfg: PortlessConfig | undefined, globalTld: string): string | null {
  if (action.portless === false) return null;
  const tls = cfg?.tls !== false;
  return `${tls ? 'https' : 'http'}://${configuredHost(action, cfg, globalTld)}`;
}

/** Render a configured URL/host into the value an export wants. Used by
 *  both the bridge (at spawn time) and the UI preview field. */
export function renderExportValue(
  format: PortlessExportFormat,
  action: PortlessAction,
  cfg: PortlessConfig | undefined,
  globalTld: string,
  customTemplate?: string,
): string {
  const tls = cfg?.tls !== false;
  const scheme = tls ? 'https' : 'http';
  const host = configuredHost(action, cfg, globalTld);
  const port = tls ? '443' : '80';
  const url = `${scheme}://${host}`;
  if (format === 'host') return host;
  if (format === 'port') return port;
  if (format === 'url') return url;
  // custom — substitute placeholders. Both `{name}` and `${name}` shapes
  // are accepted so users coming from shell habits don't get tripped up.
  const template = customTemplate || url;
  return template
    .replace(/\$\{host\}|\{host\}/g, host)
    .replace(/\$\{url\}|\{url\}/g, url)
    .replace(/\$\{port\}|\{port\}/g, port)
    .replace(/\$\{scheme\}|\{scheme\}/g, scheme);
}

/** Build the env-var map a newly-spawned process in this project should
 *  receive. Iterates the project's `portless.exports`, skipping any whose
 *  source action is the spawning action itself.
 *
 *  @param excludeActionId — pass when an action is the one spawning so
 *  its own exports are skipped. `/terminal` and `spawn_terminal` aren't
 *  tied to a specific action, so they pass `undefined` (no exclusion). */
export function buildInjectedActionEnv(
  group: TabGroupInfo | undefined,
  globalTld: string,
  excludeActionId?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  const cfg = group?.portless;
  if (!cfg) return out;
  if (cfg.enabled === false) return out;
  const actions = cfg.actions || [];
  const actionById = new Map<string, PortlessAction>();
  for (const a of actions) actionById.set(a.id, a);

  // Prefer the modern project-level list; if the project still carries
  // the legacy per-action `exports` field (left around from an earlier
  // beta), materialize those into temporary entries.
  const raw: PortlessExport[] = [...(cfg.exports || [])];
  for (const a of actions) {
    const legacy = (a as unknown as { exports?: Array<{ name: string; format: PortlessExportFormat }> }).exports;
    if (!Array.isArray(legacy)) continue;
    for (const item of legacy) {
      if (!item?.name) continue;
      raw.push({
        id: `${a.id}:${item.name}`,
        name: item.name,
        sourceActionId: a.id,
        format: item.format || 'url',
      });
    }
  }

  for (const exp of raw) {
    if (!exp?.name?.trim()) continue;
    if (excludeActionId && exp.sourceActionId === excludeActionId) continue;
    const source = actionById.get(exp.sourceActionId);
    if (!source) continue;
    if (source.portless === false) continue;
    out[exp.name] = renderExportValue(exp.format || 'url', source, cfg, globalTld, exp.template);
  }
  return out;
}

/** Convenience helper for callers that already loaded the global prefs
 *  blob — pulls the global TLD (defaults to "localhost"). */
export function getGlobalTld(prefs: Record<string, unknown>): string {
  const v = prefs.portlessTld;
  return typeof v === 'string' && v.trim() ? v.trim() : 'localhost';
}

/** Look up the TabGroup a session belongs to, given the raw preferences
 *  blob (the bridge already loads this on demand for the MCP tools). */
export function resolveGroupForSession(
  prefs: Record<string, unknown>,
  sessionId: string,
): TabGroupInfo | undefined {
  const map = (prefs.tabGroupMap as Record<string, string> | undefined) || {};
  const groupId = map[sessionId];
  if (!groupId) return undefined;
  const groups = (prefs.tabGroups as Record<string, TabGroupInfo> | undefined) || {};
  return groups[groupId];
}
