/**
 * MCP Server for Claude Code UI.
 * Integrated into the HTTP server via WebStandardStreamableHTTPServerTransport.
 * Handles /mcp route — Claude connects via SSE.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { corsHeaders } from './config';
import { log } from './logger';

// Shared API caller — calls our own HTTP server
let _serverPort = 3111;

export function setMcpServerPort(port: number) {
  _serverPort = port;
}

function createMcpServer() {
  const mcpServer = new Server(
    { name: 'claude-code-ui', version: '1.0.0' },
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
