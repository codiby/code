/**
 * Default rules. Seeded into `agent_rules` (source 'default') so the owner
 * sees and can disable each one; their definitions stay here, so improving a
 * default ships with the code while the owner's on/off choice is kept.
 *
 * Priorities: guardrails 1000–1009 (denied even when a user rule allows),
 * specific tools 1010–1049, categories 1050–1098, catch-all 1099.
 *
 * Tool globs here name Codiby's own tools by their bare names; rules.ts
 * matches them only on built-in tools and Codiby's own MCP servers, so an
 * outside server's `phone_wipe` or `remember` never rides on them.
 */

import type { RuleAction } from './rules';

export interface RuleDefinition {
  id: string;
  priority: number;
  toolGlob: string;
  pattern: string | null;
  category: string | null;
  action: RuleAction;
  note: string;
}

/** Guardrails win over any non-deny rule that also matches; only disabling them lifts the block. */
export const GUARDRAIL_PREFIX = 'default:guard-';

export const DEFAULT_RULES: RuleDefinition[] = [
  { id: 'default:guard-catastrophic', priority: 1000, toolGlob: '*', pattern: null, category: 'destructive:catastrophic', action: 'deny',
    note: 'Catastrophic commands: wiping / or the home folder, formatting disks, piping a download into a shell' },
  { id: 'default:guard-agent-vault', priority: 1001, toolGlob: '*', pattern: null, category: 'credentials:agent_vault', action: 'deny',
    note: "The agent's vault and config, the bridge's tokens and database (~/.codiby), the Claude and WhatsApp logins, and the bridge endpoints that reveal secrets or change the agent's own rules" },

  // Above every allow below, including browser_navigate's: the bridge
  // trusts loopback callers, so a call to it could otherwise undo the policy.
  { id: 'default:ask-bridge', priority: 1010, toolGlob: '*', pattern: null, category: 'network:bridge', action: 'ask',
    note: 'Calls to this Codiby bridge (curl localhost, opening it in the browser)' },
  { id: 'default:phone', priority: 1011, toolGlob: 'phone_*', pattern: null, category: null, action: 'allow',
    note: 'Phone actions — the phone itself confirms sensitive ones on the device' },
  // Consolidation runs the agent unattended before a fresh thread: a memory
  // tool that asked would hold the rotation until its timeout.
  { id: 'default:memory', priority: 1012, toolGlob: 'remember,recall,forget,update_profile,people_find,people_upsert,people_list', pattern: null, category: null, action: 'allow',
    note: 'Memory and the people directory (remember, recall, forget, profile, people)' },
  // Asks once per site: approving it saves an always-allow rule for that
  // site (policy/approvals.ts). The tool itself refuses any other site.
  { id: 'default:fill-secret', priority: 1013, toolGlob: 'browser_fill_secret', pattern: null, category: null, action: 'ask',
    note: 'Filling a saved login into a web page — asks the first time for each site' },
  { id: 'default:gmail-read', priority: 1020, toolGlob: 'gmail_search,gmail_read,gmail_draft,gmail_modify', pattern: null, category: null, action: 'allow',
    note: 'Searching, reading, drafting and organising email (labels, archive)' },
  { id: 'default:calendar-read', priority: 1021, toolGlob: 'calendar_list,calendar_freebusy', pattern: null, category: null, action: 'allow',
    note: 'Reading the calendar' },
  { id: 'default:browser-read', priority: 1022, toolGlob: 'browser_open,browser_navigate,browser_snapshot,browser_take_screenshot,browser_close,browser_wait_for,browser_scroll,browser_hover,browser_console_messages,browser_network_requests',
    pattern: null, category: null, action: 'allow', note: 'Browsing: opening pages, snapshots and screenshots' },

  { id: 'default:read', priority: 1050, toolGlob: '*', pattern: null, category: 'read', action: 'allow', note: 'Reading files, email, calendar and pages' },
  { id: 'default:agent-internal', priority: 1051, toolGlob: '*', pattern: null, category: 'agent_internal', action: 'allow',
    note: "The agent's own tools: memory, people, reminders, notifying the owner, Codiby UI" },
  { id: 'default:write-workspace', priority: 1052, toolGlob: '*', pattern: null, category: 'write:workspace', action: 'allow', note: 'Writing inside the workspace' },
  { id: 'default:shell-read-only', priority: 1053, toolGlob: '*', pattern: null, category: 'shell:read_only', action: 'allow',
    note: 'Read-only shell commands (ls, cat, grep, git status, curl GET…)' },
  { id: 'default:network-get', priority: 1054, toolGlob: '*', pattern: null, category: 'network:get', action: 'allow', note: 'Web fetches, searches and browsing' },
  { id: 'default:browser-action', priority: 1055, toolGlob: '*', pattern: null, category: 'other:browser_action', action: 'allow',
    note: 'Clicking and typing on ordinary pages (purchases still ask)' },
  { id: 'default:calendar-own', priority: 1056, toolGlob: '*', pattern: null, category: 'calendar:own', action: 'allow',
    note: 'Creating, moving or deleting events nobody else is on (events with guests still ask)' },

  { id: 'default:ask-write-outside', priority: 1060, toolGlob: '*', pattern: null, category: 'write', action: 'ask', note: 'Writing outside the workspace' },
  { id: 'default:ask-shell', priority: 1061, toolGlob: '*', pattern: null, category: 'shell', action: 'ask', note: 'Shell commands that change things' },
  { id: 'default:ask-send-external', priority: 1062, toolGlob: '*', pattern: null, category: 'send_external', action: 'ask', note: 'Messages and emails to anyone but the owner' },
  { id: 'default:ask-mail', priority: 1063, toolGlob: '*', pattern: null, category: 'mail', action: 'ask', note: 'Changing email (labels, archive, trash)' },
  { id: 'default:ask-calendar', priority: 1064, toolGlob: '*', pattern: null, category: 'calendar', action: 'ask', note: 'Creating, changing or deleting events' },
  { id: 'default:ask-purchase', priority: 1065, toolGlob: '*', pattern: null, category: 'purchase', action: 'ask', note: 'Anything that looks like a purchase or payment' },
  { id: 'default:ask-credentials', priority: 1066, toolGlob: '*', pattern: null, category: 'credentials', action: 'ask', note: 'Reading or using credentials' },
  { id: 'default:ask-destructive', priority: 1067, toolGlob: '*', pattern: null, category: 'destructive', action: 'ask', note: 'Destructive actions' },
  { id: 'default:ask-network', priority: 1068, toolGlob: '*', pattern: null, category: 'network', action: 'ask', note: 'Other network actions (exposing ports…)' },
  { id: 'default:ask-anything-else', priority: 1099, toolGlob: '*', pattern: null, category: null, action: 'ask', note: 'Anything else asks first' },
];
