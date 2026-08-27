/**
 * MCP Server for Codiby Code.
 * Integrated into the HTTP server via WebStandardStreamableHTTPServerTransport.
 * Handles /mcp route — Claude connects via SSE.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import { corsHeaders, MAIN_SESSION_ID } from '../config/config';
import { log } from '../lib/logger';
import { sessions, sessionToJSON, saveSessions } from '../session/sessions';
import {
  handleCreateSession,
  handleRestartSession,
  handleRenameSession,
  handleDeleteSession,
} from '../handlers/sessions';
import { addMessage, getSessionState } from '../session/state';
import type { ChatMessage } from '../session/state';
import { createWorktree, applyWorktreeSetup } from '../handlers/worktree';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { extname, basename } from 'path';
import { saveResource, purgeSessionResources } from '../handlers/resources';
import {
  IMAGE_MEDIA_TYPES,
  mockupsFor,
  sanitizeMockupName,
  persistMockup,
  loadMockup,
  listPersistedMockups,
  sanitizeBrowserUrl,
  sanitizeBrowserName,
  sanitizeCookieJar,
  setBrowserPreview,
  getBrowserPreview,
} from '../provider/sdk-tools';
import { findPendingDecision, requestPermissionDecision } from '../provider/bridge';
import type { PermissionDecision } from '../provider/types';
import {
  PortInUseError,
  closePortForward,
  getPortForward,
  isTargetListening,
  listPortForwards,
  openPortForward,
} from '../network/port-forward';
import type { SessionPortForward } from '../network/port-forward';
import { publishedPortUrl, publishedUrlIsGuess } from '../network/remote-viewer';

/** How often a tool that's blocked on the user pokes the connection so Bun's
 *  `idleTimeout` doesn't reap it mid-review. Comfortably under the 10s default
 *  so it still helps a client running the old settings. */
const HEARTBEAT_MS = 4000;

/** Palette for auto-assigning a tab-group colour when the caller doesn't pick.
 *  Matches the set in ChatApp.tsx#handleCreateGroup so new server-made groups
 *  look indistinguishable from client-made ones. */
const GROUP_COLORS = ['blue', 'green', 'amber', 'violet', 'red', 'pink'];

/** Modes a caller may set through `ui_update_session`. `loop` is deliberately
 *  absent — arming a loop is a user action driven by /sessions/:id/loop/start. */
const SETTABLE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

type TabGroup = { id: string; name: string; color: string; cwd?: string; icon?: string };

// ---------------------------------------------------------------------------
// In-process deps — wired from index.ts after the HTTP server starts. Lets the
// cross-session tools (spawn/list/send) call bridge functions directly instead
// of round-tripping through HTTP. The legacy `ui_*` tools (search, git, exec)
// still use `fetch` against localhost because they hit endpoints that do real
// work in their own modules; migrating them is a separate cleanup.
// ---------------------------------------------------------------------------

type McpDeps = {
  port: number;
  sendMessageToSession: (
    sessionId: string,
    text: string,
    images?: { media_type: string; data: string }[],
  ) => Promise<{ ok: boolean; error?: string }>;
  broadcastSessionList: () => void;
  /** Push a WS message to every client subscribed to a single session.
   *  Used by the new ui_open_file_in_editor / ui_post_system_note /
   *  ui_post_image_to_session / ui_mockup_* tools to render side-panel
   *  state changes in the chat tab the model is running in. */
  broadcastToSession: (sessionId: string, msg: object) => void;
  /** Merge-patch the UI preferences blob, persist, and broadcast to frontends. */
  updatePreferences: (partial: Record<string, unknown>) => Record<string, unknown>;
  /** Read the current preferences blob (tabGroups, tabGroupMap, etc.). */
  loadPreferences: () => Record<string, unknown>;
  /** Apply the `autoGroupSessions` preference to a freshly-created session.
   *  No-op if the preference is off or the session was already grouped. */
  maybeAutoGroupSession: (sessionId: string, cwd: string) => void;
  /** Persist and apply a permission mode change for an MCP-owned session. */
  setSessionPermissionMode: (sessionId: string, mode: 'plan' | 'acceptEdits') => Promise<boolean>;
};

let _deps: McpDeps | null = null;
let _serverPort = 3111;

export function setMcpDeps(deps: McpDeps) {
  _deps = deps;
  _serverPort = deps.port;
}

// ---------------------------------------------------------------------------
// Session CRUD helpers — shared by ui_update_session / ui_archive_session /
// ui_unarchive_session / ui_delete_session. These deliberately route through
// the same handlers the HTTP routes use so the bun server stays the single
// source of truth for `ui-sessions.json`; the MCP layer only validates input
// and broadcasts.
// ---------------------------------------------------------------------------

type SessionPatch = { name?: string; status?: 'open' | 'archived'; permissionMode?: string };

export function canRenameOwnedSession(owningSessionId: string, targetSessionId: string): boolean {
  return !!owningSessionId && owningSessionId === targetSessionId;
}

/** Apply a patch through `handleRenameSession` (the `PATCH /sessions/:id`
 *  handler), then broadcast so every open tab repaints without a restart.
 *  Also pushes a permission-mode change to the live provider, matching what
 *  the `set_permission_mode` WS frame does — a PATCH alone would leave a
 *  running provider on the old mode. */
async function patchSessionViaHandler(
  sessionId: string,
  patch: SessionPatch,
): Promise<{ ok: true; session: Record<string, unknown> } | { ok: false; error: string }> {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: `Session not found: ${sessionId}` };
  // The Telegram bridge and the pinned first tab both hold a hard reference to
  // MAIN_SESSION_ID, and the tab bar only renders `status === 'open'` sessions
  // — archiving it would make the bot's tab vanish with no way back from the
  // UI. The desktop client special-cases it the same way (ChatApp#handleCloseTab).
  if (patch.status === 'archived' && sessionId === MAIN_SESSION_ID) {
    return {
      ok: false,
      error: 'Cannot archive the main session — the Telegram bridge references it and the UI pins its tab. Use `/clear` on that tab to reset its history instead.',
    };
  }
  // Leaving loop mode is a user action, over POST /sessions/:id/loop/stop —
  // silently flipping the mode here would leave the loop driver re-injecting
  // prompts into a session that no longer reports itself as looping.
  if (patch.permissionMode !== undefined && session.permissionMode === 'loop') {
    return {
      ok: false,
      error: `Session ${sessionId} is in loop mode. Stop the loop from the UI (or POST /sessions/${sessionId}/loop/stop) before changing its permission mode.`,
    };
  }

  const req = new Request(`http://internal/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const resp = await handleRenameSession(sessionId, req);
  const data = await resp.json() as Record<string, unknown>;
  if (!resp.ok) {
    return { ok: false, error: typeof data.error === 'string' ? data.error : `HTTP ${resp.status}` };
  }
  if (patch.permissionMode !== undefined && session.providerSession) {
    try { await session.providerSession.setPermissionMode(patch.permissionMode as never); } catch {}
  }
  _deps?.broadcastSessionList();
  return { ok: true, session: data };
}

/** Normalize the `session_id` / `session_ids` pair the archive/unarchive tools
 *  accept into a deduped, order-preserving list. */
function collectSessionIds(args: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v !== 'string') return;
    const id = v.trim();
    if (id && !out.includes(id)) out.push(id);
  };
  push(args?.session_id);
  if (Array.isArray(args?.session_ids)) for (const v of args!.session_ids as unknown[]) push(v);
  return out;
}

/** Flip `status` on one or more sessions and report per-id outcomes so a batch
 *  archive doesn't fail wholesale on a single bad id. */
async function setSessionsStatus(
  ids: string[],
  status: 'open' | 'archived',
): Promise<{ text: string; isError: boolean }> {
  const done: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    const result = await patchSessionViaHandler(id, { status });
    if (result.ok) {
      const name = typeof result.session.name === 'string' ? result.session.name : id;
      done.push(`${id} — ${name}`);
    } else {
      failed.push(`${id} — ${result.error}`);
    }
  }
  const verb = status === 'archived' ? 'Archived' : 'Unarchived';
  const parts: string[] = [];
  if (done.length) parts.push(`${verb} ${done.length} session${done.length === 1 ? '' : 's'}:\n${done.map(l => `  ${l}`).join('\n')}`);
  if (failed.length) parts.push(`Failed ${failed.length}:\n${failed.map(l => `  ${l}`).join('\n')}`);
  return { text: parts.join('\n\n'), isError: done.length === 0 };
}

function createMcpServer(uiSessionId: string) {
  const mcpServer = new Server(
    { name: 'codiby-code', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

async function api(path: string, opts?: RequestInit): Promise<any> {
  const resp = await fetch(`http://localhost:${_serverPort}${path}`, opts);
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

// Register tools
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ui_search',
      description: 'Search file contents using ripgrep across the project',
      inputSchema: {
        type: 'object' as const,
        properties: {
          root: { type: 'string', description: 'Root directory to search in' },
          query: { type: 'string', description: 'Search query (regex supported)' },
        },
        required: ['root', 'query'],
      },
    },
    {
      name: 'ui_git_branches',
      description: 'List local and remote git branches',
      inputSchema: {
        type: 'object' as const,
        properties: { cwd: { type: 'string', description: 'Repository directory' } },
        required: ['cwd'],
      },
    },
    {
      name: 'ui_git_checkout',
      description: 'Checkout a git branch',
      inputSchema: {
        type: 'object' as const,
        properties: {
          cwd: { type: 'string', description: 'Repository directory' },
          branch: { type: 'string', description: 'Branch name to checkout' },
        },
        required: ['cwd', 'branch'],
      },
    },
    {
      name: 'ui_git_status',
      description: 'Get git modified files (staged and unstaged)',
      inputSchema: {
        type: 'object' as const,
        properties: { root: { type: 'string', description: 'Repository directory' } },
        required: ['root'],
      },
    },
    {
      name: 'ui_prs',
      description: 'List GitHub pull requests for a repository',
      inputSchema: {
        type: 'object' as const,
        properties: {
          cwd: { type: 'string', description: 'Repository directory' },
          session: { type: 'string', description: 'Session name for matching (optional)' },
        },
        required: ['cwd'],
      },
    },
    {
      name: 'ui_exec',
      description: 'Execute a shell command and return the output',
      inputSchema: {
        type: 'object' as const,
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          cwd: { type: 'string', description: 'Working directory' },
        },
        required: ['command', 'cwd'],
      },
    },
    {
      name: 'ui_forward_port',
      description:
        'Publish a port running on THIS machine so the user\'s browser can reach it.\n\n' +
        'Use this whenever the user is viewing Codiby Code from another computer (the system prompt says so when they are) ' +
        'and you want to hand them a URL for something you started — a dev server, a preview, an API, a docs site. ' +
        'Their browser cannot open `localhost` here; this binds the port on every network interface and returns the URL that does work.\n\n' +
        'Raw TCP, so HTTP, WebSockets and TLS all pass through.\n\n' +
        'Leave `public_port` unset and the tool picks one — it mirrors `port` when it can, otherwise any free port; ' +
        'either way the URL it returns is the one to use. Set `public_port` explicitly and a conflict is an ERROR: ' +
        'the tool answers "already in use" and you must pick a different number rather than retry the same one.\n\n' +
        'The published port has no authentication in front of it: anyone who can route to this machine can reach the service. ' +
        'Forward what the user asked to see, not everything you have running. The forward lives until you close it or the session ends.\n\n' +
        'Not needed for browser-automation tools (`browser_open`, `browser_navigate`) — those drive a browser on this machine and can use `localhost` directly.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          port: { type: 'number', description: 'The local port the service is listening on, e.g. 5173 for Vite.' },
          public_port: {
            type: 'number',
            description: 'Port to bind publicly. Omit it unless the user needs a specific number — the tool then mirrors `port` when free and falls back to any free port. Naming one makes a conflict an error.',
          },
          host: {
            type: 'string',
            description: 'Interface the service is dialled on. Defaults to "127.0.0.1"; only set it if the service binds somewhere else.',
          },
          label: { type: 'string', description: 'Short note about what is behind the port, e.g. "vite dev". Shown in ui_list_port_forwards.' },
        },
        required: ['port'],
      },
    },
    {
      name: 'ui_list_port_forwards',
      description:
        'List the ports this session has published with `ui_forward_port`, with the URL for each. ' +
        'Check here before forwarding again — a port you already published does not need a second forward.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'ui_close_port_forward',
      description:
        'Take down a port published by `ui_forward_port`. Call it once the process behind the port is gone, ' +
        'or when the user asks you to stop exposing it. Only forwards owned by this session can be closed.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          public_port: { type: 'number', description: 'The published port to close — the `public_port` from ui_list_port_forwards, not the local target port.' },
        },
        required: ['public_port'],
      },
    },
    {
      name: 'ui_list_sessions',
      description: 'List all Codiby Code sessions (chat tabs). Returns each session\'s id, name, status, and working directory. Use this to find the session_id to pass to ui_send_message. When mentioning any of these sessions to the user, link to them as `[Session Name](codiby-session:<id>)` rather than printing the raw id — the UI renders that as a clickable chip.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'ui_spawn_session',
      description:
        'Spawn a new Codiby Code session (a new chat tab) and start its provider. ' +
        'Use this to delegate work to a fresh session while the current one stays focused on something else. ' +
        'Returns the new session id, which you pass to ui_send_message.\n\n' +
        '`cwd` is REQUIRED — explicitly choose the directory the new session opens in.\n\n' +
        'Set `initial_message` to send the first user message immediately after the session is created.\n\n' +
        'To run the session inside a fresh git worktree instead of `cwd` directly, set `worktree`. ' +
        'The worktree is created at `<cwd>/.worktrees/<branch>`. `cwd` is then treated as the SOURCE repo, ' +
        'and the new session\'s actual cwd becomes the worktree path. Omit `worktree` to use `cwd` as-is.\n\n' +
        'The `worktree` object can also mirror the create-worktree modal: `copy_env` copies `.env`, ' +
        '`link_node_modules` symlinks `node_modules` (fast), `copy_node_modules` does a full copy, and ' +
        '`install_deps` (with optional `package_manager`) runs a fresh install.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          cwd: {
            type: 'string',
            description:
              'REQUIRED. Absolute working directory for the new session. ' +
              'When `worktree` is set, this is treated as the SOURCE git repo (must be inside a git repo) ' +
              'and the session\'s actual cwd becomes the new worktree path.',
          },
          name: { type: 'string', description: 'Optional session name shown in the tab bar.' },
          model: { type: 'string', description: 'Optional model override (e.g. "opus", "sonnet", "haiku", or a full model id). Leave unset for the default.' },
          permissionMode: { type: 'string', enum: ['default', 'acceptEdits', 'plan', 'bypassPermissions'], description: 'Optional permission mode. Defaults to "default".' },
          provider: { type: 'string', description: 'Optional provider name. Defaults to the configured default (claude).' },
          initial_message: { type: 'string', description: 'Optional first user message to send after creating the session.' },
          group_id: { type: 'string', description: 'Optional tab-group id to add the new session to (from ui_list_tab_groups or ui_create_tab_group).' },
          worktree: {
            type: 'object',
            description:
              'Optional. When set, a git worktree is created before the session starts and used as its cwd. ' +
              'Omit this field entirely to skip worktree creation and use `cwd` as-is.',
            properties: {
              branch: {
                type: 'string',
                description: 'Branch name for the worktree. Sanitized to [a-zA-Z0-9_\\-/.]; other chars become "-".',
              },
              new_branch: {
                type: 'boolean',
                description:
                  'true  = create `branch` as a NEW branch in the worktree. Fails if the branch already exists. ' +
                  'false = attach an EXISTING branch to a new worktree. Fails if the branch does not exist. ' +
                  '`source_branch` and `pull_source` are ignored when new_branch is false.',
              },
              source_branch: {
                type: 'string',
                description:
                  'Only used when `new_branch` is true. Branch to base the new branch on. ' +
                  'Omit to branch from current HEAD of the source repo.',
              },
              pull_source: {
                type: 'boolean',
                description:
                  'Only used when `new_branch` is true AND `source_branch` is set. ' +
                  'true = run `git fetch origin "<source_branch>"` first and use `origin/<source_branch>` as the start-point ' +
                  '(so the worktree picks up the latest remote commits without touching the local checkout). ' +
                  'On fetch failure, falls back to the local `<source_branch>`. Defaults to false.',
              },
              copy_env: {
                type: 'boolean',
                description: 'Copy `.env` from the source repo into the worktree (skipped if absent or already present). Defaults to false.',
              },
              install_deps: {
                type: 'boolean',
                description: 'Run the package manager install in the worktree. Mutually exclusive with copy/link node_modules. Defaults to false.',
              },
              copy_node_modules: {
                type: 'boolean',
                description: 'Copy `node_modules` from the source repo into the worktree (full tar copy). Defaults to false.',
              },
              link_node_modules: {
                type: 'boolean',
                description: 'Symlink `node_modules` from the source repo into the worktree (fast, shares one install). Defaults to false.',
              },
              package_manager: {
                type: 'string',
                enum: ['npm', 'bun', 'yarn', 'pnpm'],
                description: 'Package manager to use when `install_deps` is true. Defaults to "npm".',
              },
            },
            required: ['branch', 'new_branch'],
          },
        },
        required: ['cwd'],
      },
    },
    {
      name: 'ui_send_message',
      description: 'Send a user message to an existing Codiby Code session by id. Auto-starts the session\'s provider if it is currently idle. Fire-and-forget — Claude\'s response streams into that session\'s chat log; use ui_list_sessions (or run this tool again later) to observe progress.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Id of the target session (from ui_list_sessions or ui_spawn_session).' },
          text: { type: 'string', description: 'Message text to send as the user.' },
        },
        required: ['session_id', 'text'],
      },
    },
    {
      name: 'ui_read_session_messages',
      description: 'Read the chat message log of another Codiby Code session. Use to check a session\'s progress after ui_send_message, inspect another tab\'s context, or pull a final answer out of a sibling session. Returns messages in chronological order (oldest first). Long text, tool inputs, and tool results are truncated — raise max_chars_per_message if you need more.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Id of the session to read (from ui_list_sessions).' },
          limit: { type: 'number', description: 'Max number of most-recent messages to return. Default 20. Pass 0 for no limit.' },
          since_seq: { type: 'number', description: 'If set, only return messages with seq strictly greater than this. Useful for polling for new messages after a previous read.' },
          include_tools: { type: 'boolean', description: 'Include tool_use and tool_result messages. Default true. Set false for a cleaner user/assistant transcript.' },
          max_chars_per_message: { type: 'number', description: 'Per-message truncation cap. Default 500. Pass 0 to disable truncation.' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'ui_update_session',
      description:
        'Update an existing Codiby Code session (chat tab) by id. Pass only the fields you want to change — omitted fields are left alone.\n\n' +
        'A session may only rename itself; use ui_rename_session for that. Cross-session name changes are rejected to prevent one tab from receiving another tab\'s title.\n\n' +
        '`status` controls tab visibility and is fully reversible: `archived` hides the tab (the session, its history and its worktree all stay on disk), `open` brings it back. ' +
        'Prefer ui_archive_session / ui_unarchive_session for the common case — they take a list of ids. ' +
        'To destroy a session for good, use ui_delete_session instead (irreversible).\n\n' +
        'The main session (the Telegram bridge\'s pinned tab) cannot be archived.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Id of the session to update (from ui_list_sessions).' },
          name: { type: 'string', description: 'New session name shown in the tab bar. Aim for ≤ 24 chars.' },
          status: {
            type: 'string',
            enum: ['open', 'archived'],
            description: 'UI lifecycle. `archived` hides the tab (reversible, nothing is deleted); `open` restores it.',
          },
          permission_mode: {
            type: 'string',
            enum: SETTABLE_PERMISSION_MODES,
            description: 'Permission mode for the session. Applied to the running provider too. Rejected while the session is in loop mode.',
          },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'ui_archive_session',
      description:
        'Archive (close) one or more Codiby Code sessions — shortcut for ui_update_session with `status: "archived"`.\n\n' +
        'REVERSIBLE: archiving only hides the tab from the tab bar. The session record, its chat history, and its git worktree are all left untouched, and ui_unarchive_session brings it straight back. ' +
        'This is what you want when the user asks to "close", "clean up", or "get rid of" tabs. ' +
        'Do NOT reach for ui_delete_session unless the user explicitly wants the session destroyed.\n\n' +
        'Pass `session_ids` to archive several tabs in one call. The main session (Telegram bridge) cannot be archived. Archiving does not stop the underlying provider process.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Id of a session to archive. Use `session_ids` for several at once.' },
          session_ids: { type: 'array', items: { type: 'string' }, description: 'Ids of the sessions to archive. Combined with `session_id` if both are given.' },
        },
      },
    },
    {
      name: 'ui_unarchive_session',
      description:
        'Bring one or more archived Codiby Code sessions back into the tab bar — shortcut for ui_update_session with `status: "open"`. ' +
        'Does NOT auto-resume the provider; that happens lazily when the tab is focused or a message is sent. ' +
        'Use ui_list_sessions to find archived ids (they show as `[archived/…]`).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Id of a session to restore. Use `session_ids` for several at once.' },
          session_ids: { type: 'array', items: { type: 'string' }, description: 'Ids of the sessions to restore. Combined with `session_id` if both are given.' },
        },
      },
    },
    {
      name: 'ui_delete_session',
      description:
        'PERMANENTLY delete a Codiby Code session. IRREVERSIBLE — there is no undo and no trash. ' +
        'Only call this when the user explicitly asked to delete/destroy the session; if they merely want the tab out of the way, call ui_archive_session instead (reversible).\n\n' +
        'What each flag destroys:\n' +
        '  • default (both flags false) — removes the session record and stops its provider. The chat history stays on disk, so the transcript is still recoverable by hand, but the tab is gone from the UI.\n' +
        '  • `purge: true` — ALSO deletes the on-disk chat history and UI state for the session. The conversation is unrecoverable.\n' +
        '  • `remove_worktree: true` — ALSO deletes the git worktree at the session\'s cwd from disk (only when the cwd matches the `.worktrees/<branch>` convention, or the legacy `.wt/<branch>`). Uncommitted work in that worktree is LOST.\n\n' +
        'Both flags default to false and must be opted into explicitly. The session\'s stored images/mockups are dropped either way. The main session cannot be deleted.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Id of the session to delete permanently (from ui_list_sessions).' },
          purge: {
            type: 'boolean',
            description: 'Also delete the on-disk chat history + UI state, making the conversation unrecoverable. Defaults to false.',
          },
          remove_worktree: {
            type: 'boolean',
            description: 'Also remove the git worktree at the session\'s cwd (only for `.worktrees/<branch>` or legacy `.wt/<branch>` paths). Destroys uncommitted work there. Defaults to false.',
          },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'ui_list_tab_groups',
      description: 'List all tab groups in Codiby Code, including each group\'s members. Use before moving sessions around so you know the existing groups and pick the right id.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'ui_create_tab_group',
      description: 'Create a new tab group. Returns the new group id. If session_ids is provided, those sessions are added to the group immediately.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Group name shown in the tab bar.' },
          color: { type: 'string', enum: GROUP_COLORS, description: 'Optional color. Auto-cycles from the palette if unset.' },
          icon: { type: 'string', description: 'Optional emoji/icon for the group. Omit for the colored dot default.' },
          cwd: { type: 'string', description: 'Optional default cwd for sessions created in this group.' },
          session_ids: { type: 'array', items: { type: 'string' }, description: 'Optional list of session ids to add to the new group.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'ui_rename_tab_group',
      description: 'Update a tab group\'s name, color, icon, or default cwd. Pass only the fields you want to change.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          group_id: { type: 'string', description: 'Id of the group to update.' },
          name: { type: 'string' },
          color: { type: 'string', enum: GROUP_COLORS },
          icon: { type: 'string', description: 'Emoji/icon, or empty string to clear and revert to the colored dot.' },
          cwd: { type: 'string' },
        },
        required: ['group_id'],
      },
    },
    {
      name: 'ui_delete_tab_group',
      description: 'Delete a tab group. Its member sessions are ungrouped (not deleted).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          group_id: { type: 'string', description: 'Id of the group to delete.' },
        },
        required: ['group_id'],
      },
    },
    {
      name: 'ui_move_session_to_group',
      description: 'Move a session into a tab group, or ungroup it. If `group_id` is omitted or empty, the session is removed from any group.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Id of the session to move.' },
          group_id: { type: 'string', description: 'Target group id. Empty string or omitted to ungroup.' },
        },
        required: ['session_id'],
      },
    },
    // ---------------------------------------------------------------
    // Per-session UI tools — mirrored from the in-process SDK MCP so
    // they're reachable from opencode/Codex over HTTP. The owning
    // session id comes from the `x-session-id` header set by the
    // adapter at MCP-server creation time, so the LLM doesn't need
    // to pass session_id explicitly for these.
    // ---------------------------------------------------------------
    {
      name: 'EnterPlanMode',
      description: 'Enter plan mode for the current session before investigating or proposing a multi-step change. In plan mode, inspect the codebase and present a plan; do not make changes. Call ExitPlanMode with the completed plan when ready for user approval.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'ExitPlanMode',
      description: 'Present a completed implementation plan for user approval and leave plan mode if approved. Call only after investigating the codebase. The plan must be actionable and state the files and verification steps.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          plan: { type: 'string', description: 'Completed Markdown implementation plan for the user to review.' },
        },
        required: ['plan'],
      },
    },
    {
      name: 'ui_open_file_in_editor',
      description: 'Open a file in the editor side-panel of Codiby Code (the chat tab the model is running in). Use when the user would benefit from reviewing a file inline alongside the chat. Optional `line` jumps to a specific line.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Absolute path of the file to open.' },
          line: { type: 'number', description: '1-based line number to jump to.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'ui_rename_session',
      description: 'Rename the current Codiby Code session (the chat tab the model is running in). Aim for ≤ 24 chars. Format: "{TICKET-ID} {SHORT DESCRIPTION}". Call once per session — the user can rename manually after.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'New session name. Aim for ≤ 24 chars so it fits a narrow tab. Format: "{TICKET-ID} {3-4 word description}". Omit ticket id if none was mentioned.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'ui_restart_session',
      description: 'Restart the current Codiby Code session — close the underlying Claude/Codex/OpenCode provider and re-spawn it with the same session id, preserving the conversation history. Use when the provider is in a bad state (stuck tool, broken connection, stale context) and a clean respawn is the cheapest fix. The user can trigger this themselves via `/restart`, the command palette, or the provider-chip context menu.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'ui_post_system_note',
      description: "Post a non-model system note into the current session's chat log (separator-style). Use sparingly for status updates the user should see (e.g. \"Deployed commit abc123\"). Not visible to the model in future turns.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          content: { type: 'string', description: 'Short note text (<= 500 chars).' },
        },
        required: ['content'],
      },
    },
    {
      name: 'ui_post_image_to_session',
      description: "Post an image into the current session's chat log inline. Reads the file from a local absolute path and embeds it as base64 — supported formats: PNG, JPEG, GIF, WebP. Not visible to the model in future turns.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Absolute path to an image file (.png, .jpg, .jpeg, .gif, or .webp).' },
          caption: { type: 'string', description: 'Optional short caption shown beneath the image (<= 500 chars).' },
        },
        required: ['path'],
      },
    },
    {
      name: 'ui_mockup_write',
      description: 'Create or replace an HTML mockup and open it in the live preview side-panel of the current session. Authors a self-contained HTML document (inline CSS/JS, CDN scripts allowed; sandboxed iframe). Replaces any existing mockup with the same `name`. Persisted to ~/.codiby/mockups/<sessionId>/<name>.html.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Identifier for this mockup (letters, digits, dot, dash, underscore, space; 1–80 chars; no slashes). Reuse the same name to update the same preview.' },
          html: { type: 'string', description: 'Full HTML document. Inline all CSS/JS — the iframe is sandboxed and cannot reach the parent. CDN scripts/fonts work.' },
        },
        required: ['name', 'html'],
      },
    },
    {
      name: 'ui_mockup_edit',
      description: 'Edit an existing HTML mockup by replacing a string, then re-render and rewrite the file on disk. `old_string` must occur exactly once unless `replace_all` is true. Falls back to disk when the in-memory copy was lost.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Name of the mockup to edit (must already exist on disk or in memory).' },
          old_string: { type: 'string', description: 'Exact substring to replace. Must match uniquely unless replace_all is true.' },
          new_string: { type: 'string', description: 'Replacement text (may be empty to delete).' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' },
        },
        required: ['name', 'old_string', 'new_string'],
      },
    },
    {
      name: 'ui_mockup_read',
      description: 'Read the current HTML source of a mockup previously created with `ui_mockup_write`. Useful before calling `ui_mockup_edit`. Looks in memory first, then falls back to disk.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Name of the mockup to read.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'ui_browser_open',
      description: 'Open an http(s) URL in a named browser preview tab inside Codiby Code. Multiple previews can co-exist per session — choose a stable kebab/snake-case `name` (e.g. "qa-admin-workflow") and reuse it for follow-up tools. Re-opening with the same name navigates the existing preview without losing state. Use `cookieJar` to isolate cookies across previews; previews sharing the same jar share cookies/storage, different jars are isolated. Omitting `cookieJar` uses the shared "default" jar.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Stable identifier for this browser preview within the session. Letters/digits/dash/underscore only, 1–40 chars, must start with a letter or digit. Example: "qa-admin-workflow".' },
          url: { type: 'string', description: 'Absolute http:// or https:// URL.' },
          title: { type: 'string', description: 'Short label shown in the panel tab. Defaults to the `name`.' },
          cookieJar: { type: 'string', description: 'Cookie jar name. Previews sharing the same jar share cookies; different jars are isolated. Letters/digits/dash/underscore only, 1–40 chars, must start with a letter or digit. Defaults to "default".' },
        },
        required: ['name', 'url'],
      },
    },
    {
      name: 'ui_browser_close',
      description: 'Close a named browser preview for the current session. Other previews stay open. No-op if the named preview wasn\'t open.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'The `name` passed to ui_browser_open. The preview must still be open.' },
        },
        required: ['name'],
      },
    },
  ],
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case 'ui_search': {
        const params = new URLSearchParams({ root: args!.root as string, q: args!.query as string });
        const data = await api(`/search?${params}`);
        const results = (data.results || []).map((r: any) => `${r.file}:${r.line}: ${r.text}`).join('\n');
        return { content: [{ type: 'text', text: results || 'No results found' }] };
      }
      case 'ui_git_branches': {
        const data = await api(`/git-branches?cwd=${encodeURIComponent(args!.cwd as string)}`);
        const local = (data.local || []).map((b: string) => `  ${b === data.current ? '* ' : '  '}${b}`).join('\n');
        const remote = (data.remote || []).map((b: string) => `  ${b}`).join('\n');
        return { content: [{ type: 'text', text: `Current: ${data.current}\n\nLocal:\n${local}\n\nRemote:\n${remote}` }] };
      }
      case 'ui_git_checkout': {
        const data = await api('/git-checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: args!.cwd, branch: args!.branch }) });
        return { content: [{ type: 'text', text: data.ok ? `Checked out: ${data.branch}` : `Error: ${data.error}` }] };
      }
      case 'ui_git_status': {
        const data = await api(`/git-modified?root=${encodeURIComponent(args!.root as string)}`);
        const files = (data || []).map((f: any) => `${f.staged ? '[staged] ' : ''}${f.path}`).join('\n');
        return { content: [{ type: 'text', text: files || 'No modified files' }] };
      }
      case 'ui_prs': {
        const params = new URLSearchParams({ cwd: args!.cwd as string });
        if (args!.session) params.set('session', args!.session as string);
        const data = await api(`/gh-prs?${params}`);
        const prs = (data || []).map((pr: any) => `#${pr.number} ${pr.title} (${pr.state}) — ${pr.headRefName}`).join('\n');
        return { content: [{ type: 'text', text: prs || 'No pull requests found' }] };
      }
      case 'ui_exec': {
        // One-shot command capture (distinct from the interactive terminal
        // resource): run the command through the user's login shell, collect
        // stdout+stderr with a 30s cap, and return it. Runs as a plain child
        // process — it isn't a managed terminal, so it doesn't go through the
        // /sessions/:id/terminals CRUD.
        const shell = process.env.SHELL || '/bin/sh';
        const init = 'source ~/.zprofile 2>/dev/null; source ~/.zshrc 2>/dev/null; ';
        const proc = Bun.spawn([shell, '-c', init + (args!.command as string)], {
          cwd: (args!.cwd as string) || process.env.HOME || '/',
          env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1', COLORTERM: 'truecolor' },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const decoder = new TextDecoder();
        let output = '';
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; try { proc.kill(); } catch {} }, 30000);
        try {
          const pump = async (stream: ReadableStream<Uint8Array> | null) => {
            if (!stream) return;
            for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
          };
          await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
          const code = await proc.exited;
          clearTimeout(timeout);
          const tail = timedOut ? '\n[timed out after 30s]' : `\n[exit ${code}]`;
          return { content: [{ type: 'text', text: (output || '(no output)') + tail }] };
        } catch (e) {
          clearTimeout(timeout);
          return { content: [{ type: 'text', text: output || `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      }
      case 'ui_forward_port': {
        if (!uiSessionId) return { content: [{ type: 'text', text: 'No owning session — caller did not set the x-session-id header.' }], isError: true };
        const targetPort = args!.port as number;
        const targetHost = ((args!.host as string) || '127.0.0.1').trim() || '127.0.0.1';
        let forward: SessionPortForward;
        try {
          forward = await openPortForward({
            sessionId: uiSessionId,
            targetPort,
            targetHost,
            publicPort: args!.public_port as number | undefined,
            label: (args!.label as string) ?? null,
          });
        } catch (err) {
          if (err instanceof PortInUseError) {
            // The agent's next move depends on knowing this is a *binding*
            // conflict, not a bad request — spell out the retry.
            const taken = listPortForwards().map(f => f.publicPort);
            const hint = taken.length ? ` Ports currently forwarded by this bridge: ${taken.join(', ')}.` : '';
            return {
              content: [{
                type: 'text',
                text: `${err.message}${hint}\nRetry with a different \`public_port\` (e.g. ${err.port + 1}) — the same one will fail again.`,
              }],
              isError: true,
            };
          }
          return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
        const url = publishedPortUrl(forward.publicPort);
        const listening = await isTargetListening(forward.targetHost, forward.targetPort);
        const lines = [
          `Forwarding 0.0.0.0:${forward.publicPort} -> ${forward.targetHost}:${forward.targetPort}`,
          `Give the user this URL: ${url}`,
        ];
        if (forward.publicPort !== targetPort && args!.public_port === undefined) {
          lines.push(`Port ${targetPort} was taken on the public interface, so the forward landed on ${forward.publicPort}. Use the URL above, not port ${targetPort}.`);
        }
        if (publishedUrlIsGuess()) {
          // No client is connected, so the hostname above is this machine's own
          // name rather than one we watched somebody reach us on.
          lines.push(`No remote client is connected right now, so the hostname above is this machine's own — if it does not resolve for the user, give them this machine's LAN or Tailscale address with port ${forward.publicPort}.`);
        }
        if (!listening) {
          lines.push(
            `Warning: nothing is listening on ${forward.targetHost}:${forward.targetPort} yet. The forward is up and will start working` +
            ' once the service binds — but if you already started it, check that it binds loopback and not some other interface.',
          );
        }
        // Vite/Next reject requests whose Host header isn't in their allow-list,
        // which surfaces to the user as a blank page rather than a network error.
        lines.push('If the page loads blank or the dev server rejects the host, it is filtering by Host header — start it with `--host` (Vite) or add the hostname to its allowed-hosts config.');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
      case 'ui_list_port_forwards': {
        if (!uiSessionId) return { content: [{ type: 'text', text: 'No owning session — caller did not set the x-session-id header.' }], isError: true };
        const list = listPortForwards(uiSessionId);
        if (list.length === 0) {
          return { content: [{ type: 'text', text: 'This session has no forwarded ports. Use ui_forward_port to publish one.' }] };
        }
        const text = list.map(f => {
          const bits = [`${publishedPortUrl(f.publicPort)} -> ${f.targetHost}:${f.targetPort}`];
          if (f.label) bits.push(`(${f.label})`);
          bits.push(`· ${f.connections} connection${f.connections === 1 ? '' : 's'}`);
          return `  ${bits.join(' ')}`;
        }).join('\n');
        return { content: [{ type: 'text', text: `Forwarded ports for this session:\n${text}` }] };
      }
      case 'ui_close_port_forward': {
        if (!uiSessionId) return { content: [{ type: 'text', text: 'No owning session — caller did not set the x-session-id header.' }], isError: true };
        const publicPort = args!.public_port as number;
        if (closePortForward(publicPort, uiSessionId)) {
          return { content: [{ type: 'text', text: `Closed the forward on port ${publicPort}.` }] };
        }
        const owner = getPortForward(publicPort);
        const reason = owner
          ? `port ${publicPort} is forwarded by another session (${owner.sessionId}), not this one`
          : `this bridge is not forwarding port ${publicPort}`;
        return { content: [{ type: 'text', text: `Nothing to close — ${reason}.` }], isError: true };
      }
      case 'ui_list_sessions': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        const list = [...sessions.values()].map(s => sessionToJSON(s, _deps!.port));
        if (list.length === 0) return { content: [{ type: 'text', text: 'No sessions.' }] };
        const text = list.map(s => {
          const runtime = s.ready ? 'ready' : s.runtime_status;
          return `${s.id}  [${s.status}/${runtime}]  ${s.name}  (${s.cwd})`;
        }).join('\n');
        return { content: [{ type: 'text', text }] };
      }
      case 'ui_spawn_session': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };

        // `cwd` is required — explicitly chosen by the caller, no server-default fallback.
        const cwd = typeof args!.cwd === 'string' ? args!.cwd.trim() : '';
        if (!cwd) {
          return { content: [{ type: 'text', text: '`cwd` is required (absolute working directory for the new session).' }], isError: true };
        }
        const initialMessage = typeof args!.initial_message === 'string' ? args!.initial_message : undefined;
        if (initialMessage !== undefined && !initialMessage.trim()) {
          return { content: [{ type: 'text', text: '`initial_message` must not be empty.' }], isError: true };
        }

        const body: Record<string, unknown> = { cwd };
        if (typeof args!.name === 'string') body.name = args!.name;
        if (typeof args!.model === 'string') body.model = args!.model;
        if (typeof args!.permissionMode === 'string') body.permissionMode = args!.permissionMode;
        if (typeof args!.provider === 'string') body.provider = args!.provider;

        // Optional worktree creation — overrides cwd with the new worktree path.
        let worktreeInfo: { path: string; branch: string } | null = null;
        const worktreeSetupLog: string[] = [];
        if (args!.worktree !== undefined && args!.worktree !== null) {
          if (typeof args!.worktree !== 'object' || Array.isArray(args!.worktree)) {
            return { content: [{ type: 'text', text: '`worktree` must be an object with { branch, new_branch, source_branch?, pull_source? }.' }], isError: true };
          }
          const wt = args!.worktree as Record<string, unknown>;
          const branch = typeof wt.branch === 'string' ? wt.branch.trim() : '';
          if (!branch) {
            return { content: [{ type: 'text', text: '`worktree.branch` is required when `worktree` is set.' }], isError: true };
          }
          if (typeof wt.new_branch !== 'boolean') {
            return { content: [{ type: 'text', text: '`worktree.new_branch` (boolean) is required when `worktree` is set.' }], isError: true };
          }
          const sourceBranch = typeof wt.source_branch === 'string' ? wt.source_branch : undefined;
          const pullSource = typeof wt.pull_source === 'boolean' ? wt.pull_source : false;
          try {
            worktreeInfo = createWorktree({
              repoPath: cwd,
              branch,
              newBranch: wt.new_branch,
              sourceBranch,
              pullSource,
            });
            // Mirror the create-worktree modal: optionally copy `.env`,
            // install deps, and copy/symlink `node_modules` from the source
            // repo. Collected log lines are appended to the tool result so the
            // agent can see what setup ran.
            await applyWorktreeSetup({
              repoPath: cwd,
              worktreePath: worktreeInfo.path,
              copyEnv: wt.copy_env === true,
              installDeps: wt.install_deps === true,
              copyNodeModules: wt.copy_node_modules === true,
              linkNodeModules: wt.link_node_modules === true,
              packageManager: typeof wt.package_manager === 'string' ? wt.package_manager : undefined,
              log: (m) => worktreeSetupLog.push(m),
            });
            body.cwd = worktreeInfo.path;
            // Hint the autogroup step about the *source* repo so the session
            // lands under the parent repo's group instead of one named after
            // the worktree branch. Mirrors what the HTTP route + frontend
            // client already do (`group_cwd` in `claude-client.ts`).
            body.group_cwd = cwd;
          } catch (err) {
            return { content: [{ type: 'text', text: `Failed to create worktree: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
          }
        }

        // Reuse the existing HTTP handler by constructing a Request — no HTTP
        // round-trip, just a direct function call.
        const req = new Request('http://internal/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const resp = await handleCreateSession(req, _deps.port);
        const data = await resp.json() as Record<string, unknown>;
        const sessionId = typeof data.id === 'string' ? data.id : '';
        if (initialMessage && sessionId) {
          const result = await _deps.sendMessageToSession(sessionId, initialMessage);
          if (!result.ok) {
            return {
              content: [{ type: 'text', text: `Spawned session ${sessionId}, but failed to send its initial message: ${result.error ?? 'unknown error'}` }],
              isError: true,
            };
          }
        }

        // Optional group assignment — merge the session id into tabGroupMap.
        // An explicit group_id wins over the autoGroupSessions preference, so
        // run it before the autogroup fallback below.
        if (typeof args!.group_id === 'string' && args!.group_id) {
          const prefs = _deps.loadPreferences();
          const groups = (prefs.tabGroups as Record<string, unknown>) || {};
          if (!groups[args!.group_id as string]) {
            _deps.broadcastSessionList();
            return { content: [{ type: 'text', text: `Spawned ${data.id} but group ${args!.group_id} not found — left ungrouped.` }] };
          }
          const map = { ...((prefs.tabGroupMap as Record<string, string>) || {}) };
          map[data.id as string] = args!.group_id as string;
          _deps.updatePreferences({ tabGroupMap: map });
        } else if (typeof data.id === 'string' && typeof data.cwd === 'string') {
          // Prefer the explicit `group_cwd` hint (set when a worktree is
          // created) over the session's actual cwd so the new tab joins the
          // parent repo's group instead of one named after the worktree.
          const groupingCwd = (typeof data.group_cwd === 'string' && data.group_cwd)
            ? data.group_cwd
            : data.cwd;
          _deps.maybeAutoGroupSession(data.id, groupingCwd);
        }
        _deps.broadcastSessionList();

        const wtSuffix = worktreeInfo ? ` [worktree: ${worktreeInfo.branch} @ ${worktreeInfo.path}]` : '';
        const setupSuffix = worktreeSetupLog.length ? `\nSetup:\n${worktreeSetupLog.map((l) => `  ${l}`).join('\n')}` : '';
        const initialMessageSuffix = initialMessage ? '\nInitial message sent.' : '';
        return { content: [{ type: 'text', text: `Spawned session ${data.id} — ${data.name} (cwd: ${data.cwd})${wtSuffix}${setupSuffix}${initialMessageSuffix}` }] };
      }
      case 'ui_send_message': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        const sessionId = args!.session_id as string;
        const text = args!.text as string;
        if (!sessionId || !text) {
          return { content: [{ type: 'text', text: 'session_id and text are required' }], isError: true };
        }
        const result = await _deps.sendMessageToSession(sessionId, text);
        if (!result.ok) {
          return { content: [{ type: 'text', text: `Failed: ${result.error ?? 'unknown error'}` }], isError: true };
        }
        return { content: [{ type: 'text', text: `Message sent to session ${sessionId}. Claude\'s response will stream into that session\'s chat log.` }] };
      }
      case 'ui_read_session_messages': {
        const sessionId = args!.session_id as string;
        if (!sessionId) {
          return { content: [{ type: 'text', text: 'session_id is required' }], isError: true };
        }
        if (!sessions.has(sessionId)) {
          return { content: [{ type: 'text', text: `Session not found: ${sessionId}` }], isError: true };
        }
        const limit = typeof args!.limit === 'number' ? args!.limit : 20;
        const sinceSeq = typeof args!.since_seq === 'number' ? args!.since_seq : undefined;
        const includeTools = args!.include_tools === undefined ? true : !!args!.include_tools;
        const maxChars = typeof args!.max_chars_per_message === 'number' ? args!.max_chars_per_message : 500;

        const state = getSessionState(sessionId);
        let msgs: ChatMessage[] = state.messages;
        if (sinceSeq !== undefined) msgs = msgs.filter(m => (m.seq ?? 0) > sinceSeq);
        if (!includeTools) msgs = msgs.filter(m => !m.toolName && !m.isToolResult);
        if (limit > 0 && msgs.length > limit) msgs = msgs.slice(-limit);

        if (msgs.length === 0) {
          return { content: [{ type: 'text', text: '(no messages)' }] };
        }

        const truncate = (s: string) => {
          if (!maxChars || s.length <= maxChars) return s;
          return s.slice(0, maxChars) + `… [+${s.length - maxChars} chars]`;
        };

        const lines: string[] = [];
        for (const m of msgs) {
          const seq = m.seq ?? 0;
          const ts = new Date(m.timestamp).toISOString().replace('T', ' ').replace(/\..+/, '');
          if (m.toolName && !m.isToolResult) {
            const input = typeof m.toolInput === 'string' ? m.toolInput : JSON.stringify(m.toolInput ?? {});
            lines.push(`[${seq}] ${ts} tool_use:${m.toolName}${m.autoApproved ? ' (auto)' : ''}`);
            lines.push(`    ${truncate(input)}`);
          } else if (m.isToolResult) {
            lines.push(`[${seq}] ${ts} tool_result${m.isError ? ' ERROR' : ''}`);
            lines.push(`    ${truncate(m.content || '').replace(/\n/g, '\n    ')}`);
          } else if (m.isTerminal) {
            lines.push(`[${seq}] ${ts} terminal $ ${m.terminalCommand ?? ''}${m.exitCode !== undefined ? ` (exit ${m.exitCode})` : ' (running)'}`);
            if (m.content) lines.push(`    ${truncate(m.content).replace(/\n/g, '\n    ')}`);
          } else {
            lines.push(`[${seq}] ${ts} ${m.role}`);
            lines.push(`    ${truncate(m.content).replace(/\n/g, '\n    ')}`);
          }
        }

        const totalInSession = state.messages.length;
        const header = `Session ${sessionId} — ${msgs.length} message${msgs.length === 1 ? '' : 's'}` +
          (msgs.length < totalInSession ? ` of ${totalInSession} total` : '') +
          (state.isStreaming ? ' (streaming...)' : '');
        return { content: [{ type: 'text', text: header + '\n' + lines.join('\n') }] };
      }
      case 'ui_update_session': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        const sessionId = typeof args!.session_id === 'string' ? args!.session_id.trim() : '';
        if (!sessionId) return { content: [{ type: 'text', text: 'session_id is required' }], isError: true };

        const patch: SessionPatch = {};
        if (args!.name !== undefined) {
          if (!canRenameOwnedSession(uiSessionId, sessionId)) {
            return {
              content: [{ type: 'text', text: 'A session may only rename itself. Use ui_rename_session in the target session.' }],
              isError: true,
            };
          }
          const next = typeof args!.name === 'string' ? args!.name.trim() : '';
          if (!next) return { content: [{ type: 'text', text: '`name` cannot be empty or whitespace.' }], isError: true };
          patch.name = next;
        }
        if (args!.status !== undefined) {
          if (args!.status !== 'open' && args!.status !== 'archived') {
            return { content: [{ type: 'text', text: "`status` must be 'open' or 'archived'." }], isError: true };
          }
          patch.status = args!.status;
        }
        if (args!.permission_mode !== undefined) {
          const mode = typeof args!.permission_mode === 'string' ? args!.permission_mode : '';
          if (!SETTABLE_PERMISSION_MODES.includes(mode)) {
            return { content: [{ type: 'text', text: `\`permission_mode\` must be one of: ${SETTABLE_PERMISSION_MODES.join(', ')}.` }], isError: true };
          }
          patch.permissionMode = mode;
        }
        if (Object.keys(patch).length === 0) {
          return { content: [{ type: 'text', text: 'Nothing to update — pass at least one of `name`, `status`, `permission_mode`.' }], isError: true };
        }

        const result = await patchSessionViaHandler(sessionId, patch);
        if (!result.ok) return { content: [{ type: 'text', text: result.error }], isError: true };
        const s = result.session;
        return {
          content: [{
            type: 'text',
            text: `Updated session ${sessionId} — name="${s.name}", status=${s.status}, permission_mode=${s.permission_mode}.`,
          }],
        };
      }
      case 'ui_archive_session':
      case 'ui_unarchive_session': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        const ids = collectSessionIds(args);
        if (ids.length === 0) {
          return { content: [{ type: 'text', text: 'Pass `session_id` (or `session_ids` for several).' }], isError: true };
        }
        const status = name === 'ui_archive_session' ? 'archived' : 'open';
        const { text, isError } = await setSessionsStatus(ids, status);
        return { content: [{ type: 'text', text }], isError };
      }
      case 'ui_delete_session': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        const sessionId = typeof args!.session_id === 'string' ? args!.session_id.trim() : '';
        if (!sessionId) return { content: [{ type: 'text', text: 'session_id is required' }], isError: true };
        const target = sessions.get(sessionId);
        if (!target) return { content: [{ type: 'text', text: `Session not found: ${sessionId}` }], isError: true };
        const purge = args!.purge === true;
        const removeWorktree = args!.remove_worktree === true;
        const label = target.name;
        const cwd = target.cwd;

        const resp = await handleDeleteSession(sessionId, purge, removeWorktree);
        const data = await resp.json() as Record<string, unknown>;
        if (!resp.ok) {
          return { content: [{ type: 'text', text: typeof data.error === 'string' ? data.error : `Delete failed: HTTP ${resp.status}` }], isError: true };
        }
        // Mirror the DELETE /sessions/:id route: the session's stored images and
        // mockups go with it.
        purgeSessionResources(sessionId);
        _deps.broadcastSessionList();

        const notes: string[] = [];
        notes.push(purge ? 'chat history purged from disk' : 'chat history left on disk');
        const wt = data.worktree as { removed?: boolean; method?: string } | undefined;
        if (removeWorktree) {
          notes.push(wt?.removed ? `worktree removed from ${cwd} (via ${wt.method})` : `worktree NOT removed (cwd ${cwd} is not a .worktrees/<branch> path, or removal failed)`);
        }
        return {
          content: [{ type: 'text', text: `Permanently deleted session ${sessionId} — ${label}. ${notes.join('; ')}.` }],
        };
      }
      case 'ui_list_tab_groups': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        const prefs = _deps.loadPreferences();
        const groups = (prefs.tabGroups as Record<string, TabGroup>) || {};
        const map = (prefs.tabGroupMap as Record<string, string>) || {};
        const ids = Object.keys(groups);
        if (ids.length === 0) return { content: [{ type: 'text', text: 'No tab groups.' }] };
        // Build reverse index (group_id → session ids)
        const membersByGroup: Record<string, string[]> = {};
        for (const [sid, gid] of Object.entries(map)) {
          if (!membersByGroup[gid]) membersByGroup[gid] = [];
          membersByGroup[gid]!.push(sid);
        }
        const lines = ids.map(gid => {
          const g = groups[gid]!;
          const members = membersByGroup[gid] || [];
          const icon = g.icon ? `${g.icon} ` : '';
          const cwd = g.cwd ? `  cwd=${g.cwd}` : '';
          return `${gid}  ${icon}[${g.color}] ${g.name}${cwd}\n  members: ${members.length === 0 ? '(none)' : members.join(', ')}`;
        });
        return { content: [{ type: 'text', text: lines.join('\n\n') }] };
      }
      case 'ui_create_tab_group': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        const nm = typeof args!.name === 'string' ? args!.name.trim() : '';
        if (!nm) return { content: [{ type: 'text', text: 'name is required' }], isError: true };

        const prefs = _deps.loadPreferences();
        const groups: Record<string, TabGroup> = { ...((prefs.tabGroups as Record<string, TabGroup>) || {}) };
        const map: Record<string, string> = { ...((prefs.tabGroupMap as Record<string, string>) || {}) };

        const providedColor = typeof args!.color === 'string' ? (args!.color as string) : '';
        const color = GROUP_COLORS.includes(providedColor)
          ? providedColor
          : GROUP_COLORS[Object.keys(groups).length % GROUP_COLORS.length]!;
        const group: TabGroup = { id: randomUUID(), name: nm, color };
        if (typeof args!.icon === 'string' && args!.icon) group.icon = args!.icon as string;
        if (typeof args!.cwd === 'string' && args!.cwd) group.cwd = args!.cwd as string;
        groups[group.id] = group;

        // Optional initial members
        if (Array.isArray(args!.session_ids)) {
          for (const sid of args!.session_ids as unknown[]) {
            if (typeof sid === 'string' && sessions.has(sid)) {
              map[sid] = group.id;
            }
          }
        }

        _deps.updatePreferences({ tabGroups: groups, tabGroupMap: map });
        return { content: [{ type: 'text', text: `Created tab group ${group.id} — ${group.name} [${group.color}]` }] };
      }
      case 'ui_rename_tab_group': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        const gid = typeof args!.group_id === 'string' ? args!.group_id : '';
        if (!gid) return { content: [{ type: 'text', text: 'group_id is required' }], isError: true };
        const prefs = _deps.loadPreferences();
        const groups: Record<string, TabGroup> = { ...((prefs.tabGroups as Record<string, TabGroup>) || {}) };
        const g = groups[gid];
        if (!g) return { content: [{ type: 'text', text: `Group not found: ${gid}` }], isError: true };

        const next: TabGroup = { ...g };
        if (typeof args!.name === 'string' && args!.name.trim()) next.name = (args!.name as string).trim();
        if (typeof args!.color === 'string' && GROUP_COLORS.includes(args!.color as string)) next.color = args!.color as string;
        if (typeof args!.icon === 'string') {
          // Empty string clears the icon (revert to the colored dot).
          if (args!.icon === '') delete next.icon;
          else next.icon = args!.icon as string;
        }
        if (typeof args!.cwd === 'string') {
          if (args!.cwd === '') delete next.cwd;
          else next.cwd = args!.cwd as string;
        }
        groups[gid] = next;
        _deps.updatePreferences({ tabGroups: groups });
        return { content: [{ type: 'text', text: `Updated tab group ${gid} — ${next.name} [${next.color}]` }] };
      }
      case 'ui_delete_tab_group': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        const gid = typeof args!.group_id === 'string' ? args!.group_id : '';
        if (!gid) return { content: [{ type: 'text', text: 'group_id is required' }], isError: true };
        const prefs = _deps.loadPreferences();
        const groups: Record<string, TabGroup> = { ...((prefs.tabGroups as Record<string, TabGroup>) || {}) };
        if (!groups[gid]) return { content: [{ type: 'text', text: `Group not found: ${gid}` }], isError: true };
        const removedName = groups[gid]!.name;
        delete groups[gid];
        // Ungroup all members of this group
        const map: Record<string, string> = { ...((prefs.tabGroupMap as Record<string, string>) || {}) };
        let removedMembers = 0;
        for (const [sid, g] of Object.entries(map)) {
          if (g === gid) { delete map[sid]; removedMembers++; }
        }
        _deps.updatePreferences({ tabGroups: groups, tabGroupMap: map });
        return { content: [{ type: 'text', text: `Deleted tab group "${removedName}" (ungrouped ${removedMembers} session${removedMembers === 1 ? '' : 's'}).` }] };
      }
      case 'ui_move_session_to_group': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        const sid = typeof args!.session_id === 'string' ? args!.session_id : '';
        if (!sid) return { content: [{ type: 'text', text: 'session_id is required' }], isError: true };
        if (!sessions.has(sid)) return { content: [{ type: 'text', text: `Session not found: ${sid}` }], isError: true };
        const gid = typeof args!.group_id === 'string' ? args!.group_id : '';

        const prefs = _deps.loadPreferences();
        const groups: Record<string, TabGroup> = (prefs.tabGroups as Record<string, TabGroup>) || {};
        const map: Record<string, string> = { ...((prefs.tabGroupMap as Record<string, string>) || {}) };

        if (!gid) {
          // Ungroup
          if (!map[sid]) return { content: [{ type: 'text', text: `Session ${sid} was already ungrouped.` }] };
          delete map[sid];
          _deps.updatePreferences({ tabGroupMap: map });
          return { content: [{ type: 'text', text: `Ungrouped session ${sid}.` }] };
        }
        if (!groups[gid]) return { content: [{ type: 'text', text: `Group not found: ${gid}` }], isError: true };
        map[sid] = gid;
        _deps.updatePreferences({ tabGroupMap: map });
        return { content: [{ type: 'text', text: `Moved session ${sid} to group "${groups[gid]!.name}" (${gid}).` }] };
      }
      // ----- Per-session UI tools (use uiSessionId from x-session-id) -----
      case 'EnterPlanMode': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        if (!uiSessionId) return { content: [{ type: 'text', text: 'No owning session — caller did not set the x-session-id header.' }], isError: true };
        if (!sessions.has(uiSessionId)) return { content: [{ type: 'text', text: `Session ${uiSessionId} not found.` }], isError: true };
        await _deps.setSessionPermissionMode(uiSessionId, 'plan');
        return { content: [{ type: 'text', text: 'Plan mode enabled. Investigate without making changes, then call ExitPlanMode with the completed plan.' }] };
      }
      case 'ExitPlanMode': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        if (!uiSessionId) return { content: [{ type: 'text', text: 'No owning session — caller did not set the x-session-id header.' }], isError: true };
        const session = sessions.get(uiSessionId);
        if (!session) return { content: [{ type: 'text', text: `Session ${uiSessionId} not found.` }], isError: true };
        if (session.permissionMode !== 'plan') {
          return { content: [{ type: 'text', text: 'Enter plan mode before requesting plan approval.' }], isError: true };
        }
        const plan = typeof args!.plan === 'string' ? args!.plan.trim() : '';
        if (!plan) return { content: [{ type: 'text', text: 'plan is required' }], isError: true };
        const answer = (decision: PermissionDecision): CallToolResult => (decision.allow
          ? { content: [{ type: 'text', text: 'Plan approved. Plan mode disabled; you may now implement the approved plan.' }] }
          : { content: [{ type: 'text', text: decision.message || 'The plan was not approved.' }], isError: true });

        // A plan review takes as long as the user takes, and this call stays
        // open the whole time. If the agent gives up on it anyway (a dropped
        // socket, its own per-call timeout) it calls ExitPlanMode again —
        // which used to open a second card and fire a second notification
        // while the first prompt hung forever. Attach the retry to the
        // decision already on screen instead.
        const inFlight = findPendingDecision(session.id, 'ExitPlanMode');
        if (inFlight) return answer(await inFlight);

        const decision = await keepAlive(request.params._meta?.progressToken, extra?.sendNotification, () => requestPermissionDecision(session, {
          broadcastToSession: _deps!.broadcastToSession,
          sendBrowserRequest: _deps!.broadcastToSession,
          broadcastSessionList: _deps!.broadcastSessionList,
          notifyTelegramIfMainSession: () => {},
        }, {
          requestId: randomUUID(),
          toolName: 'ExitPlanMode',
          displayName: 'Exit Plan Mode',
          title: 'Review implementation plan',
          input: { plan },
        }));
        return answer(decision);
      }
      case 'ui_open_file_in_editor': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        if (!uiSessionId) return { content: [{ type: 'text', text: 'No owning session — caller did not set the x-session-id header.' }], isError: true };
        const path = typeof args!.path === 'string' ? args!.path : '';
        const line = typeof args!.line === 'number' && args!.line > 0 ? Math.floor(args!.line as number) : null;
        if (!path) return { content: [{ type: 'text', text: 'path is required' }], isError: true };
        _deps.broadcastToSession(uiSessionId, { type: 'open_file', sessionId: uiSessionId, path, line });
        const where = line != null ? `${path}:${line}` : path;
        return { content: [{ type: 'text', text: `Opened ${where} in the side editor.` }] };
      }
      case 'ui_rename_session': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        if (!uiSessionId) return { content: [{ type: 'text', text: 'No owning session — caller did not set the x-session-id header.' }], isError: true };
        const session = sessions.get(uiSessionId);
        if (!session) return { content: [{ type: 'text', text: `Session ${uiSessionId} not found.` }], isError: true };
        const next = typeof args!.name === 'string' ? args!.name.trim() : '';
        if (!next) return { content: [{ type: 'text', text: 'Name cannot be empty or whitespace.' }], isError: true };
        const previous = session.name;
        session.name = next;
        saveSessions();
        _deps.broadcastSessionList();
        return { content: [{ type: 'text', text: `Renamed session from "${previous}" to "${next}".` }] };
      }
      case 'ui_restart_session': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        if (!uiSessionId) return { content: [{ type: 'text', text: 'No owning session — caller did not set the x-session-id header.' }], isError: true };
        if (!sessions.has(uiSessionId)) return { content: [{ type: 'text', text: `Session ${uiSessionId} not found.` }], isError: true };
        const resp = await handleRestartSession(uiSessionId, _deps.port);
        _deps.broadcastSessionList();
        if (!resp.ok) {
          const errText = await resp.text().catch(() => `HTTP ${resp.status}`);
          return { content: [{ type: 'text', text: `Restart failed: ${errText}` }], isError: true };
        }
        return { content: [{ type: 'text', text: `Restarted session ${uiSessionId} — provider re-spawned with the same session id, conversation history preserved.` }] };
      }
      case 'ui_post_system_note': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        if (!uiSessionId) return { content: [{ type: 'text', text: 'No owning session — caller did not set the x-session-id header.' }], isError: true };
        const content = typeof args!.content === 'string' ? args!.content : '';
        if (!content) return { content: [{ type: 'text', text: 'content is required' }], isError: true };
        const msg: ChatMessage = {
          id: randomUUID(),
          role: 'system',
          content,
          timestamp: Date.now(),
        };
        if (addMessage(uiSessionId, msg)) {
          _deps.broadcastToSession(uiSessionId, { type: 'message', sessionId: uiSessionId, message: msg });
        }
        return { content: [{ type: 'text', text: `Posted note: ${content}` }] };
      }
      case 'ui_post_image_to_session': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        if (!uiSessionId) return { content: [{ type: 'text', text: 'No owning session — caller did not set the x-session-id header.' }], isError: true };
        const path = typeof args!.path === 'string' ? args!.path : '';
        if (!path) return { content: [{ type: 'text', text: 'path is required' }], isError: true };
        const caption = typeof args!.caption === 'string' ? args!.caption : undefined;
        const mediaType = IMAGE_MEDIA_TYPES[extname(path).toLowerCase()];
        if (!mediaType) {
          return { content: [{ type: 'text', text: `Unsupported image extension for ${path}. Supported: .png, .jpg, .jpeg, .gif, .webp.` }], isError: true };
        }
        let buf: Buffer;
        try {
          buf = await fs.readFile(path);
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          return { content: [{ type: 'text', text: `Failed to read image at ${path}: ${err}` }], isError: true };
        }
        const msg: ChatMessage = {
          id: randomUUID(),
          role: 'system',
          content: caption ?? '',
          timestamp: Date.now(),
          images: [{ media_type: mediaType, data: buf.toString('base64') }],
        };
        if (addMessage(uiSessionId, msg)) {
          _deps.broadcastToSession(uiSessionId, { type: 'message', sessionId: uiSessionId, message: msg });
        }
        // Also file the image under the session's browsable resources so it
        // shows up in the Resources panel. Never let this fail the post.
        try {
          saveResource(uiSessionId, { data: buf.toString('base64'), name: basename(path), kind: 'image', mime: mediaType });
        } catch (e) {
          log(`ui_post_image_to_session: failed to register resource: ${e instanceof Error ? e.message : String(e)}`);
        }
        const sizeKb = Math.max(1, Math.round(buf.length / 1024));
        const tail = caption ? ` — "${caption}"` : '';
        return { content: [{ type: 'text', text: `Posted ${mediaType} (${sizeKb} KB) from ${path}${tail}.` }] };
      }
      case 'ui_mockup_write': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        if (!uiSessionId) return { content: [{ type: 'text', text: 'No owning session — caller did not set the x-session-id header.' }], isError: true };
        const rawName = typeof args!.name === 'string' ? args!.name : '';
        const html = typeof args!.html === 'string' ? args!.html : '';
        if (!html) return { content: [{ type: 'text', text: 'html is required' }], isError: true };
        const name = sanitizeMockupName(rawName);
        if (!name) {
          return { content: [{ type: 'text', text: `Invalid mockup name "${rawName}". Use letters, digits, dot, dash, underscore, or space (1–80 chars), no slashes.` }], isError: true };
        }
        mockupsFor(uiSessionId).set(name, html);
        try {
          await persistMockup(uiSessionId, name, html);
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          return { content: [{ type: 'text', text: `Mockup "${name}" rendered but failed to persist to disk: ${err}` }], isError: true };
        }
        _deps.broadcastToSession(uiSessionId, { type: 'open_mockup', sessionId: uiSessionId, name, html });
        // Register (or overwrite) the mockup in the session's resources so it's
        // browsable in the Resources panel; dedupe by name to mirror the
        // in-place overwrite semantics of mockup_write.
        try {
          saveResource(uiSessionId, { content: html, name: `${name}.html`, kind: 'mockup', mime: 'text/html' }, { dedupeByName: true });
        } catch (e) {
          log(`ui_mockup_write: failed to register resource: ${e instanceof Error ? e.message : String(e)}`);
        }
        const sizeKb = Math.max(1, Math.round(Buffer.byteLength(html, 'utf8') / 1024));
        return { content: [{ type: 'text', text: `Mockup "${name}" rendered and saved (${sizeKb} KB).` }] };
      }
      case 'ui_mockup_edit': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        if (!uiSessionId) return { content: [{ type: 'text', text: 'No owning session — caller did not set the x-session-id header.' }], isError: true };
        const rawName = typeof args!.name === 'string' ? args!.name : '';
        const oldStr = typeof args!.old_string === 'string' ? args!.old_string : '';
        const newStr = typeof args!.new_string === 'string' ? args!.new_string : '';
        const replaceAll = !!args!.replace_all;
        if (!oldStr) return { content: [{ type: 'text', text: 'old_string is required' }], isError: true };
        const name = sanitizeMockupName(rawName);
        if (!name) return { content: [{ type: 'text', text: `Invalid mockup name "${rawName}".` }], isError: true };
        const current = await loadMockup(uiSessionId, name);
        if (current == null) {
          return { content: [{ type: 'text', text: `Mockup "${name}" not found in memory or on disk. Create it with ui_mockup_write first.` }], isError: true };
        }
        if (oldStr === newStr) {
          return { content: [{ type: 'text', text: 'old_string and new_string are identical — nothing to do.' }], isError: true };
        }
        let next: string;
        let count: number;
        if (replaceAll) {
          const parts = current.split(oldStr);
          count = parts.length - 1;
          if (count === 0) {
            return { content: [{ type: 'text', text: `old_string not found in mockup "${name}".` }], isError: true };
          }
          next = parts.join(newStr);
        } else {
          const idx = current.indexOf(oldStr);
          if (idx === -1) {
            return { content: [{ type: 'text', text: `old_string not found in mockup "${name}".` }], isError: true };
          }
          const second = current.indexOf(oldStr, idx + oldStr.length);
          if (second !== -1) {
            return { content: [{ type: 'text', text: `old_string is not unique in mockup "${name}" (matched at least twice). Pass replace_all: true or include more surrounding context.` }], isError: true };
          }
          next = current.slice(0, idx) + newStr + current.slice(idx + oldStr.length);
          count = 1;
        }
        mockupsFor(uiSessionId).set(name, next);
        try {
          await persistMockup(uiSessionId, name, next);
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          return { content: [{ type: 'text', text: `Mockup "${name}" updated in memory but failed to persist to disk: ${err}` }], isError: true };
        }
        _deps.broadcastToSession(uiSessionId, { type: 'open_mockup', sessionId: uiSessionId, name, html: next });
        try {
          saveResource(uiSessionId, { content: next, name: `${name}.html`, kind: 'mockup', mime: 'text/html' }, { dedupeByName: true });
        } catch (e) {
          log(`ui_mockup_edit: failed to register resource: ${e instanceof Error ? e.message : String(e)}`);
        }
        return { content: [{ type: 'text', text: `Mockup "${name}" updated (${count} replacement${count === 1 ? '' : 's'}) and saved.` }] };
      }
      case 'ui_mockup_read': {
        if (!uiSessionId) return { content: [{ type: 'text', text: 'No owning session — caller did not set the x-session-id header.' }], isError: true };
        const rawName = typeof args!.name === 'string' ? args!.name : '';
        const name = sanitizeMockupName(rawName);
        if (!name) return { content: [{ type: 'text', text: `Invalid mockup name "${rawName}".` }], isError: true };
        const html = await loadMockup(uiSessionId, name);
        if (html == null) {
          const inMem = [...mockupsFor(uiSessionId).keys()];
          const onDisk = await listPersistedMockups(uiSessionId);
          const available = [...new Set([...inMem, ...onDisk])].sort();
          const tail = available.length ? ` Available: ${available.join(', ')}.` : ' No mockups exist in this session yet.';
          return { content: [{ type: 'text', text: `Mockup "${name}" not found.${tail}` }], isError: true };
        }
        return { content: [{ type: 'text', text: html }] };
      }
      case 'ui_browser_open': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        if (!uiSessionId) return { content: [{ type: 'text', text: 'No owning session — caller did not set the x-session-id header.' }], isError: true };
        const rawName = typeof args!.name === 'string' ? args!.name : '';
        const rawUrl = typeof args!.url === 'string' ? args!.url : '';
        const rawTitle = typeof args!.title === 'string' ? args!.title : '';
        const rawJar = typeof args!.cookieJar === 'string' ? args!.cookieJar : '';
        const name = sanitizeBrowserName(rawName);
        if (!name) {
          return { content: [{ type: 'text', text: `Invalid browser name "${rawName}". Letters/digits/dash/underscore only, 1–40 chars, must start with a letter or digit.` }], isError: true };
        }
        const target = sanitizeBrowserUrl(rawUrl);
        if (!target) {
          return { content: [{ type: 'text', text: `Invalid URL "${rawUrl}". Must be an absolute http:// or https:// URL.` }], isError: true };
        }
        const cookieJar = sanitizeCookieJar(rawJar);
        if (!cookieJar) {
          return { content: [{ type: 'text', text: `Invalid cookieJar "${rawJar}". Letters/digits/dash/underscore only, 1–40 chars, must start with a letter or digit.` }], isError: true };
        }
        const title = rawTitle.trim() || name;
        setBrowserPreview(uiSessionId, name, { url: target.toString(), title, cookieJar });
        _deps.broadcastToSession(uiSessionId, {
          type: 'open_browser',
          sessionId: uiSessionId,
          name,
          url: target.toString(),
          title,
          cookieJar,
        });
        return { content: [{ type: 'text', text: `Opened browser preview "${name}" (jar "${cookieJar}") → ${target.toString()}.` }] };
      }
      case 'ui_browser_close': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        if (!uiSessionId) return { content: [{ type: 'text', text: 'No owning session — caller did not set the x-session-id header.' }], isError: true };
        const rawName = typeof args!.name === 'string' ? args!.name : '';
        const name = sanitizeBrowserName(rawName);
        if (!name) {
          return { content: [{ type: 'text', text: `Invalid browser name "${rawName}".` }], isError: true };
        }
        const had = !!getBrowserPreview(uiSessionId, name);
        setBrowserPreview(uiSessionId, name, null);
        _deps.broadcastToSession(uiSessionId, { type: 'close_browser', sessionId: uiSessionId, name });
        return { content: [{ type: 'text', text: had ? `Closed browser preview "${name}".` : `No browser preview named "${name}" was open.` }] };
      }
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (e: any) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});

// Transport — one per session, managed by route handler
  return mcpServer;
}

const transports = new Map<string, {
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
  uiSessionId: string;
}>();

/**
 * Await something that blocks on a human — a plan review, an approval — while
 * keeping the MCP call's socket alive.
 *
 * Bun closes a connection that sends nothing for `idleTimeout` seconds, and a
 * tool waiting on the user sends nothing by definition. The agent then sees
 * "the socket connection was closed unexpectedly" and retries the tool, which
 * is how one plan turned into a stream of approval cards. A periodic progress
 * notification is traffic, so the connection stays up for as long as the user
 * needs. Clients that didn't ask for progress updates just drop them.
 */
export async function keepAlive<T>(
  progressToken: string | number | undefined,
  send: ((n: ServerNotification) => Promise<void>) | undefined,
  work: () => Promise<T>,
  intervalMs: number = HEARTBEAT_MS,
): Promise<T> {
  if (!send || progressToken === undefined) return work();

  let beats = 0;
  const timer = setInterval(() => {
    // Fire-and-forget: a heartbeat that loses the race with the socket
    // closing must not turn into an unhandled rejection.
    send({
      method: 'notifications/progress',
      params: { progressToken, progress: ++beats },
    }).catch(() => {});
  }, intervalMs);

  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

export function owningUiSessionId(req: Request): string {
  return req.headers.get('x-session-id') || new URL(req.url).searchParams.get('session_id') || '';
}

export function matchesMcpSessionOwner(boundSessionId: string, requestedSessionId: string): boolean {
  return !requestedSessionId || requestedSessionId === boundSessionId;
}

export async function handleMcpRequest(req: Request): Promise<Response> {
  const mcpSessionId = req.headers.get('mcp-session-id');
  const uiSessionId = owningUiSessionId(req);

  if (mcpSessionId) {
    const entry = transports.get(mcpSessionId);
    if (entry) {
      if (!matchesMcpSessionOwner(entry.uiSessionId, uiSessionId)) {
        log(`[mcp] Rejected session owner mismatch: ${mcpSessionId} (bound=${entry.uiSessionId.slice(0, 8) || 'unknown'}, requested=${uiSessionId.slice(0, 8)})`);
        return new Response('MCP session belongs to a different UI session', { status: 409 });
      }
      return entry.transport.handleRequest(req);
    }
    return new Response('Session not found', { status: 404 });
  }

  // New session — create fresh server + transport
  log(`[mcp] New MCP session for UI session: ${uiSessionId.slice(0, 8) || 'unknown'}`);
  const mcpServer = createMcpServer(uiSessionId);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      transports.set(id, { transport, server: mcpServer, uiSessionId });
      log(`[mcp] Session started: ${id} (ui: ${uiSessionId.slice(0, 8)})`);
    },
    onsessionclosed: (id) => {
      transports.delete(id);
      log(`[mcp] Session closed: ${id}`);
    },
  });
  await mcpServer.connect(transport);
  return transport.handleRequest(req);
}
