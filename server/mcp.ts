/**
 * MCP Server for Codiby Code.
 * Integrated into the HTTP server via WebStandardStreamableHTTPServerTransport.
 * Handles /mcp route — Claude connects via SSE.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { corsHeaders } from './config';
import { log } from './logger';
import { sessions, sessionToJSON, saveSessions } from './sessions';
import { handleCreateSession } from './handlers/sessions';
import { addMessage, getSessionState } from './state';
import type { ChatMessage } from './state';
import { createWorktree } from './handlers/worktree';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { extname } from 'path';
import {
  IMAGE_MEDIA_TYPES,
  mockupsFor,
  sanitizeMockupName,
  persistMockup,
  loadMockup,
  listPersistedMockups,
  sanitizeBrowserUrl,
  sanitizeBrowserName,
  setBrowserPreview,
  getBrowserPreview,
} from './provider/sdk-tools';

/** Palette for auto-assigning a tab-group colour when the caller doesn't pick.
 *  Matches the set in ChatApp.tsx#handleCreateGroup so new server-made groups
 *  look indistinguishable from client-made ones. */
const GROUP_COLORS = ['blue', 'green', 'amber', 'violet', 'red', 'pink'];

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
};

let _deps: McpDeps | null = null;
let _serverPort = 3111;

export function setMcpDeps(deps: McpDeps) {
  _deps = deps;
  _serverPort = deps.port;
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
      name: 'ui_list_sessions',
      description: 'List all Codiby Code sessions (chat tabs). Returns each session\'s id, name, status, and working directory. Use this to find the session_id to pass to ui_send_message.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'ui_spawn_session',
      description: 'Spawn a new Codiby Code session (a new chat tab) and start its provider. Useful when you need to delegate work to a fresh session while keeping the current one focused on something else. Returns the new session\'s id which you can pass to ui_send_message.\n\nIf `worktree_name` is set, a new git worktree is created at `<repo-parent>/.wt/<worktree_name>` on a new branch of the same name, and the session\'s cwd is set to that path. The repo is taken from `cwd` (if it points into a git repo) or from the configured default cwd.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Optional session name shown in the tab bar.' },
          cwd: { type: 'string', description: 'Optional absolute working directory for the new session. Defaults to the server\'s configured cwd. When `worktree_name` is set, this is treated as the SOURCE repo and the session\'s actual cwd becomes the new worktree path.' },
          model: { type: 'string', description: 'Optional model override (e.g. "opus", "sonnet", "haiku", or a full model id). Leave unset for the default.' },
          permissionMode: { type: 'string', enum: ['default', 'acceptEdits', 'plan', 'bypassPermissions'], description: 'Optional permission mode. Defaults to "default".' },
          provider: { type: 'string', description: 'Optional provider name. Defaults to the configured default (claudeAgent).' },
          worktree_name: { type: 'string', description: 'Optional worktree/branch name. When set, creates a git worktree at `<repo-parent>/.wt/<worktree_name>` on a new branch `<worktree_name>` (or attaches to it if the branch already exists) and uses that path as the session cwd.' },
          group_id: { type: 'string', description: 'Optional tab-group id to add the new session to (from ui_list_tab_groups or ui_create_tab_group).' },
        },
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
      description: 'Open an http(s) URL in a named browser preview tab inside Codiby Code. Multiple previews can co-exist per session — choose a stable kebab/snake-case `name` (e.g. "qa-admin-workflow") and reuse it for follow-up tools. Re-opening with the same name navigates the existing preview without losing state.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Stable identifier for this browser preview within the session. Letters/digits/dash/underscore only, 1–40 chars, must start with a letter or digit. Example: "qa-admin-workflow".' },
          url: { type: 'string', description: 'Absolute http:// or https:// URL.' },
          title: { type: 'string', description: 'Short label shown in the panel tab. Defaults to the `name`.' },
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

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
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
        const createResp = await api('/exec', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: args!.command, cwd: args!.cwd }) });
        const { procId } = createResp;
        const wsUrl = `ws://localhost:${_serverPort}/terminal/ws/${procId}`;
        return new Promise((resolve) => {
          let output = '';
          const ws = new WebSocket(wsUrl);
          const timeout = setTimeout(() => { ws.close(); resolve({ content: [{ type: 'text', text: output || '(no output)' }] }); }, 30000);
          ws.onmessage = (event) => {
            try {
              const msg = JSON.parse(event.data);
              if (msg.type === 'data') output += msg.text;
              if (msg.type === 'exit') { clearTimeout(timeout); ws.close(); resolve({ content: [{ type: 'text', text: output + `\n[exit ${msg.code}]` }] }); }
            } catch {}
          };
          ws.onerror = () => { clearTimeout(timeout); resolve({ content: [{ type: 'text', text: output || 'Connection error' }] }); };
        });
      }
      case 'ui_list_sessions': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        const list = [...sessions.values()].map(s => sessionToJSON(s, _deps!.port));
        if (list.length === 0) return { content: [{ type: 'text', text: 'No sessions.' }] };
        const text = list.map(s => {
          const status = s.ready ? 'ready' : s.status;
          return `${s.id}  [${status}]  ${s.name}  (${s.cwd})`;
        }).join('\n');
        return { content: [{ type: 'text', text }] };
      }
      case 'ui_spawn_session': {
        if (!_deps) return { content: [{ type: 'text', text: 'MCP deps not initialized' }], isError: true };
        const body: Record<string, unknown> = {};
        if (typeof args!.name === 'string') body.name = args!.name;
        if (typeof args!.cwd === 'string') body.cwd = args!.cwd;
        if (typeof args!.model === 'string') body.model = args!.model;
        if (typeof args!.permissionMode === 'string') body.permissionMode = args!.permissionMode;
        if (typeof args!.provider === 'string') body.provider = args!.provider;

        // Optional worktree creation — overrides cwd with the new worktree path.
        let worktreeInfo: { path: string; branch: string } | null = null;
        if (typeof args!.worktree_name === 'string' && args!.worktree_name.trim()) {
          const repoPath = (typeof body.cwd === 'string' && body.cwd) || process.cwd();
          try {
            worktreeInfo = createWorktree({ repoPath, branch: args!.worktree_name as string });
            body.cwd = worktreeInfo.path;
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
          _deps.maybeAutoGroupSession(data.id, data.cwd);
        }
        _deps.broadcastSessionList();

        const wtSuffix = worktreeInfo ? ` [worktree: ${worktreeInfo.branch} @ ${worktreeInfo.path}]` : '';
        return { content: [{ type: 'text', text: `Spawned session ${data.id} — ${data.name} (cwd: ${data.cwd})${wtSuffix}` }] };
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
        const name = sanitizeBrowserName(rawName);
        if (!name) {
          return { content: [{ type: 'text', text: `Invalid browser name "${rawName}". Letters/digits/dash/underscore only, 1–40 chars, must start with a letter or digit.` }], isError: true };
        }
        const target = sanitizeBrowserUrl(rawUrl);
        if (!target) {
          return { content: [{ type: 'text', text: `Invalid URL "${rawUrl}". Must be an absolute http:// or https:// URL.` }], isError: true };
        }
        const title = rawTitle.trim() || name;
        setBrowserPreview(uiSessionId, name, { url: target.toString(), title });
        _deps.broadcastToSession(uiSessionId, {
          type: 'open_browser',
          sessionId: uiSessionId,
          name,
          url: target.toString(),
          title,
        });
        return { content: [{ type: 'text', text: `Opened browser preview "${name}" → ${target.toString()}.` }] };
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

const transports = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; server: Server }>();

export async function handleMcpRequest(req: Request): Promise<Response> {
  const mcpSessionId = req.headers.get('mcp-session-id');
  const uiSessionId = req.headers.get('x-session-id') || '';

  if (mcpSessionId) {
    const entry = transports.get(mcpSessionId);
    if (entry) return entry.transport.handleRequest(req);
    return new Response('Session not found', { status: 404 });
  }

  // New session — create fresh server + transport
  log(`[mcp] New MCP session for UI session: ${uiSessionId.slice(0, 8) || 'unknown'}`);
  const mcpServer = createMcpServer(uiSessionId);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      transports.set(id, { transport, server: mcpServer });
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
