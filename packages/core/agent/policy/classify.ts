/**
 * Tool-call classifier: (tool name, input, context) → what kind of action it
 * is, in words the owner can read and rules can match.
 *
 * Categories are coarse (they drive the Activity filters); `qualifier`
 * refines them for rules — a rule on `write` matches every write, a rule on
 * `write:workspace` only those inside the workspace.
 *
 * Pure: no I/O beyond resolving symlinks on paths, so the bridge's 'preview'
 * phase can call it on every tool card.
 */

import { ALWAYS_AUTO_APPROVE_TOOLS, USER_INTERACTION_TOOLS } from '../../config/config';
import { bridgeAccess } from './bridge-access';
import { classifyCommand, type ShellLevel } from './shell';
import { isInWorkspace, pathSensitivity, resolveToolPath, type PathContext } from './paths';

export const CATEGORIES = [
  'read', 'write', 'shell', 'network', 'send_external', 'mail', 'calendar', 'purchase',
  'credentials', 'destructive', 'interaction', 'agent_internal', 'other',
] as const;
export type PolicyCategory = typeof CATEGORIES[number];

/** Every `category` / `category:qualifier` value a rule may name. */
export const RULE_CATEGORIES: { value: string; label: string }[] = [
  { value: 'read', label: 'Read files and data' },
  { value: 'read:browser', label: 'Read · browser page' },
  { value: 'read:phone', label: 'Read · phone' },
  { value: 'write', label: 'Write files (anywhere)' },
  { value: 'write:workspace', label: 'Write · inside the workspace' },
  { value: 'write:outside', label: 'Write · outside the workspace' },
  { value: 'shell', label: 'Shell commands (any)' },
  { value: 'shell:read_only', label: 'Shell · read-only commands' },
  { value: 'shell:other', label: 'Shell · other commands' },
  { value: 'network', label: 'Network requests (any)' },
  { value: 'network:get', label: 'Network · GET / browsing' },
  { value: 'network:expose', label: 'Network · expose a port' },
  { value: 'network:bridge', label: 'Network · calls to this Codiby bridge' },
  { value: 'send_external', label: 'Send to someone else' },
  { value: 'send_external:message', label: 'Send · chat message to someone else' },
  { value: 'send_external:email', label: 'Send · email to someone else' },
  { value: 'send_external:phone', label: 'Send · reply from the phone' },
  { value: 'mail', label: 'Email changes (drafts, labels)' },
  { value: 'calendar', label: 'Calendar changes' },
  { value: 'calendar:own', label: 'Calendar · events with no guests' },
  { value: 'calendar:guests', label: 'Calendar · events with guests (or not checked)' },
  { value: 'purchase', label: 'Possible purchases' },
  { value: 'credentials', label: 'Credentials and secrets' },
  { value: 'credentials:agent_vault', label: "Credentials · the agent's vault, the bridge's tokens and secret endpoints" },
  { value: 'credentials:browser_secret', label: 'Credentials · saved passwords in the browser' },
  { value: 'destructive', label: 'Destructive actions' },
  { value: 'destructive:catastrophic', label: 'Destructive · catastrophic' },
  { value: 'agent_internal', label: "The agent's own tools (memory, reminders…)" },
  { value: 'other', label: 'Other' },
  { value: 'other:browser_action', label: 'Other · clicking/typing in the browser' },
  { value: 'other:browser_script', label: 'Other · running JavaScript in a page' },
  { value: 'other:delegation', label: 'Other · delegating to unguarded sessions' },
  { value: 'other:mcp', label: 'Other · tools from other MCP servers' },
];

export interface OwnerIdentities {
  telegramChatIds: string[];
  whatsappJids: string[];
  emails: string[];
}

export interface BrowserLookup {
  /** Last URL the agent opened in the named preview. */
  pageUrl(name: string): string | null;
  /** The snapshot line describing `ref` in the named preview (`- button "Buy now" [ref=e12]`). */
  refLabel(name: string, ref: string): string | null;
}

export interface CalendarLookup {
  /**
   * People other than the owner on an event the agent has seen in this
   * conversation (guests, or the organizer of an invitation); null when the
   * event hasn't been seen, so nobody can say.
   */
  eventGuests(eventId: string): number | null;
}

export interface PeopleLookup {
  /** The people directory's name for a recipient address, or null when nobody is saved with it. */
  nameFor(address: string, channelId?: string): string | null;
}

export interface ClassifyContext extends PathContext {
  owner: OwnerIdentities;
  browser?: BrowserLookup;
  calendar?: CalendarLookup;
  people?: PeopleLookup;
  /** Permission mode of a local session, for delegation checks. */
  sessionMode?: (sessionId: string) => string | null;
}

export interface Classification {
  category: PolicyCategory;
  qualifier?: string;
  /** One line for people: what the call does. */
  summary: string;
  /** What it acts on (command, path, recipient, URL) — what rule patterns match. */
  target?: string;
  reasons: string[];
}

/** Servers whose tool names we know. Other MCP servers get the generic treatment. */
const KNOWN_SERVERS = new Set(['', 'codiby-code', 'codiby-code-sdk']);

/** Built-in tools and Codiby's own MCP servers — the only ones a bare tool name can mean. */
export const isKnownServer = (server: string) => KNOWN_SERVERS.has(server);

export function splitToolName(full: string): { server: string; bare: string } {
  if (!full.startsWith('mcp__')) return { server: '', bare: full };
  const rest = full.slice(5);
  const i = rest.indexOf('__');
  return i < 0 ? { server: rest, bare: rest } : { server: rest.slice(0, i), bare: rest.slice(i + 2) };
}

const AGENT_INTERNAL = new Set([
  'remember', 'recall', 'forget', 'update_profile', 'people_find', 'people_upsert', 'people_list',
  'notify_user', 'schedule_reminder', 'list_reminders', 'cancel_reminder',
  // resolve_contact only reads the people directory; the send_message it leads to is what asks.
  'inbox_list', 'inbox_mark_read', 'channels_status', 'resolve_contact',
  'TodoWrite', 'Task', 'Agent', 'TaskOutput', 'TaskStop', 'KillShell', 'KillBash', 'Skill', 'EnterPlanMode', 'ToolSearch',
  // codiby-code-sdk bookkeeping
  'rename_session', 'post_system_note', 'post_image_to_session', 'suggest_archive', 'suggest_new_session',
  'mockup_write', 'mockup_edit', 'mockup_read', 'set_target', 'add_requirements', 'edit_requirement',
  'attach_requirement_image', 'propose_change', 'open_file_in_editor', 'kill_terminal',
]);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'BashOutput', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'read_terminal_output']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'ui_exec', 'spawn_terminal']);
const BROWSER_READ = new Set(['browser_snapshot', 'browser_take_screenshot', 'browser_screenshot', 'browser_close', 'browser_wait_for',
  'browser_console_messages', 'browser_network_requests', 'browser_scroll', 'browser_hover', 'browser_tabs', 'ui_browser_close']);
const BROWSER_NAV = new Set(['browser_open', 'browser_navigate', 'ui_browser_open']);
const BROWSER_ACT = new Set(['browser_click', 'browser_type', 'browser_press_key', 'browser_select_option', 'browser_handle_dialog',
  'browser_drag', 'browser_fill_form']);
const UI_DESTRUCTIVE = new Set(['ui_delete_session', 'ui_delete_automation', 'ui_delete_tab_group']);
const UNGUARDED_MODES = new Set(['bypassPermissions', 'acceptEdits']);

/** Providers name the same tools differently (Codex `Bash`/`Edit`, OpenCode `bash`/`edit`…). */
const ALIASES: Record<string, string> = {
  bash: 'Bash', shell: 'Bash', command_execution: 'Bash', commandExecution: 'Bash', local_shell: 'Bash', exec_command: 'Bash',
  edit: 'Edit', write: 'Write', patch: 'Edit', apply_patch: 'Edit', fileChange: 'Edit',
  read: 'Read', glob: 'Glob', grep: 'Grep', list: 'LS', webfetch: 'WebFetch', websearch: 'WebSearch', web_search: 'WebSearch',
};

const PURCHASE_WORDS = /\b(check\s?out|checkout|pay(ment)?s?|pay now|buy|buy now|purchase|place (your )?order|order now|complete order|confirm (order|purchase|payment)|subscribe|subscription|add to (cart|basket|bag)|cart|basket|billing|upgrade plan|donate|transfer|send money|wire|comprar|compra|pagar|pago|suscrib\w*|pedido|realizar pedido|finalizar compra|carrito|transferir|enviar dinero)\b/i;
/** 16–19 digits with optional separators: looks like a card number being typed. */
const CARD_NUMBER = /\b(?:\d[ -]?){15,18}\d\b/;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function shellCommandOf(input: Record<string, unknown>): string {
  const c = input.command ?? input.cmd ?? input.script ?? input.pattern;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every(x => typeof x === 'string')) {
    const argv = c as string[];
    // Codex wraps commands as ["bash", "-lc", "<script>"].
    const ci = argv.findIndex(x => /^-[a-z]*c[a-z]*$/.test(x));
    if (ci >= 0 && argv[ci + 1] && /(^|\/)(ba|z|da)?sh$/.test(argv[0] ?? '')) return argv[ci + 1]!;
    return argv.map(a => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
  }
  return '';
}

function filePathOf(input: Record<string, unknown>): string | undefined {
  const direct = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path) ?? str(input.filePath);
  if (direct) return direct;
  const changes = input.changes;
  if (Array.isArray(changes)) {
    const p = changes.map(c => (c && typeof c === 'object' ? str((c as Record<string, unknown>).path) : undefined)).find(Boolean);
    if (p) return p;
  }
  if (changes && typeof changes === 'object') return Object.keys(changes as object)[0];
  return undefined;
}

const SHELL_MAP: Record<ShellLevel, { category: PolicyCategory; qualifier?: string; label: string }> = {
  read_only: { category: 'shell', qualifier: 'read_only', label: 'Read-only command' },
  workspace_write: { category: 'write', qualifier: 'workspace', label: 'Command writing inside the workspace' },
  other: { category: 'shell', qualifier: 'other', label: 'Shell command' },
  send: { category: 'send_external', qualifier: 'shell', label: 'Sends a message from the shell' },
  credentials: { category: 'credentials', label: 'Command touching credentials' },
  destructive: { category: 'destructive', label: 'Destructive command' },
  bridge: { category: 'network', qualifier: 'bridge', label: 'Command calling this Codiby bridge' },
  agent_vault: { category: 'credentials', qualifier: 'agent_vault', label: "Command touching the agent's vault or the bridge's secrets" },
  catastrophic: { category: 'destructive', qualifier: 'catastrophic', label: 'Catastrophic command' },
};

function classifyShell(toolName: string, command: string, ctx: ClassifyContext, floorOther = false): Classification {
  const verdict = classifyCommand(command, ctx);
  const level: ShellLevel = floorOther && (verdict.level === 'read_only' || verdict.level === 'workspace_write') ? 'other' : verdict.level;
  const m = SHELL_MAP[level];
  return {
    category: m.category,
    qualifier: m.qualifier,
    summary: `${m.label}: ${clip(command.trim().replace(/\s+/g, ' '), 400)}`,
    target: command.trim(),
    reasons: verdict.reasons.length ? verdict.reasons : [level === 'read_only' ? 'Only reads' : `Runs via ${toolName}`],
  };
}

function classifyPath(bare: string, input: Record<string, unknown>, ctx: ClassifyContext, kind: 'read' | 'write'): Classification {
  const raw = filePathOf(input);
  const verb = kind === 'read' ? (bare === 'Grep' || bare === 'Glob' ? 'Search' : 'Read') : 'Edit';
  if (!raw) {
    if (kind === 'read') {
      const what = str(input.pattern) ?? str(input.query) ?? '';
      return { category: 'read', summary: `${verb}${what ? `: ${clip(what)}` : ' in the workspace'}`, target: what || undefined, reasons: ['Inside the working directory'] };
    }
    return { category: 'write', qualifier: 'outside', summary: `${verb} a file (no path given)`, reasons: ['No path to check'] };
  }
  const abs = resolveToolPath(raw, ctx.workspaceDir, ctx.home);
  const sensitivity = pathSensitivity(abs, ctx, raw);
  if (sensitivity === 'agent_vault') {
    return { category: 'credentials', qualifier: 'agent_vault', summary: `${verb} the agent's vault/config: ${abs}`, target: abs, reasons: ["The agent's own secrets and settings"] };
  }
  if (sensitivity === 'ssh' && kind === 'write') {
    return { category: 'destructive', qualifier: 'ssh', summary: `Change SSH keys/config: ${abs}`, target: abs, reasons: ['Writes to ~/.ssh'] };
  }
  if (sensitivity) {
    return { category: 'credentials', qualifier: sensitivity === 'ssh' ? 'ssh' : undefined, summary: `${verb} a credentials file: ${abs}`, target: abs, reasons: ['Holds secrets'] };
  }
  if (kind === 'read') return { category: 'read', summary: `${verb} ${abs}`, target: abs, reasons: [] };
  const inside = isInWorkspace(abs, ctx);
  return {
    category: 'write',
    qualifier: inside ? 'workspace' : 'outside',
    summary: `${verb} ${abs}${inside ? '' : ' (outside the workspace)'}`,
    target: abs,
    reasons: [inside ? 'Inside the workspace' : 'Outside the workspace'],
  };
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

const digits = (s: string) => s.replace(/\D+/g, '');

export function isOwnerRecipient(value: string, owner: OwnerIdentities): boolean {
  const v = value.trim().replace(/^(telegram|whatsapp|wa|tg|email|mailto):/i, '').trim();
  if (!v) return false;
  if (v.toLowerCase() === 'owner') return true;
  if (owner.telegramChatIds.some(id => id === v)) return true;
  if (v.includes('@') && !/@(s\.whatsapp\.net|lid|c\.us)$/i.test(v)) {
    return owner.emails.some(e => e.toLowerCase() === v.toLowerCase());
  }
  const d = digits(v.split('@')[0]!);
  return d.length >= 6 && owner.whatsappJids.some(j => digits(j.split('@')[0]!) === d);
}

const RECIPIENT_KEYS = ['to', 'recipient', 'recipients', 'peer', 'jid', 'chat_id', 'chatId', 'address', 'phone', 'number', 'email'];

function recipientsOf(input: Record<string, unknown>): string[] | null {
  let found = false;
  const out: string[] = [];
  for (const k of RECIPIENT_KEYS) {
    const v = input[k];
    if (v === undefined || v === null || v === '') continue;
    found = true;
    if (typeof v === 'string' || typeof v === 'number') {
      out.push(String(v));
    } else if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === 'string' || typeof x === 'number') out.push(String(x));
      }
    } else if (typeof v === 'object') {
      const peer = (v as Record<string, unknown>).peer ?? (v as Record<string, unknown>).id;
      if (typeof peer === 'string' || typeof peer === 'number') out.push(String(peer));
    }
  }
  return found ? out : null;
}

/**
 * "Ana López <5215550009999@s.whatsapp.net>" when the people directory knows
 * the address, else the address alone. The address is always shown: the
 * agent edits the directory without approval, so a name alone could be made
 * to say anything. For the same reason the name can't carry brackets or line
 * breaks — it must not pass for another address.
 */
function recipientLabel(address: string, channelId: string | undefined, ctx: ClassifyContext): string {
  let name: string | null = null;
  try { name = ctx.people?.nameFor(address, channelId) ?? null; } catch { /* the directory is a nicety here */ }
  const clean = name?.replace(/[<>\p{Cc}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return clean ? `${clean} <${address}>` : address;
}

function emailsIn(...values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const s = Array.isArray(v) ? v.filter(x => typeof x === 'string').join(',') : typeof v === 'string' ? v : '';
    for (const m of s.matchAll(/[^\s<>,;"'()]+@[^\s<>,;"'()]+\.[^\s<>,;"'()]+/g)) out.push(m[0]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// This bridge, as a URL
// ---------------------------------------------------------------------------

/** A URL aimed at this bridge: its secret endpoints are the vault (denied), the rest asks. */
function bridgeUrl(verb: string, url: string, ctx: ClassifyContext): Classification | null {
  const hit = bridgeAccess(url, ctx.bridgePort);
  if (!hit) return null;
  return hit.level === 'secret'
    ? { category: 'credentials', qualifier: 'agent_vault', summary: `${verb} ${clip(url)} (a secret endpoint of this bridge)`, target: url, reasons: [hit.reason] }
    : { category: 'network', qualifier: 'bridge', summary: `${verb} ${clip(url)} (this Codiby bridge)`, target: url, reasons: [hit.reason] };
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

function hasAttendees(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(x => typeof x === 'string' ? x.trim() !== '' : !!x);
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Changing an event only the owner is on is their own business; one with
 * guests reaches other people (invitations, updates, cancellations), so it
 * asks. An event the agent hasn't looked at in this conversation counts as
 * having guests: nobody here can say it doesn't.
 */
function classifyCalendarWrite(bare: string, input: Record<string, unknown>, ctx: ClassifyContext): Classification {
  const verb = bare.replace(/^calendar_/, '');
  const id = str(input.id) ?? str(input.event_id) ?? str(input.eventId);
  const title = str(input.summary) ?? str(input.title) ?? id ?? '';
  const base = `Calendar ${verb}${title ? `: ${clip(title)}` : ''}`;
  const target = title || undefined;
  if (hasAttendees(input.attendees)) {
    const who = emailsIn(input.attendees);
    return { category: 'calendar', qualifier: 'guests', summary: `${base} (guests: ${clip(who.join(', ') || 'yes', 160)})`, target, reasons: ['Other people get an invitation or an update'] };
  }
  if (bare === 'calendar_create') {
    return { category: 'calendar', qualifier: 'own', summary: `${base} (no guests)`, target, reasons: ['Only on the owner\'s calendar'] };
  }
  const guests = id ? ctx.calendar?.eventGuests(id) ?? null : null;
  if (guests === 0) {
    return { category: 'calendar', qualifier: 'own', summary: `${base} (no guests)`, target, reasons: ['The event has no other guests'] };
  }
  return guests === null
    ? { category: 'calendar', qualifier: 'guests', summary: `${base} (guests not checked)`, target, reasons: ["The event wasn't listed in this conversation, so it may have guests"] }
    : { category: 'calendar', qualifier: 'guests', summary: `${base} (${guests} other ${guests === 1 ? 'person' : 'people'} on it)`, target, reasons: ['Other people are on the event'] };
}

// ---------------------------------------------------------------------------
// Saved logins
// ---------------------------------------------------------------------------

/**
 * `site:<domain>` the way agent/google/secrets.ts names it (lower-case, no
 * trailing dot, IDN in punycode), so a rule pinned to one approval matches
 * the next call for the same site however the model spells it.
 */
export function loginTarget(raw: string): string | null {
  const m = /^\s*site:\s*(.+?)\s*$/i.exec(raw);
  if (!m) return null;
  const name = m[1]!.toLowerCase().replace(/\.$/, '');
  if (!/^[\p{L}\p{N}.-]+$/u.test(name)) return null;
  try {
    const host = new URL(`https://${name}`).hostname;
    return host && /^[a-z0-9.-]+$/.test(host) ? `site:${host}` : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

function classifyBrowserAction(bare: string, input: Record<string, unknown>, ctx: ClassifyContext): Classification {
  const name = str(input.name) ?? '';
  const ref = str(input.ref);
  const url = name ? ctx.browser?.pageUrl(name) ?? null : null;
  const label = name && ref ? ctx.browser?.refLabel(name, ref) ?? null : null;
  const typed = [str(input.text), str(input.element), str(input.key), Array.isArray(input.values) ? (input.values as unknown[]).filter(x => typeof x === 'string').join(' ') : undefined]
    .filter(Boolean).join(' ');
  const haystack = [url ?? '', label ?? '', typed, name].join(' • ');
  const where = [label ? clip(label.replace(/\s*\[ref=[^\]]+\]/, ''), 120) : null, url ? `on ${clip(url, 120)}` : null].filter(Boolean).join(' ');
  const verb = bare.replace(/^browser_/, '').replace(/_/g, ' ');
  if (PURCHASE_WORDS.test(haystack) || (bare === 'browser_type' && CARD_NUMBER.test(typed))) {
    return {
      category: 'purchase',
      summary: `Browser ${verb}${where ? ` — ${where}` : ''} (looks like a purchase or payment)`,
      target: [url, label].filter(Boolean).join(' ') || name,
      reasons: ['Page or element mentions checkout / payment'],
    };
  }
  if (bare === 'browser_evaluate') {
    return { category: 'other', qualifier: 'browser_script', summary: `Run JavaScript in the browser${where ? ` ${where}` : ''}`, target: url ?? name, reasons: ['Arbitrary script in a page'] };
  }
  if (bare === 'browser_file_upload') {
    return { category: 'send_external', qualifier: 'browser_upload', summary: `Upload a file in the browser${where ? ` ${where}` : ''}`, target: url ?? name, reasons: ['Sends a local file to a website'] };
  }
  return { category: 'other', qualifier: 'browser_action', summary: `Browser ${verb}${where ? ` — ${where}` : ''}`, target: url ?? name, reasons: [] };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function classifyToolCall(toolName: string, rawInput: unknown, ctx: ClassifyContext): Classification {
  const input = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {}) as Record<string, unknown>;
  const { server, bare: rawBare } = splitToolName(toolName);
  const known = KNOWN_SERVERS.has(server);
  const bare = known ? ALIASES[rawBare] ?? rawBare : rawBare;

  if (ALWAYS_AUTO_APPROVE_TOOLS.has(toolName)) {
    return { category: 'agent_internal', summary: `${rawBare} (always allowed)`, reasons: ['Bookkeeping tool with no outside effect'] };
  }
  if (USER_INTERACTION_TOOLS.has(bare)) {
    return { category: 'interaction', summary: bare === 'AskUserQuestion' ? 'Ask the owner a question' : 'Ask the owner to approve a plan', reasons: ['Always goes to the owner'] };
  }
  if (!known) {
    return { category: 'other', qualifier: 'mcp', summary: `${rawBare} on MCP server "${server}"`, target: clip(JSON.stringify(input), 300), reasons: [`Tool from the "${server}" MCP server`] };
  }

  if (SHELL_TOOLS.has(bare)) return classifyShell(bare, shellCommandOf(input), ctx);
  if (bare === 'send_terminal_input') return classifyShell(bare, str(input.text) ?? str(input.input) ?? '', ctx, true);
  if (bare === 'run_requirements') return { category: 'shell', qualifier: 'other', summary: 'Run the requirement checks (shell commands)', reasons: ['Runs shell commands'] };
  if (READ_TOOLS.has(bare)) return classifyPath(bare, input, ctx, 'read');
  if (WRITE_TOOLS.has(bare)) return classifyPath(bare, input, ctx, 'write');

  if (bare === 'WebFetch' || bare === 'WebSearch') {
    const target = str(input.url) ?? str(input.query) ?? '';
    if (bare === 'WebFetch') {
      const self = bridgeUrl('Fetch', target, ctx);
      if (self) return self;
    }
    return { category: 'network', qualifier: 'get', summary: `${bare === 'WebFetch' ? 'Fetch' : 'Search the web'}: ${clip(target)}`, target, reasons: ['Read-only web request'] };
  }

  if (AGENT_INTERNAL.has(bare)) return { category: 'agent_internal', summary: bare, reasons: ["The agent's own tool"] };

  if (bare === 'send_message') {
    const to = recipientsOf(input);
    const text = str(input.text) ?? str(input.message) ?? '';
    if (to && to.length && to.every(r => isOwnerRecipient(r, ctx.owner))) {
      return { category: 'agent_internal', qualifier: 'owner', summary: `Message the owner: ${clip(text, 160)}`, target: 'owner', reasons: ['Recipient is the owner'] };
    }
    const who = to?.join(', ') || '(no recipient given)';
    const named = to?.length ? to.map(r => recipientLabel(r, str(input.channelId), ctx)).join(', ') : who;
    // The target stays the bare address: it is what a rule pins, and a name can change.
    return { category: 'send_external', qualifier: 'message', summary: `Send a message to ${clip(named, 160)}: ${clip(text, 200)}`, target: who, reasons: [to ? 'Recipient is not the owner' : 'No recipient given'] };
  }

  if (bare.startsWith('gmail_')) {
    if (bare === 'gmail_search' || bare === 'gmail_read') {
      return { category: 'read', qualifier: 'mail', summary: `${bare === 'gmail_search' ? 'Search' : 'Read'} email${str(input.query) ? `: ${clip(str(input.query)!)}` : ''}`, target: str(input.query) ?? str(input.id), reasons: [] };
    }
    if (bare === 'gmail_send') {
      const rcpt = emailsIn(input.to, input.cc, input.bcc);
      const subject = str(input.subject) ?? '';
      if (rcpt.length && rcpt.every(r => isOwnerRecipient(r, ctx.owner))) {
        return { category: 'agent_internal', qualifier: 'owner', summary: `Email the owner: ${clip(subject, 160)}`, target: rcpt.join(', '), reasons: ['Every recipient is the owner'] };
      }
      return {
        category: 'send_external', qualifier: 'email',
        summary: `Send an email${rcpt.length ? ` to ${clip(rcpt.join(', '), 160)}` : str(input.draft_id) ? ' (saved draft)' : ''}${subject ? `: ${clip(subject, 160)}` : ''}`,
        target: rcpt.join(', ') || str(input.draft_id), reasons: ['Email leaves the account'],
      };
    }
    return { category: 'mail', summary: `${bare.replace(/^gmail_/, 'Email: ')}${str(input.subject) ? ` — ${clip(str(input.subject)!)}` : ''}`, target: str(input.id) ?? str(input.subject), reasons: [] };
  }

  if (bare.startsWith('calendar_')) {
    if (bare === 'calendar_list' || bare === 'calendar_freebusy') return { category: 'read', qualifier: 'calendar', summary: 'Read the calendar', reasons: [] };
    if (bare === 'calendar_create' || bare === 'calendar_update' || bare === 'calendar_delete') return classifyCalendarWrite(bare, input, ctx);
    const title = str(input.summary) ?? str(input.title) ?? str(input.event_id) ?? str(input.eventId) ?? '';
    return { category: 'calendar', summary: `Calendar ${bare.replace(/^calendar_/, '')}${title ? `: ${clip(title)}` : ''}`, target: title || undefined, reasons: ['Changes the calendar'] };
  }

  if (bare === 'browser_fill_secret') {
    // The tool fills only on the login's own site (fill-secret.ts), so the
    // site the model names is what the call can reach — and what a rule pins.
    const which = str(input.secret) ?? '';
    const site = loginTarget(which);
    const field = input.field === 'username' || input.field === 'password' ? `${input.field} ` : '';
    return {
      category: 'credentials', qualifier: 'browser_secret',
      summary: `Fill the saved ${field}login${site ? ` for ${site.slice('site:'.length)}` : which ? ` (${clip(which, 120)})` : ''} into the browser`,
      target: site ?? (which || undefined),
      reasons: ['Uses a stored password'],
    };
  }
  if (BROWSER_NAV.has(bare)) {
    const url = str(input.url) ?? str(input.action) ?? '';
    const self = bridgeUrl('Open', url, ctx);
    if (self) return self;
    return { category: 'network', qualifier: 'get', summary: `Open ${clip(url)} in the browser`, target: url, reasons: ['Browsing'] };
  }
  if (BROWSER_READ.has(bare)) return { category: 'read', qualifier: 'browser', summary: bare.replace(/_/g, ' '), target: str(input.name), reasons: [] };
  if (BROWSER_ACT.has(bare) || bare === 'browser_evaluate' || bare === 'browser_file_upload') return classifyBrowserAction(bare, input, ctx);

  if (bare.startsWith('phone_')) {
    if (bare === 'phone_reply_notification') {
      return { category: 'send_external', qualifier: 'phone', summary: `Reply from the phone: ${clip(str(input.text) ?? '', 160)}`, target: str(input.key) ?? str(input.id), reasons: ['Sends from the phone (it confirms on the device)'] };
    }
    if (bare === 'phone_act') return { category: 'other', qualifier: 'phone', summary: `Phone action: ${clip(JSON.stringify(input), 200)}`, reasons: ['The phone confirms sensitive actions'] };
    return { category: 'read', qualifier: 'phone', summary: bare.replace(/_/g, ' '), reasons: [] };
  }

  if (bare.startsWith('ui_')) return classifyUiTool(bare, input, ctx);

  return { category: 'other', summary: `${bare}: ${clip(JSON.stringify(input), 200)}`, target: clip(JSON.stringify(input), 300), reasons: ['Unknown tool'] };
}

/** Codiby UI tools are the agent's own business — except the few that escape the policy. */
function classifyUiTool(bare: string, input: Record<string, unknown>, ctx: ClassifyContext): Classification {
  if (UI_DESTRUCTIVE.has(bare)) {
    return { category: 'destructive', summary: `${bare.replace(/^ui_/, '').replace(/_/g, ' ')}: ${str(input.session_id) ?? str(input.id) ?? str(input.group_id) ?? ''}`, target: str(input.session_id) ?? str(input.id), reasons: ['Deletes permanently'] };
  }
  if (bare === 'ui_forward_port') {
    return { category: 'network', qualifier: 'expose', summary: `Expose port ${String(input.port ?? '?')} to the network`, target: String(input.port ?? ''), reasons: ['Opens an unauthenticated listener'] };
  }
  if (bare === 'ui_git_checkout') {
    return { category: 'write', qualifier: 'outside', summary: `git checkout ${str(input.branch) ?? ''} in ${str(input.cwd) ?? str(input.path) ?? 'a repository'}`, target: str(input.branch), reasons: ['Switches a working tree'] };
  }
  if (bare === 'ui_set_working_directory' || bare === 'ui_add_working_directory') {
    return { category: 'other', summary: `Change a session's folders: ${str(input.path) ?? ''}`, target: str(input.path), reasons: ['Widens what a session can reach'] };
  }
  if (bare === 'ui_create_automation' || bare === 'ui_update_automation' || bare === 'ui_run_automation') {
    return { category: 'other', qualifier: 'delegation', summary: `${bare.replace(/^ui_/, '').replace(/_/g, ' ')}: ${clip(str(input.name) ?? str(input.prompt) ?? str(input.id) ?? '', 160)}`, target: str(input.id) ?? str(input.name), reasons: ['Runs a prompt later, outside this conversation'] };
  }
  if (bare === 'ui_spawn_session') {
    const mode = str(input.permissionMode) ?? str(input.permission_mode);
    if (mode && UNGUARDED_MODES.has(mode)) {
      return { category: 'other', qualifier: 'delegation', summary: `Start a ${mode} session: ${clip(str(input.prompt) ?? str(input.name) ?? '', 160)}`, target: mode, reasons: ['That session would act without approvals'] };
    }
    return { category: 'agent_internal', summary: `Start a session: ${clip(str(input.name) ?? str(input.prompt) ?? '', 160)}`, reasons: ['Its own tool calls still ask for approval'] };
  }
  if (bare === 'ui_update_session' && (str(input.permission_mode) ?? str(input.permissionMode))) {
    return { category: 'other', qualifier: 'delegation', summary: `Change a session's permission mode to ${str(input.permission_mode) ?? str(input.permissionMode)}`, target: str(input.session_id), reasons: ['Changes how a session is supervised'] };
  }
  if (bare === 'ui_send_message') {
    const sid = str(input.session_id) ?? '';
    const remote = !!str(input.host_id);
    const mode = remote ? null : ctx.sessionMode?.(sid) ?? null;
    if (remote || (mode && UNGUARDED_MODES.has(mode))) {
      return { category: 'other', qualifier: 'delegation', summary: `Instruct ${remote ? 'a session on another host' : `a ${mode} session`}: ${clip(str(input.text) ?? '', 200)}`, target: sid, reasons: ['That session may act without approvals'] };
    }
    return { category: 'agent_internal', summary: `Message session ${sid}: ${clip(str(input.text) ?? '', 200)}`, target: sid, reasons: ['Its own tool calls still ask for approval'] };
  }
  return { category: 'agent_internal', summary: bare.replace(/^ui_/, 'Codiby: ').replace(/_/g, ' '), reasons: ['Codiby UI tool'] };
}

/** `category` and `category:qualifier` — what rules match against. */
export function categoryKeys(c: Pick<Classification, 'category' | 'qualifier'>): string[] {
  return c.qualifier ? [c.category, `${c.category}:${c.qualifier}`] : [c.category];
}
