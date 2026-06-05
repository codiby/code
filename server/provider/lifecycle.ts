/**
 * Session lifecycle — spawns a ProviderSession for the given `Session` using
 * the registered adapter, wires bridge events, and attaches the handle.
 */

import { getProvider } from './registry';
import { createBridgeEvents } from './bridge';
import type { BridgeDeps } from './bridge';
import { buildSessionSdkMcpServer } from './sdk-tools';
import { loadPreferences } from '../storage';
import { startSessionWatcher } from '../watcher';
import type { Session } from '../types';
import type { McpServerSpec, PermissionMode, SpawnOptions } from './types';

// Wired lazily from index.ts to avoid circular imports.
let bridgeDeps: BridgeDeps | null = null;

export function setBridgeDeps(deps: BridgeDeps): void {
  bridgeDeps = deps;
}

export function startProviderSession(session: Session, port: number, resumeSessionId?: string | null): void {
  if (!bridgeDeps) {
    throw new Error('Provider bridge not initialized — call setBridgeDeps() first.');
  }

  const adapter = getProvider(session.provider || 'claudeAgent');

  const mcpServers: Record<string, McpServerSpec> = {
    'codiby-code': {
      // Streamable HTTP — matches WebStandardStreamableHTTPServerTransport
      // on the server side. Previously set to `sse`, which made the native
      // Claude CLI open a classic SSE stream and silently never finish the
      // MCP handshake (no `tools/list` request → tools never surfaced).
      type: 'http',
      url: `http://localhost:${port}/mcp`,
      headers: { 'x-session-id': session.id },
    },
    // In-process SDK tools — run inside the bridge with access to session
    // state and the WebSocket broadcaster (no HTTP hop).
    'codiby-code-sdk': {
      type: 'sdk',
      server: buildSessionSdkMcpServer(session.id, {
        broadcastToSession: bridgeDeps.broadcastToSession,
        broadcastSessionList: bridgeDeps.broadcastSessionList,
        loadPreferences,
      }),
    },
  };

  const permissionMode: PermissionMode = (session.permissionMode as PermissionMode) || 'default';

  const opts: SpawnOptions = {
    sessionId: session.id,
    cwd: session.cwd,
    model: session.model,
    permissionMode,
    resumeSessionId: resumeSessionId ?? null,
    mcpServers,
  };

  session.runtimeStatus = 'starting';
  session.ready = false;
  // Bump the generation BEFORE creating the bridge so the bridge's
  // captured `gen` reflects the new provider. A late-firing `onExit`
  // from a previous provider (e.g. when the user restarts the session
  // and the old Claude process takes a moment to die) will see a
  // different `session.providerSessionGen` and skip its state
  // mutations — preventing it from clobbering the new providerSession
  // and runtimeStatus. See `createBridgeEvents` in bridge.ts.
  session.providerSessionGen += 1;
  session.providerSession = adapter.spawn(opts, createBridgeEvents(session, bridgeDeps));

  // The claude CLI (via the SDK's stdin/stdout pipe) doesn't emit its `system
  // init` message until it receives a user prompt — so waiting for `onInit`
  // would leave the UI stuck on "Waiting for connection" until the user types.
  // The process is up and able to accept writes the moment spawn() returns, so
  // flip to connected immediately. `onInit` will still populate initInfo when
  // the first real turn starts.
  session.runtimeStatus = 'running';
  session.ready = true;
  bridgeDeps.broadcastToSession(session.id, { type: 'status', sessionId: session.id, status: 'connected' });
  bridgeDeps.broadcastSessionList();

  // Watch the session's workspace and stream file/folder changes to the
  // frontend. Idempotent across restarts; skipped for remote sessions (their
  // cwd lives on the remote host, not on this machine).
  if (!session.remoteId) {
    startSessionWatcher(session.id, session.cwd, bridgeDeps.broadcastToSession);
  }
}
