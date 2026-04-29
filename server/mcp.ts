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
import { sessions, sessionToJSON } from './sessions';
import { handleCreateSession } from './handlers/sessions';
import { getSessionState } from './state';
import type { ChatMessage } from './state';
import { createWorktree } from './handlers/worktree';
import { randomUUID } from 'crypto';

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
  /** Merge-patch the UI preferences blob, persist, and broadcast to frontends. */
  updatePreferences: (partial: Record<string, unknown>) => Record<string, unknown>;
  /** Read the current preferences blob (tabGroups, tabGroupMap, etc.). */
  loadPreferences: () => Record<string, unknown>;
};

let _deps: McpDeps | null = null;
let _serverPort = 3111;

export function setMcpDeps(deps: McpDeps) {
  _deps = deps;
  _serverPort = deps.port;
}

function createMcpServer() {
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
        _deps.broadcastSessionList();

        // Optional group assignment — merge the session id into tabGroupMap.
        if (typeof args!.group_id === 'string' && args!.group_id) {
          const prefs = _deps.loadPreferences();
          const groups = (prefs.tabGroups as Record<string, unknown>) || {};
          if (!groups[args!.group_id as string]) {
            return { content: [{ type: 'text', text: `Spawned ${data.id} but group ${args!.group_id} not found — left ungrouped.` }] };
          }
          const map = { ...((prefs.tabGroupMap as Record<string, string>) || {}) };
          map[data.id as string] = args!.group_id as string;
          _deps.updatePreferences({ tabGroupMap: map });
        }

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
  const mcpServer = createMcpServer();
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
