/**
 * OpenAPI 3.1 specification for the Codiby Code bridge API.
 *
 * Hand-authored (the bridge routes are inline `if (url.pathname === …)` checks
 * in `server/index.ts` with no framework metadata, so there is nothing to
 * introspect). Kept as a plain JS object so it bundles into the single
 * `server.js` artifact produced by `electron-bundle-resources.sh` — no loose
 * `.yaml` to ship.
 *
 * Served as `/openapi.json` by `server/swagger.ts`. The `servers[0].url` is
 * rewritten at request time to the live bridge port so "Try it out" hits the
 * real API.
 */

// `as const` is intentionally avoided — the object is consumed as JSON, and we
// mutate `servers[0].url` per request in swagger.ts.
export type OpenApiSpec = Record<string, unknown>;

const corsResponse = { description: 'OK' };

/** Reusable error body: most handlers reply `{ error: string }` on failure. */
const ErrorRef = { $ref: '#/components/schemas/Error' };
const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorRef } },
});
const okResponse = {
  description: 'Success',
  content: {
    'application/json': {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    },
  },
};

const sessionIdParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'Session id (e.g. `ses_…`).',
};

export const openApiSpec: OpenApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Codiby Code — Bridge API',
    version: '0.20.0',
    description: [
      'HTTP + WebSocket API exposed by the local **bun bridge server**',
      '(`server/index.ts`). The bridge powers the desktop and mobile UIs and',
      'is also driven by the `codiby` CLI, Telegram, and MCP.',
      '',
      '### Auth',
      'Localhost requests are unauthenticated. Non-localhost (mobile / LAN /',
      'Tailscale Funnel) requests must send a bearer token: `Authorization:',
      'Bearer <token>` or `?token=<token>`. The token is obtained by pairing',
      'via `GET /mobile/pair` (localhost only).',
      '',
      '### Remote routing',
      'Any request may carry `?remoteId=<id>` to be transparently proxied to a',
      'configured remote workstation\'s bridge. Session-bound endpoints resolve',
      'the remote from the session id automatically.',
      '',
      '### WebSockets',
      'OpenAPI cannot model WebSocket channels; they are documented under the',
      '**WebSockets** tag as informational stubs. See each description for the',
      'message protocol.',
    ].join('\n'),
  },
  servers: [{ url: 'http://localhost:3111', description: 'Local bridge' }],
  tags: [
    { name: 'Health', description: 'Liveness & diagnostics' },
    { name: 'Sessions', description: 'Agent session lifecycle & messaging' },
    { name: 'Providers', description: 'Claude / OpenCode provider info' },
    { name: 'Remotes', description: 'Configured SSH remote workstations' },
    { name: 'Files', description: 'Filesystem browse / read / write' },
    { name: 'Exec', description: 'Process spawn & management' },
    { name: 'Git', description: 'Git status, diffs, branches, PRs' },
    { name: 'MCP', description: 'MCP server config + JSON-RPC endpoint' },
    { name: 'Search', description: 'ripgrep-backed content search' },
    { name: 'Worktree', description: 'git worktree creation' },
    { name: 'Integrations', description: 'Telegram, Deepgram, Tailscale' },
    { name: 'Portless', description: 'Named local dev servers with stable hostnames' },
    { name: 'PR Links', description: 'Persisted PR association per session' },
    { name: 'Preferences', description: 'UI preferences & Claude hooks' },
    { name: 'LSP', description: 'Language server support' },
    { name: 'Debug', description: 'Chrome DevTools Protocol bridging' },
    { name: 'Mobile', description: 'Pairing & push notifications' },
    { name: 'Plugins', description: 'Sideloaded plugin manifests' },
    { name: 'WebSockets', description: 'Realtime channels (informational)' },
  ],

  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
      tokenQuery: { type: 'apiKey', in: 'query', name: 'token' },
    },
    parameters: {
      RemoteId: {
        name: 'remoteId',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: 'Proxy this request to the given configured remote bridge.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
        required: ['error'],
      },
      PortForward: {
        type: 'object',
        properties: {
          localPort: { type: ['integer', 'null'], description: 'null → pick a free port at open time' },
          remotePort: { type: 'integer' },
          label: { type: 'string' },
        },
        required: ['remotePort'],
      },
      Session: {
        type: 'object',
        description: 'Session as serialized by the bridge (snake_case wire format).',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          cwd: { type: 'string' },
          created_at: { type: 'integer', description: 'epoch ms' },
          updated_at: { type: 'integer', description: 'epoch ms' },
          status: { type: 'string', enum: ['open', 'archived'] },
          runtime_status: { type: 'string', enum: ['starting', 'running', 'stopped'] },
          ready: { type: 'boolean' },
          claude_session_id: { type: ['string', 'null'] },
          ws_url: { type: 'string', description: 'Legacy per-session browser WS URL' },
          saved_commands: { type: 'array', items: { type: 'string' } },
          model: { type: ['string', 'null'] },
          permission_mode: { type: 'string', default: 'default' },
          provider: { type: 'string', default: 'claude' },
          remoteId: { type: ['string', 'null'] },
          remoteColor: { type: ['string', 'null'] },
          remoteName: { type: ['string', 'null'] },
        },
      },
      Remote: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'rmt_<uuid>' },
          name: { type: 'string' },
          alias: { type: 'string', description: 'Host alias in ~/.ssh/config' },
          bunPort: { type: 'integer', default: 3111 },
          color: { type: 'string' },
          createdAt: { type: 'integer' },
        },
      },
    },
  },

  // Non-localhost callers need a token; localhost is exempt. Declared globally
  // so Swagger UI shows the "Authorize" button.
  security: [{ bearerAuth: [] }, { tokenQuery: [] }, {}],

  paths: {
    // ───────────────────────── Health ─────────────────────────
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Liveness probe',
        description: 'Always public (no auth). Returns session count.',
        security: [{}],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { status: { type: 'string' }, sessions: { type: 'integer' } },
                },
              },
            },
          },
        },
      },
    },
    '/ui-log': {
      post: {
        tags: ['Health'],
        summary: 'Append a line to the bridge log from the UI',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] } } },
        },
        responses: { 200: okResponse },
      },
    },

    // ───────────────────────── Sessions ─────────────────────────
    '/sessions': {
      get: {
        tags: ['Sessions'],
        summary: 'List all sessions (local + cached remote)',
        responses: {
          200: {
            description: 'Session list',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Session' } } } },
          },
        },
      },
      post: {
        tags: ['Sessions'],
        summary: 'Create a session',
        description: 'Pass `remoteId` to create the session on a remote bridge. `?focus=1` tells clients to switch to the new tab.',
        parameters: [
          { name: 'focus', in: 'query', required: false, schema: { type: 'string', enum: ['1'] } },
        ],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  cwd: { type: 'string', description: 'Working directory (defaults to bridge CWD)' },
                  name: { type: 'string' },
                  model: { type: ['string', 'null'] },
                  provider: { type: 'string', description: 'claude | codex | opencode …' },
                  permissionMode: { type: 'string', default: 'default' },
                  remoteId: { type: ['string', 'null'] },
                  group_cwd: { type: 'string', description: 'Worktree spawn hint for auto-grouping' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Created session', content: { 'application/json': { schema: { $ref: '#/components/schemas/Session' } } } },
          404: errorResponse('Remote not found'),
        },
      },
    },
    '/sessions/{id}': {
      patch: {
        tags: ['Sessions'],
        summary: 'Rename / update a session',
        parameters: [sessionIdParam],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } },
        },
        responses: { 200: { description: 'Updated session', content: { 'application/json': { schema: { $ref: '#/components/schemas/Session' } } } } },
      },
      delete: {
        tags: ['Sessions'],
        summary: 'Delete / archive a session',
        description: '`?purge=1` also deletes on-disk history + UI state. `?worktree=1` removes the git worktree when cwd looks like one.',
        parameters: [
          sessionIdParam,
          { name: 'purge', in: 'query', required: false, schema: { type: 'string', enum: ['1'] } },
          { name: 'worktree', in: 'query', required: false, schema: { type: 'string', enum: ['1'] } },
        ],
        responses: { 200: okResponse },
      },
    },
    '/sessions/{id}/resume': {
      post: { tags: ['Sessions'], summary: 'Resume a stopped session', parameters: [sessionIdParam], responses: { 200: corsResponse } },
    },
    '/sessions/{id}/stop': {
      post: { tags: ['Sessions'], summary: 'Stop the underlying provider process', parameters: [sessionIdParam], responses: { 200: corsResponse } },
    },
    '/sessions/{id}/restart': {
      post: { tags: ['Sessions'], summary: 'Restart provider preserving history', parameters: [sessionIdParam], responses: { 200: corsResponse } },
    },
    '/sessions/{id}/clear': {
      post: { tags: ['Sessions'], summary: 'Clear the conversation', parameters: [sessionIdParam], responses: { 200: corsResponse } },
    },
    '/sessions/{id}/messages': {
      post: {
        tags: ['Sessions'],
        summary: 'Send a user message (HTTP equivalent of the `send_message` WS event)',
        parameters: [sessionIdParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  images: { type: 'array', items: { type: 'object', properties: { media_type: { type: 'string' }, data: { type: 'string', description: 'base64' } } } },
                },
                required: ['text'],
              },
            },
          },
        },
        responses: { 200: corsResponse, 400: errorResponse('text required') },
      },
    },
    '/sessions/{id}/port-forwards': {
      get: { tags: ['Sessions'], summary: 'List port forwards (remote sessions)', parameters: [sessionIdParam], responses: { 200: corsResponse } },
      post: {
        tags: ['Sessions'],
        summary: 'Add a port forward',
        parameters: [sessionIdParam],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PortForward' } } } },
        responses: { 200: corsResponse },
      },
    },
    '/sessions/{id}/port-forwards/{remotePort}/{localPort}': {
      delete: {
        tags: ['Sessions'],
        summary: 'Remove a port forward',
        parameters: [
          sessionIdParam,
          { name: 'remotePort', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'localPort', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: { 200: corsResponse },
      },
    },

    // ───────────────────────── Providers ─────────────────────────
    '/providers/opencode/info': {
      get: { tags: ['Providers'], summary: 'OpenCode provider info', responses: { 200: corsResponse } },
    },
    '/providers/claude/info': {
      get: { tags: ['Providers'], summary: 'Claude provider info (binary path, version)', responses: { 200: corsResponse } },
    },

    // ───────────────────────── Remotes ─────────────────────────
    '/remotes': {
      get: {
        tags: ['Remotes'],
        summary: 'List configured remotes',
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Remote' } } } } } },
      },
      post: {
        tags: ['Remotes'],
        summary: 'Add a remote',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, alias: { type: 'string' }, bunPort: { type: 'integer' }, color: { type: 'string' } }, required: ['name', 'alias'] } } },
        },
        responses: { 200: { description: 'Created remote', content: { 'application/json': { schema: { $ref: '#/components/schemas/Remote' } } } } },
      },
    },
    '/remotes/{id}': {
      patch: {
        tags: ['Remotes'],
        summary: 'Update a remote',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Remote' } } } },
        responses: { 200: corsResponse },
      },
      delete: {
        tags: ['Remotes'],
        summary: 'Remove a remote',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: corsResponse },
      },
    },
    '/remotes/{id}/test': {
      post: {
        tags: ['Remotes'],
        summary: 'Test SSH connectivity to a remote',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: corsResponse },
      },
    },

    // ───────────────────────── Files ─────────────────────────
    '/ls': {
      get: {
        tags: ['Files'],
        summary: 'List directories under a prefix',
        parameters: [{ name: 'prefix', in: 'query', required: false, schema: { type: 'string', default: '/' } }],
        responses: { 200: corsResponse },
      },
    },
    '/user-home': {
      get: { tags: ['Files'], summary: "Current user's home directory", responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { home: { type: 'string' } } } } } } } },
    },
    '/files': {
      get: {
        tags: ['Files'],
        summary: 'List files in a directory',
        parameters: [{ name: 'path', in: 'query', required: false, schema: { type: 'string', default: '/' } }],
        responses: { 200: corsResponse },
      },
    },
    '/file-index': {
      get: {
        tags: ['Files'],
        summary: 'Build a flat file index for a repo root (for fuzzy file picker)',
        parameters: [{ name: 'root', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: corsResponse, 400: errorResponse('root required') },
      },
    },
    '/file-content': {
      get: {
        tags: ['Files'],
        summary: 'Read a file',
        parameters: [{ name: 'path', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } } } },
          404: errorResponse('Cannot read file'),
        },
      },
      put: {
        tags: ['Files'],
        summary: 'Write a file',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } } },
        responses: { 200: okResponse, 400: errorResponse('path required'), 500: errorResponse('write failed') },
      },
      delete: {
        tags: ['Files'],
        summary: 'Delete a file or directory',
        parameters: [{ name: 'path', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: corsResponse, 400: errorResponse('path required') },
      },
    },
    '/file-original': {
      get: {
        tags: ['Files'],
        summary: 'Git blob of a file at HEAD (or merge-base of `base`)',
        description: 'Used to compute diffs. Returns empty content when the file is untracked.',
        parameters: [
          { name: 'path', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'base', in: 'query', required: false, schema: { type: 'string' }, description: 'Branch to diff against (merge-base vs HEAD)' },
        ],
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } } } } },
      },
    },
    '/file-rename': {
      post: {
        tags: ['Files'],
        summary: 'Rename / move a path',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } } } },
        responses: { 200: corsResponse, 400: errorResponse('from and to required') },
      },
    },
    '/file-new': {
      post: {
        tags: ['Files'],
        summary: 'Create a file or directory',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { path: { type: 'string' }, kind: { type: 'string', enum: ['file', 'dir'] } }, required: ['path', 'kind'] } } } },
        responses: { 200: corsResponse, 400: errorResponse('path and kind required') },
      },
    },
    '/file-reveal': {
      post: {
        tags: ['Files'],
        summary: 'Reveal a path in the OS file manager (Finder)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } } },
        responses: { 200: corsResponse, 400: errorResponse('path required') },
      },
    },

    // ───────────────────────── Terminals (CRUD) ─────────────────────────
    // Single source of truth for terminal lifecycle, shared by the UI and the
    // in-process MCP tools. Live I/O stays on the /ws multiplexer.
    '/sessions/{id}/terminals': {
      get: {
        tags: ['Terminals'],
        summary: 'List a session\'s terminals',
        parameters: [sessionIdParam],
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { terminals: { type: 'array', items: { type: 'object' } } } } } } } },
      },
      post: {
        tags: ['Terminals'],
        summary: 'Create a terminal (broadcasts terminal_created)',
        parameters: [sessionIdParam],
        requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, cols: { type: 'integer' }, rows: { type: 'integer' }, terminalName: { type: 'string' } } } } } },
        responses: { 200: corsResponse, 500: errorResponse('spawn failed') },
      },
    },
    '/sessions/{id}/terminals/{procId}': {
      get: {
        tags: ['Terminals'],
        summary: 'Read one terminal (append ?output=1 for the buffer)',
        parameters: [sessionIdParam, { name: 'procId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'output', in: 'query', required: false, schema: { type: 'string' } }],
        responses: { 200: corsResponse, 404: errorResponse('not found') },
      },
      delete: {
        tags: ['Terminals'],
        summary: 'Kill a terminal (broadcasts terminal_removed)',
        parameters: [sessionIdParam, { name: 'procId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: corsResponse, 404: errorResponse('not found') },
      },
    },

    // ───────────────────────── Git ─────────────────────────
    '/git-modified': {
      get: {
        tags: ['Git'],
        summary: 'List modified files for a repo root',
        parameters: [
          { name: 'root', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'base', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { 200: corsResponse, 400: errorResponse('root required') },
      },
    },
    '/git-stage': {
      post: {
        tags: ['Git'],
        summary: 'Stage / unstage files',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { root: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, unstage: { type: 'boolean' } }, required: ['root', 'files'] } } } },
        responses: { 200: okResponse, 400: errorResponse('root and files required'), 500: errorResponse('git failed') },
      },
    },
    '/git-info': {
      get: {
        tags: ['Git'],
        summary: 'Git info for a directory (branch, ahead/behind, dirty)',
        parameters: [{ name: 'path', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: corsResponse, 400: errorResponse('path required') },
      },
    },
    '/git-branches': {
      get: {
        tags: ['Git'],
        summary: 'List branches for a repo',
        parameters: [{ name: 'cwd', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: corsResponse, 400: errorResponse('cwd required') },
      },
    },
    '/git-checkout': {
      post: {
        tags: ['Git'],
        summary: 'Checkout a branch',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { cwd: { type: 'string' }, branch: { type: 'string' } }, required: ['cwd', 'branch'] } } } },
        responses: { 200: corsResponse, 400: errorResponse('cwd and branch required') },
      },
    },
    '/gh-prs': {
      get: {
        tags: ['Git'],
        summary: 'List GitHub PRs (via `gh`) for a repo',
        parameters: [
          { name: 'cwd', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'session', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { 200: corsResponse, 400: errorResponse('cwd required') },
      },
    },
    '/pr-detail': {
      get: {
        tags: ['Git'],
        summary: 'PR detail via `gh pr view`',
        parameters: [
          { name: 'number', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'cwd', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { 200: corsResponse, 400: errorResponse('missing number'), 502: errorResponse('gh failed') },
      },
    },

    // ───────────────────────── PR Links ─────────────────────────
    '/pr-links': {
      get: { tags: ['PR Links'], summary: 'All persisted PR links', responses: { 200: corsResponse } },
    },
    '/pr-link/{sessionId}': {
      get: {
        tags: ['PR Links'],
        summary: 'Get the PR link for a session',
        parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: corsResponse },
      },
      put: {
        tags: ['PR Links'],
        summary: 'Associate a PR with a session',
        parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { prNumber: { type: 'integer' }, title: { type: 'string' }, url: { type: 'string' }, headRefName: { type: 'string' }, state: { type: 'string' } } } } } },
        responses: { 200: okResponse },
      },
      delete: {
        tags: ['PR Links'],
        summary: 'Remove a session\'s PR link',
        parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: okResponse },
      },
    },

    // ───────────────────────── MCP ─────────────────────────
    '/mcp-servers': {
      get: {
        tags: ['MCP'],
        summary: 'List configured MCP servers',
        parameters: [{ name: 'cwd', in: 'query', required: false, schema: { type: 'string' }, description: 'Include project-scoped servers from <cwd>/.mcp.json' }],
        responses: { 200: corsResponse },
      },
      post: {
        tags: ['MCP'],
        summary: 'Add an MCP server',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, scope: { type: 'string', enum: ['user', 'project'] }, cwd: { type: 'string' }, config: { type: 'object', additionalProperties: true } } } } } },
        responses: { 200: corsResponse },
      },
    },
    '/mcp-servers/{name}': {
      delete: {
        tags: ['MCP'],
        summary: 'Remove an MCP server',
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'scope', in: 'query', required: false, schema: { type: 'string', enum: ['user', 'project'], default: 'user' } },
          { name: 'cwd', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { 200: corsResponse },
      },
    },
    '/mcp': {
      post: {
        tags: ['MCP'],
        summary: 'MCP JSON-RPC endpoint (Streamable HTTP transport)',
        description: 'The bridge\'s own MCP server. Speaks the Model Context Protocol; not a REST endpoint.',
        requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        responses: { 200: corsResponse },
      },
    },

    // ───────────────────────── Search / Worktree / Misc ─────────────────────────
    '/search': {
      get: {
        tags: ['Search'],
        summary: 'ripgrep content search',
        parameters: [
          { name: 'root', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'case', in: 'query', required: false, schema: { type: 'string', enum: ['smart', 'sensitive', 'insensitive'], default: 'smart' } },
          { name: 'ignore', in: 'query', required: false, schema: { type: 'string' }, description: 'Comma-separated ignore globs (max 32)' },
        ],
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { results: { type: 'array', items: { type: 'object' } } } } } } } },
      },
    },
    '/worktree': {
      post: {
        tags: ['Worktree'],
        summary: 'Create a git worktree',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { repoPath: { type: 'string' }, branch: { type: 'string' } } } } } },
        responses: { 200: corsResponse },
      },
    },
    '/save-commands': {
      post: {
        tags: ['Sessions'],
        summary: 'Persist a session\'s saved command list',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { sessionId: { type: 'string' }, commands: { type: 'array', items: { type: 'string' } } }, required: ['sessionId'] } } } },
        responses: { 200: okResponse, 400: errorResponse('sessionId required'), 404: errorResponse('not found') },
      },
    },

    // ───────────────────────── Integrations ─────────────────────────
    '/telegram/settings': {
      get: { tags: ['Integrations'], summary: 'Get Telegram bot settings', responses: { 200: corsResponse } },
      put: {
        tags: ['Integrations'],
        summary: 'Update Telegram bot settings (restarts the bot)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { botToken: { type: 'string' }, chatId: { type: 'string' } } } } } },
        responses: { 200: corsResponse },
      },
    },
    '/deepgram/settings': {
      get: { tags: ['Integrations'], summary: 'Get Deepgram transcription settings', responses: { 200: corsResponse } },
      put: {
        tags: ['Integrations'],
        summary: 'Update Deepgram settings',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { apiKey: { type: 'string' }, model: { type: 'string', default: 'nova-3' }, language: { type: 'string', default: 'multi' } } } } } },
        responses: { 200: corsResponse },
      },
    },
    '/deepgram/transcribe': {
      post: {
        tags: ['Integrations'],
        summary: 'Transcribe a one-shot audio blob',
        description: 'POST raw audio bytes; returns the joined transcript.',
        requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { transcript: { type: 'string' }, detectedLanguage: { type: 'string' }, durationSec: { type: 'number' } } } } } },
          400: { description: 'empty audio body' },
          500: { description: 'transcription failed' },
        },
      },
    },
    '/tailscale/settings': {
      get: { tags: ['Integrations'], summary: 'Get Tailscale Funnel status', responses: { 200: corsResponse } },
      put: {
        tags: ['Integrations'],
        summary: 'Enable / disable Tailscale Funnel',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { funnelEnabled: { type: 'boolean' } } } } } },
        responses: { 200: corsResponse, 400: errorResponse('funnel toggle failed') },
      },
    },

    // ───────────────────────── Portless ─────────────────────────
    '/portless/cli-status': {
      get: { tags: ['Portless'], summary: 'portless CLI availability', responses: { 200: corsResponse } },
    },
    '/portless/status': {
      get: { tags: ['Portless'], summary: 'Snapshot of all portless actions', responses: { 200: corsResponse } },
    },
    '/portless/run': {
      post: {
        tags: ['Portless'],
        summary: 'Start a named dev server',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: {
            groupId: { type: 'string' }, actionId: { type: 'string' }, name: { type: 'string' }, command: { type: 'string' },
            hostname: { type: 'string' }, cwd: { type: 'string' }, noTls: { type: 'boolean' },
            source: { type: 'string', enum: ['user', 'agent'] }, sessionId: { type: 'string' },
          }, required: ['groupId', 'actionId', 'name', 'command', 'hostname', 'cwd'] } } },
        },
        responses: { 200: corsResponse, 400: errorResponse('missing required fields') },
      },
    },
    '/portless/stop': {
      post: {
        tags: ['Portless'],
        summary: 'Stop a named dev server',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { groupId: { type: 'string' }, actionId: { type: 'string' } }, required: ['groupId', 'actionId'] } } } },
        responses: { 200: corsResponse, 400: errorResponse('groupId and actionId required') },
      },
    },
    '/portless/stop-all': {
      post: { tags: ['Portless'], summary: 'Stop all named dev servers', responses: { 200: okResponse } },
    },
    '/portless/forget': {
      post: {
        tags: ['Portless'],
        summary: 'Forget a stopped action',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { groupId: { type: 'string' }, actionId: { type: 'string' } }, required: ['groupId', 'actionId'] } } } },
        responses: { 200: okResponse, 400: errorResponse('groupId and actionId required') },
      },
    },
    '/portless/detect': {
      get: {
        tags: ['Portless'],
        summary: 'Suggest dev-server scripts from package.json',
        parameters: [{ name: 'cwd', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: corsResponse, 400: errorResponse('cwd required') },
      },
    },
    '/portless/scan-env': {
      get: {
        tags: ['Portless'],
        summary: 'Scan .env files for URL-ish vars to map to actions',
        parameters: [
          { name: 'cwd', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'actionNames', in: 'query', required: false, schema: { type: 'string' }, description: 'Comma-separated action names' },
        ],
        responses: { 200: corsResponse, 400: errorResponse('cwd required'), 500: errorResponse('scan failed') },
      },
    },
    '/portless/proxy/status': {
      get: { tags: ['Portless'], summary: 'Reverse-proxy status', responses: { 200: corsResponse } },
    },
    '/portless/proxy/start': {
      post: {
        tags: ['Portless'],
        summary: 'Start the reverse proxy',
        requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { mode: { type: 'string', enum: ['default', 'http80', 'https443'] } } } } } },
        responses: { 200: corsResponse, 400: errorResponse('start failed') },
      },
    },
    '/portless/proxy/stop': {
      post: { tags: ['Portless'], summary: 'Stop the reverse proxy', responses: { 200: corsResponse, 400: errorResponse('stop failed') } },
    },
    '/portless/trust': {
      post: { tags: ['Portless'], summary: 'Trust the portless CA certificate', responses: { 200: corsResponse, 400: errorResponse('trust failed') } },
    },

    // ───────────────────────── Preferences / Hooks / LSP ─────────────────────────
    '/preferences': {
      get: { tags: ['Preferences'], summary: 'Get UI preferences', responses: { 200: corsResponse } },
      put: {
        tags: ['Preferences'],
        summary: 'Update UI preferences (partial merge)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        responses: { 200: okResponse },
      },
    },
    '/claude-hooks': {
      get: {
        tags: ['Preferences'],
        summary: 'Read Claude hooks (global or project settings.json)',
        parameters: [
          { name: 'scope', in: 'query', required: false, schema: { type: 'string', enum: ['global', 'project'], default: 'global' } },
          { name: 'cwd', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { 200: corsResponse, 400: errorResponse('read failed') },
      },
      put: {
        tags: ['Preferences'],
        summary: 'Write Claude hooks',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { scope: { type: 'string', enum: ['global', 'project'] }, cwd: { type: 'string' }, hooks: { type: 'object', additionalProperties: true } } } } } },
        responses: { 200: corsResponse, 400: errorResponse('write failed') },
      },
    },
    '/lsp/languages': {
      get: { tags: ['LSP'], summary: 'Supported language servers', responses: { 200: corsResponse } },
    },

    // ───────────────────────── Debug (CDP) ─────────────────────────
    '/debug/targets': {
      get: {
        tags: ['Debug'],
        summary: 'Discover CDP targets on a host:port',
        parameters: [
          { name: 'host', in: 'query', required: false, schema: { type: 'string', default: '127.0.0.1' } },
          { name: 'port', in: 'query', required: false, schema: { type: 'integer', default: 9229 } },
        ],
        responses: { 200: corsResponse },
      },
    },
    '/debug/connect': {
      post: {
        tags: ['Debug'],
        summary: 'Connect to a CDP target',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { host: { type: 'string', default: '127.0.0.1' }, port: { type: 'integer', default: 9229 }, targetId: { type: 'string' } } } } } },
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { connectionId: { type: 'string' }, host: { type: 'string' }, port: { type: 'integer' }, targetId: { type: 'string' } } } } } },
          502: errorResponse('Failed to connect'),
        },
      },
    },
    '/debug/disconnect': {
      post: {
        tags: ['Debug'],
        summary: 'Disconnect a CDP connection',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { connectionId: { type: 'string' } }, required: ['connectionId'] } } } },
        responses: { 200: okResponse },
      },
    },
    '/debug/{sessionId}': {
      get: {
        tags: ['Debug'],
        summary: 'Diagnostic snapshot of a session\'s runtime state',
        parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: corsResponse, 404: errorResponse('not found') },
      },
    },

    // ───────────────────────── Mobile ─────────────────────────
    '/mobile/pair': {
      get: {
        tags: ['Mobile'],
        summary: 'Get the pairing token + QR (localhost only)',
        description: 'Restricted to localhost so only the desktop user can read the token.',
        security: [{}],
        responses: { 200: corsResponse, 403: { description: 'Forbidden (non-localhost)' } },
      },
    },
    '/mobile/pair/regenerate': {
      post: {
        tags: ['Mobile'],
        summary: 'Rotate the pairing token (localhost only)',
        description: 'Kicks all authenticated WebSockets so they reconnect with the new token.',
        security: [{}],
        responses: { 200: corsResponse, 403: { description: 'Forbidden (non-localhost)' } },
      },
    },
    '/mobile/notify-test': {
      post: {
        tags: ['Mobile'],
        summary: 'Send a test push notification',
        responses: { 200: corsResponse },
      },
    },

    // ───────────────────────── Plugins ─────────────────────────
    '/plugins': {
      get: {
        tags: ['Plugins'],
        summary: 'List sideloaded plugin manifests',
        description: 'Plugin-registered routes live under `/plugins/<id>/…` and are dispatched dynamically.',
        responses: { 200: corsResponse },
      },
    },

    // ───────────────────────── WebSockets (informational) ─────────────────────────
    '/ws': {
      get: {
        tags: ['WebSockets'],
        summary: 'Multiplexed frontend WebSocket (upgrade)',
        description: [
          'Primary realtime channel. On connect the server pushes `welcome`,',
          '`preferences`, then `sessions`. Client sends events like',
          '`active_tab_change`, `send_message`, `subscribe`. **Not a REST',
          'endpoint** — perform a WebSocket upgrade to `ws(s)://host/ws`.',
        ].join(' '),
        responses: { 101: { description: 'Switching Protocols (WebSocket)' } },
      },
    },
    '/browser/ws/{sessionId}': {
      get: {
        tags: ['WebSockets'],
        summary: 'Legacy per-session browser WebSocket (upgrade)',
        description: 'Kept for backwards compatibility; remote sessions are proxied to the remote bridge. WebSocket upgrade only.',
        parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 101: { description: 'Switching Protocols (WebSocket)' } },
      },
    },
    '/terminal/ws/{procId}': {
      get: {
        tags: ['WebSockets'],
        summary: 'Terminal viewer WebSocket (upgrade)',
        description: 'Streams PTY/process output for a tracked process. WebSocket upgrade only.',
        parameters: [{ name: 'procId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 101: { description: 'Switching Protocols (WebSocket)' } },
      },
    },
    '/lsp/ws/{sessionId}/{languageId}': {
      get: {
        tags: ['WebSockets'],
        summary: 'Language Server Protocol WebSocket (upgrade)',
        description: 'Bidirectional LSP JSON-RPC bridged to a language server. WebSocket upgrade only.',
        parameters: [
          { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'languageId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 101: { description: 'Switching Protocols (WebSocket)' } },
      },
    },
    '/debug/ws/{connectionId}': {
      get: {
        tags: ['WebSockets'],
        summary: 'Chrome DevTools Protocol WebSocket (upgrade)',
        description: 'Forwards CDP messages to/from a connected debug target. WebSocket upgrade only.',
        parameters: [{ name: 'connectionId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 101: { description: 'Switching Protocols (WebSocket)' } },
      },
    },
  },
};
