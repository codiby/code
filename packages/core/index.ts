/**
 * Bridge server entry point.
 *
 * Run as HTTP server (default): bun run server/index.ts
 * Run as MCP server (stdio):    bun run server/index.ts --mcp
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, statSync } from 'fs';
import { dirname, join, extname } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

import { PORT, HOST, CLAUDE_BIN, corsHeaders, CWD, CODIBY_DIR, loadOrCreateMobileToken, getLanIp, resolveTls } from './config';
import { handleMobilePair, handleMobilePairRegenerate, handleMobileNotifyTest } from './handlers/mobile';
import { notifyPermissionResolved } from './notify';
import { log, registerGlobalErrorHandlers } from './logger';
import { sessions, loadSessions, saveSessions, sessionToJSON, setStatusBroadcaster } from './sessions';
import { loadRemotes, getRemote } from './remotes';
import { migrateToCodiby } from './migrate-to-codiby';
import {
  handleListRemotes,
  handleAddRemote,
  handleUpdateRemote,
  handleRemoveRemote,
  handleTestRemote,
} from './handlers/remotes';
// Remote traffic is no longer proxied by bun — the renderer connects directly
// to each remote's tunnelled bridge (Electron main owns the SSH tunnels), so
// the former gateway/ssh-tunnel imports are gone.
import { getMergedRemoteGroups, isRemoteGroupId } from './remote-groups-cache';
import { handleCreateSession, handleResumeSession, handleRestartSession, handleRenameSession, handleStopSession, handleDeleteSession, handleClearSession } from './handlers/sessions';
import { handleListMcpServers, handleAddMcpServer, handleRemoveMcpServer } from './handlers/mcp-servers';
import { getOpencodeInfo } from './handlers/opencode-info';
import { getClaudeInfo } from './handlers/claude-info';
import { ClaudeAdapter } from './provider/adapters/ClaudeAdapter';
import { CodexAdapter } from './provider/adapters/CodexAdapter';
import { OpenCodeAdapter } from './provider/adapters/OpenCodeAdapter';
import { registerProvider } from './provider/registry';
import { setBridgeDeps, startProviderSession } from './provider/lifecycle';
import { resolvePermissionDecision } from './provider/bridge';
import { handleBrowserResponse } from './provider/browser-cdp';
import { handleListDirs, handleListFiles, handleFileIndex, handleDeletePath, handleRenamePath, handleCreateFile, handleCreateDir, handleRevealInFinder } from './handlers/files';
import { startProcessMonitor, pokeProcessMonitor } from './process-monitor';
import { trackedProcesses, restoreProcessRegistry } from './handlers/processes';
import {
  setTerminalBroadcaster,
  createTerminal,
  attachTerminal,
  listTerminals,
  getTerminal,
  getTerminalOutput,
  removeTerminal,
} from './handlers/terminals';
import { handleGitModified, handleGitInfo, handleGhPrs, handleGitBranches, handleGitCheckout, baseDiffRef, runShell } from './handlers/git';
import { handleSearch } from './handlers/search';
import { handleCreateWorktree, handleRemoveWorktree } from './handlers/worktree';
import { getOrCreateLsp, sendToLsp, addLspClient, removeLspClient, killSessionLsp, supportedLanguages } from './handlers/lsp';
import { discoverTargets, connectToTarget, getConnection, disconnectTarget, addCdpClient, removeCdpClient, sendCdpMessage } from './handlers/cdp';
import { registerShutdownHandlers } from './shutdown';
import { startTelegramBot, notifyTelegramIfMainSession, restartTelegramBot, isTelegramBotRunning, setTelegramBroadcaster } from './telegram';
import { ensureMcpConfig } from './ensure-mcp-config';
import * as pluginHost from './plugin-host';
import { handleMcpRequest, setMcpDeps } from './mcp';
import {
  getSessionState,
  updateSessionState,
  addMessage,
  healOrphanedToolUses,
  updateUIState,
  getStateForClient,
  clearSessionState,
} from './state';
import type { ChatMessage } from './state';
import { loadPRLinks, savePRLink, removePRLink, getPRLink, loadPreferences, savePreferences, loadKeybindings, saveKeybindings, loadTelegramSettings, saveTelegramSettings, loadDeepgramSettings, saveDeepgramSettings, loadTailscaleSettings, saveTailscaleSettings } from './storage';
import { readClaudeHooks, writeClaudeHooks, type ClaudeHooks } from './claude-settings';
import { createDocsApp } from './swagger';
import { Hono } from 'hono';
import { transcribeAudioBuffer } from './deepgram';
import { isTailscaleAvailable, getTailscaleHostname, getFunnelStatus, enableFunnel, disableFunnel } from './tailscale';
import {
  getPortlessCliStatus,
  runAction as portlessRunAction,
  stopAction as portlessStopAction,
  stopAll as portlessStopAll,
  forgetAction as portlessForgetAction,
  snapshotAll as portlessSnapshotAll,
  onPortlessStatus,
  onPortlessActionFired,
  onPortlessUrlResolved,
  type PortlessActionStatus,
  type PortlessUrlResolvedDetail,
  getProxyStatus as getPortlessProxyStatus,
  startProxy as startPortlessProxy,
  stopProxy as stopPortlessProxy,
  trustCA as trustPortlessCA,
  type ProxyMode,
} from './portless';
import { buildInjectedActionEnv, resolveGroupForSession, getGlobalTld } from './action-env';

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Install the last-resort error net first, so a throw/rejection during any of
// the startup steps below (or later, at request time) is logged instead of
// crashing the sidecar and taking every session down with it.
registerGlobalErrorHandlers('server');

// Register provider adapters before loading sessions (so default provider exists)
registerProvider(ClaudeAdapter);
registerProvider(CodexAdapter);
registerProvider(OpenCodeAdapter);

// `--spawned-by=app|service` (or `CODIBY_SPAWN_MODE=app|service`) tells the
// server who launched it. Used purely for telemetry and the PATH-enrichment
// heuristic in config.ts — session spawn is always lazy now: persisted
// sessions are surfaced to the UI immediately, but no Claude process is
// resumed until the user focuses that tab (or a message arrives for it).
type SpawnMode = 'app' | 'service';
function parseSpawnMode(): SpawnMode {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--spawned-by') {
      return argv[i + 1] === 'app' ? 'app' : 'service';
    }
    if (a.startsWith('--spawned-by=')) {
      return a.slice('--spawned-by='.length) === 'app' ? 'app' : 'service';
    }
  }
  return (process.env.CODIBY_SPAWN_MODE || '').toLowerCase() === 'app' ? 'app' : 'service';
}
const SPAWN_MODE: SpawnMode = parseSpawnMode();

// Move legacy `~/.claude/ui-*` data into `~/.codiby/` before any loader
// touches disk. No-op once the move has happened.
migrateToCodiby();
loadSessions();
loadRemotes();
restoreProcessRegistry();
ensureMcpConfig();
registerShutdownHandlers();

// ---------------------------------------------------------------------------
// Frontend WebSocket multiplexer
// ---------------------------------------------------------------------------

/** All connected frontend WebSocket clients */
const frontendClients = new Set<any>();

/** Which session IDs each frontend client is subscribed to */
const subscriptions = new Map<any, Set<string>>();

/** Broadcast a message to all frontend clients subscribed to a given session */
function broadcastToSession(sessionId: string, msg: object) {
  const data = JSON.stringify(msg);
  for (const [ws, subs] of subscriptions) {
    if (subs.has(sessionId)) {
      try { ws.send(data); } catch {}
    }
  }
}

/** Build the merged local + cached-remote session list the frontend
 *  consumes. Local entries get `remoteId: null`; remote entries are flattened
 *  into the same wire shape as a local session, with the remote's color/name
 *  attached so the sidebar can tint them. */
function buildFullSessionList(): any[] {
  // Local sessions only. Remote sessions are discovered by the renderer over
  // its DIRECT connection to each remote's tunnelled bridge — bun no longer
  // proxies or mirrors them.
  return [...sessions.values()].map(s => {
    const j = sessionToJSON(s, server.port) as any;
    j.remoteId = null;
    j.remoteColor = null;
    j.remoteName = null;
    return j;
  });
}

/** Broadcast a message to *every* connected frontend client, regardless of
 *  session subscription. Used for sidebar-wide signals like `session_activity`,
 *  which must reach a client even for sessions it isn't actively viewing. */
function broadcastToAllClients(msg: object) {
  const data = JSON.stringify(msg);
  for (const ws of frontendClients) {
    try { ws.send(data); } catch {}
  }
}

/** Broadcast the full session list to all connected frontend clients */
function broadcastSessionList() {
  const msg = JSON.stringify({ type: 'sessions', sessions: buildFullSessionList() });
  for (const ws of frontendClients) {
    try { ws.send(msg); } catch {}
  }
}

/** Broadcast the configured-remotes list to all clients. Live tunnel status is
 *  no longer bun's concern — the renderer gets it from Electron main. */
function broadcastRemoteList() {
  // Lazy require avoids circular import at module load.
  const { listRemotes } = require('./remotes') as typeof import('./remotes');
  const list = listRemotes();
  const data = JSON.stringify({ type: 'remotes', remotes: list });
  for (const ws of frontendClients) {
    try { ws.send(data); } catch {}
  }
}

// Repaint the sidebar when a session auto-unarchives on an incoming message.
setStatusBroadcaster(broadcastSessionList);

// Poll each session's process subtree for running children + listening ports,
// pushing `session_activity` to the frontend's sidebar badges on change. Sent
// to all clients (not subscription-scoped) so badges stay live for every
// session in the sidebar, not just the one the user is viewing.
startProcessMonitor((_sessionId, msg) => broadcastToAllClients(msg));

/** Broadcast a Portless action status update to every frontend client.
 *  This is a global stream (not per-session) so the Project Settings pane
 *  can update across windows and the running-actions toast can pop. */
function broadcastPortlessStatus(status: PortlessActionStatus) {
  const data = JSON.stringify({ type: 'portless_status', status });
  for (const ws of frontendClients) {
    try { ws.send(data); } catch {}
  }
}

/** Broadcast a "this action just fired" event — distinct from status so
 *  the UI can decide to pop a toast only for new launches (not for status
 *  transitions like running → exited). */
function broadcastPortlessFired(info: { action: PortlessActionStatus; source: 'user' | 'agent'; sessionId?: string }) {
  const data = JSON.stringify({ type: 'portless_fired', ...info });
  for (const ws of frontendClients) {
    try { ws.send(data); } catch {}
  }
}

/** Broadcast the resolved Portless URL after the proxy boots — usually a
 *  high port like :1355 because portless can't bind :443 without root.
 *  Components show the optimistic `https://<host>` first and swap it
 *  once this event arrives. */
function broadcastPortlessUrlResolved(detail: PortlessUrlResolvedDetail) {
  const data = JSON.stringify({ type: 'portless_url_resolved', ...detail });
  for (const ws of frontendClients) {
    try { ws.send(data); } catch {}
  }
}

onPortlessStatus(broadcastPortlessStatus);
onPortlessActionFired(broadcastPortlessFired);
onPortlessUrlResolved(broadcastPortlessUrlResolved);

/** Splice every known remote's cached tab groups into the local preferences
 *  blob so remote sessions render grouped. Group ids are UUIDs, so a flat
 *  merge can't collide with local groups. Done only on the wire to the
 *  frontend — never persisted to the local file (see updatePreferences). */
function withRemoteGroups(prefs: Record<string, unknown>): Record<string, unknown> {
  const { tabGroups, tabGroupMap } = getMergedRemoteGroups();
  if (!Object.keys(tabGroups).length && !Object.keys(tabGroupMap).length) return prefs;
  // A remote group's definition is owned by the remote, but the user can tweak
  // cosmetic fields locally (e.g. recolour it). Those edits live in
  // `remoteGroupOverrides` (see updatePreferences) and are layered on top here
  // so they survive every re-merge instead of being clobbered by the remote's
  // original value.
  const overrides = (prefs.remoteGroupOverrides as Record<string, Record<string, unknown>>) ?? {};
  const remoteGroups: Record<string, unknown> = { ...tabGroups };
  for (const [gid, ov] of Object.entries(overrides)) {
    if (remoteGroups[gid] && ov && typeof ov === 'object') {
      remoteGroups[gid] = { ...(remoteGroups[gid] as Record<string, unknown>), ...ov };
    }
  }
  return {
    ...prefs,
    tabGroups: { ...((prefs.tabGroups as Record<string, unknown>) ?? {}), ...remoteGroups },
    tabGroupMap: { ...((prefs.tabGroupMap as Record<string, unknown>) ?? {}), ...tabGroupMap },
  };
}

/** Broadcast the full preferences object so clients stay in sync after a
 *  server-side mutation (e.g. an MCP tool updating tab groups). */
function broadcastPreferences(prefs: Record<string, unknown>) {
  const msg = JSON.stringify({ type: 'preferences', preferences: withRemoteGroups(prefs) });
  for (const ws of frontendClients) {
    try { ws.send(msg); } catch {}
  }
}

/** Broadcast the keybinding override map so every window stays in sync after
 *  the shortcuts editor saves a change. */
function broadcastKeybindings(overrides: Record<string, string | null>) {
  const msg = JSON.stringify({ type: 'keybindings', keybindings: overrides });
  for (const ws of frontendClients) {
    try { ws.send(msg); } catch {}
  }
}

/** Tell every connected frontend to switch its active tab to `sessionId`.
 *  Used when an external trigger (e.g. the `codiby` CLI) creates a session
 *  and wants the user to land on it immediately. */
function broadcastFocusSession(sessionId: string) {
  const msg = JSON.stringify({ type: 'focus_session', sessionId });
  for (const ws of frontendClients) {
    try { ws.send(msg); } catch {}
  }
}

/**
 * Merge-update preferences on disk and broadcast the new state to every
 * connected frontend. Used by MCP tools that mutate tab groups etc.
 */
function updatePreferences(partial: Record<string, unknown>): Record<string, unknown> {
  const prefs = loadPreferences();
  // The frontend can't tell local groups from the remote groups we splice in
  // (withRemoteGroups), so when it persists prefs it echoes the remote ones
  // back. Strip them before saving so the local file never accumulates remote
  // group definitions / mappings — they're re-merged on every broadcast.
  const clean = { ...partial };
  if (clean.tabGroups && typeof clean.tabGroups === 'object') {
    const remoteDefs = getMergedRemoteGroups().tabGroups as Record<string, Record<string, unknown>>;
    const overrides: Record<string, Record<string, unknown>> = {
      ...((prefs.remoteGroupOverrides as Record<string, Record<string, unknown>>) ?? {}),
    };
    const g = { ...(clean.tabGroups as Record<string, unknown>) };
    for (const gid of Object.keys(g)) {
      if (!isRemoteGroupId(gid)) continue;
      // The remote owns the group definition, so it can't be persisted into the
      // local file. But capture the fields the user changed relative to the
      // remote's definition (e.g. color) as a local override so the tweak
      // sticks — matching the remote again clears it.
      const incoming = g[gid] as Record<string, unknown> | undefined;
      const remoteDef = remoteDefs[gid];
      if (incoming && remoteDef) {
        const diff: Record<string, unknown> = {};
        for (const k of Object.keys(incoming)) {
          if (JSON.stringify(incoming[k]) !== JSON.stringify(remoteDef[k])) diff[k] = incoming[k];
        }
        if (Object.keys(diff).length) overrides[gid] = diff;
        else delete overrides[gid];
      }
      delete g[gid];
    }
    clean.tabGroups = g;
    clean.remoteGroupOverrides = overrides;
  }
  if (clean.tabGroupMap && typeof clean.tabGroupMap === 'object') {
    const m = { ...(clean.tabGroupMap as Record<string, unknown>) };
    for (const [sid, gid] of Object.entries(m)) {
      if (typeof gid === 'string' && isRemoteGroupId(gid)) delete m[sid];
    }
    clean.tabGroupMap = m;
  }
  Object.assign(prefs, clean);
  savePreferences(prefs);
  broadcastPreferences(prefs);
  return prefs;
}

/** Auto-assigns a freshly-created session to a tab group whose name matches
 *  the cwd's project folder, mirroring the cycling-color behavior of the
 *  frontend's `handleCreateGroup`. Single source of truth for every
 *  session-creation entry point: HTTP `POST /sessions` (frontend, mobile,
 *  CLI) and MCP `ui_spawn_session`. No-ops if `autoGroupSessions` is off,
 *  if the cwd is empty, or if the session is already in a group (callers
 *  with an explicit group assignment win).
 *
 *  Worktree-aware: when the session is spawned under the standard
 *  `<repo>/.wt/<branch>` layout, the group name is derived from the
 *  parent repo's folder, not the worktree branch. That way a session
 *  spawned in a worktree lands in the same group as the source repo
 *  rather than a freshly-minted "branch" group. Callers that already
 *  routed the original repo cwd through `group_cwd` are unaffected —
 *  by the time we get here the cwd is either the source repo or the
 *  worktree, both of which resolve to the same folder name. */
const AUTOGROUP_COLORS = ['blue', 'green', 'amber', 'violet', 'red', 'pink'];
type AutoGroup = { id: string; name: string; color: string; cwd?: string; icon?: string };
function maybeAutoGroupSession(sessionId: string, cwd: string) {
  if (!cwd) return;
  const prefs = loadPreferences();
  if (!prefs.autoGroupSessions) return;
  const map: Record<string, string> = { ...((prefs.tabGroupMap as Record<string, string>) || {}) };
  if (map[sessionId]) return;
  // Treat `<repo>/.wt/<branch>` as the parent repo for grouping purposes.
  // Match both `/` and `\` separators (Windows-safe), and only when the
  // worktree segment is the *last* path component — anything more nested
  // is a normal subdirectory and stays as-is.
  const wtMatch = cwd.match(/^(.*?)[\\/]\.wt[\\/][^\\/]+$/);
  const groupingCwd = wtMatch ? wtMatch[1]! : cwd;
  const folder = groupingCwd.split('/').filter(Boolean).pop()
    || groupingCwd.split('\\').filter(Boolean).pop()
    || '/';
  const groups: Record<string, AutoGroup> = { ...((prefs.tabGroups as Record<string, AutoGroup>) || {}) };
  let groupId = Object.keys(groups).find(gid => groups[gid]!.name === folder);
  if (!groupId) {
    groupId = randomUUID();
    const color = AUTOGROUP_COLORS[Object.keys(groups).length % AUTOGROUP_COLORS.length]!;
    groups[groupId] = { id: groupId, name: folder, color, cwd: groupingCwd };
  }
  map[sessionId] = groupId;
  updatePreferences({ tabGroups: groups, tabGroupMap: map });
}

/**
 * Send a user message to a session — shared between the frontend WebSocket
 * (`send_message`), the HTTP endpoint (`POST /sessions/:id/messages`), and
 * any MCP tools that drive a session. Auto-starts the provider if the
 * session is idle, echoes the message to the session's chat log, flips the
 * streaming flag, and forwards to the provider.
 */
async function sendMessageToSession(
  sessionId: string,
  text: string,
  images?: { media_type: string; data: string }[],
): Promise<{ ok: boolean; error?: string }> {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: 'Session not found' };

  if (!session.providerSession) {
    log(`[${session.id.slice(0, 8)}] Auto-starting provider on sendMessage (session was stopped/idle)`);
    startProviderSession(session, server.port, session.claudeSessionId ?? null);
    saveSessions();
  }
  if (!session.providerSession) {
    return { ok: false, error: 'Provider failed to start' };
  }
  session.replayDone = true;

  // Echo user message to persistence + frontend
  const userMsg: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    content: text,
    timestamp: Date.now(),
    images,
  };
  if (addMessage(sessionId, userMsg)) {
    broadcastToSession(sessionId, { type: 'message', sessionId, message: userMsg });
  }

  updateSessionState(sessionId, s => ({ ...s, isStreaming: true }));
  broadcastToSession(sessionId, { type: 'status', sessionId, status: 'streaming' });

  try {
    await session.providerSession.sendUserMessage({ text, images });
    return { ok: true };
  } catch (err) {
    log(`[${sessionId.slice(0, 8)}] sendUserMessage failed: ${err}`);
    return { ok: false, error: String(err) };
  }
}

// Provider runtime events are handled by `provider/bridge.ts`. No raw Claude
// CLI messages are parsed here — the SDK runs in-process and emits structured
// events that the bridge translates into state updates + WebSocket broadcasts.

// Wire bridge dependencies (used by provider/lifecycle.ts at spawn time)
setBridgeDeps({
  broadcastToSession,
  broadcastSessionList,
  notifyTelegramIfMainSession,
});

// Let the terminals module push lifecycle events (terminal_created /
// terminal_removed / terminal_data / …) to subscribed frontend clients.
setTerminalBroadcaster(broadcastToSession);

/** Sideloaded plugins from `~/.codiby/plugins/<id>/`. Empty dir ⇒ no-op. */
await pluginHost.loadPlugins({
  broadcastToAllFrontends(msg) {
    const data = JSON.stringify(msg);
    for (const ws of frontendClients) {
      try { ws.send(data); } catch {}
    }
  },
});

// ---------------------------------------------------------------------------
// Frontend WS message handler
// ---------------------------------------------------------------------------

async function handleFrontendMessage(ws: any, rawMessage: string | ArrayBuffer) {
  const text = typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage as ArrayBuffer);
  let msg: any;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }

  const { type } = msg as { type: string };

  // ---- get_sessions --------------------------------------------------------
  if (type === 'get_sessions') {
    ws.send(JSON.stringify({ type: 'sessions', sessions: buildFullSessionList() }));
    return;
  }

  // ---- get_session_state ---------------------------------------------------
  if (type === 'get_session_state') {
    const { sessionId } = msg as { sessionId: string };
    if (!sessionId) return;
    const state = getStateForClient(sessionId);
    ws.send(JSON.stringify({ type: 'session_state', sessionId, state }));
    return;
  }

  // ---- subscribe -----------------------------------------------------------
  if (type === 'subscribe') {
    const { sessionId } = msg as { sessionId: string };
    if (!sessionId) return;
    let subs = subscriptions.get(ws);
    if (!subs) { subs = new Set(); subscriptions.set(ws, subs); }
    subs.add(sessionId);

    // Immediately send full session state
    const state = getStateForClient(sessionId);
    ws.send(JSON.stringify({ type: 'session_state', sessionId, state }));

    // Also send current connection status
    const session = sessions.get(sessionId);
    if (session) {
      const status = session.ready ? 'connected' : session.runtimeStatus === 'starting' ? 'starting' : 'disconnected';
      ws.send(JSON.stringify({ type: 'status', sessionId, status }));
    }
    return;
  }

  // ---- unsubscribe ---------------------------------------------------------
  if (type === 'unsubscribe') {
    const { sessionId } = msg as { sessionId: string };
    if (!sessionId) return;
    subscriptions.get(ws)?.delete(sessionId);
    return;
  }

  // ---- active_tab_change ---------------------------------------------------
  // Frontend tells us which tab is in focus. Boots the session's provider on
  // demand so we don't resume 20 Claude processes at once when the app first
  // connects — the persisted list is shown immediately, but each provider is
  // only spawned (and a `claude --resume` is only issued) when the user
  // actually opens that tab. Already-running providers are a no-op.
  if (type === 'active_tab_change') {
    const { sessionId } = msg as { sessionId: string };
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    if (session.providerSession) return;
    log(`[lazy] Active tab → spawning ${sessionId.slice(0, 8)} (${session.name})`);
    try {
      startProviderSession(session, server.port, session.claudeSessionId ?? null);
      saveSessions();
    } catch (err) {
      log(`[lazy] Failed to spawn ${sessionId.slice(0, 8)}: ${err}`);
    }
    return;
  }

  // ---- send_message --------------------------------------------------------
  if (type === 'send_message') {
    const { sessionId, text: msgText, images } = msg as { sessionId: string; text: string; images?: { media_type: string; data: string }[] };
    if (!sessionId || !msgText) return;

    const session = sessions.get(sessionId);
    if (!session) return;
    // Auto-start the provider if the session is idle (e.g. after a stop, SDK
    // exit, or pre-resume race). Messages would otherwise be silently dropped.
    if (!session.providerSession) {
      log(`[${session.id.slice(0, 8)}] Auto-starting provider on send_message (session was stopped/idle)`);
      startProviderSession(session, server.port, session.claudeSessionId ?? null);
      saveSessions();
    }
    if (!session.providerSession) {
      log(`[${session.id.slice(0, 8)}] Auto-start failed — dropping message`);
      return;
    }
    session.replayDone = true;

    // Echo user message to persistence + frontend
    const userMsg: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: msgText,
      timestamp: Date.now(),
      images,
    };
    if (addMessage(sessionId, userMsg)) {
      broadcastToSession(sessionId, { type: 'message', sessionId, message: userMsg });
    }

    // Intercept /model command — switch model via provider session.
    const modelMatch = msgText.match(/^\/model(?:\s+(.+))?$/);
    if (modelMatch) {
      const finishIntercept = (confirmText: string) => {
        const reply: ChatMessage = {
          id: randomUUID(),
          role: 'system',
          content: confirmText,
          timestamp: Date.now(),
        };
        if (addMessage(sessionId, reply)) {
          broadcastToSession(sessionId, { type: 'message', sessionId, message: reply });
        }
        updateSessionState(sessionId, s => ({ ...s, isStreaming: false, partialText: '' }));
        broadcastToSession(sessionId, { type: 'status', sessionId, status: 'turn_complete' });
      };

      const arg = (modelMatch[1] || '').trim();
      if (!arg) {
        const current = session.model || 'default';
        finishIntercept(`Current model: ${current}\nUsage: /model <opus|sonnet|haiku|claude-opus-4-7|default>`);
        return;
      }
      const newModel = arg.toLowerCase() === 'default' ? null : arg;
      session.model = newModel;
      saveSessions();
      broadcastSessionList();

      let confirmText = `Model preference saved: ${newModel ?? 'default'}`;
      try {
        await session.providerSession!.setModel(newModel);
        confirmText = `Model set to: ${newModel ?? 'default'}`;
      } catch (err) {
        confirmText = `Failed to switch model: ${err}`;
      }
      finishIntercept(confirmText);
      return;
    }

    // Mark the session as streaming immediately so connected clients can show
    // a "thinking" indicator while we wait for Claude's first token (which can
    // take a few seconds). The provider's onAssistantDelta will keep
    // isStreaming=true and add partialText; onTurnComplete clears it. Also
    // clear `wasInterrupted` — the user is starting a new turn so the "last
    // turn died" red dot should disappear right when they hit send.
    updateSessionState(sessionId, s => ({ ...s, isStreaming: true, wasInterrupted: false }));
    broadcastToSession(sessionId, { type: 'status', sessionId, status: 'streaming' });

    try {
      await session.providerSession!.sendUserMessage({ text: msgText, images });
    } catch (err) {
      log(`[${sessionId.slice(0, 8)}] sendUserMessage failed: ${err}`);
    }
    return;
  }

  // ---- permission_response -------------------------------------------------
  if (type === 'permission_response') {
    const { sessionId, requestId, allow, updatedInput } = msg as {
      sessionId: string;
      requestId: string;
      allow: boolean;
      updatedInput?: Record<string, unknown>;
    };
    if (!sessionId || !requestId) return;
    const session = sessions.get(sessionId);
    if (!session) return;

    resolvePermissionDecision(
      requestId,
      allow
        ? { allow: true, updatedInput: updatedInput || {} }
        : { allow: false, interrupt: true },
    );

    // When user denies a tool, also interrupt so the model stops retrying.
    if (!allow && session.providerSession) {
      try { await session.providerSession.interrupt(); } catch {}
    }

    // AskUserQuestion doesn't produce a normal tool_result from the SDK — the
    // answer lives only in the permission updatedInput. Persist it as a
    // synthetic tool_result so reloads can show which option was selected.
    // Works for both live (permRequest still set) and stale (permission lost
    // but tool_use still in history) cases.
    if (
      allow &&
      updatedInput &&
      updatedInput.answers &&
      typeof updatedInput.answers === 'object'
    ) {
      const state = getSessionState(sessionId);
      const isAsk =
        state.permRequest?.toolName === 'AskUserQuestion' ||
        state.messages.some(m => m.id === requestId && m.toolName === 'AskUserQuestion');
      if (isAsk) {
        const already = state.messages.some(m => m.isToolResult && m.toolUseId === requestId);
        if (!already) {
          const resultMsg: ChatMessage = {
            id: randomUUID(),
            role: 'assistant',
            content: JSON.stringify({ answers: updatedInput.answers }),
            timestamp: Date.now(),
            isToolResult: true,
            toolUseId: requestId,
          };
          if (addMessage(sessionId, resultMsg)) {
            broadcastToSession(sessionId, { type: 'message', sessionId, message: resultMsg });
          }
        }
      }
    }

    // Handle ExitPlanMode approval — transition out of plan mode
    if (allow) {
      const state = getSessionState(sessionId);
      if (state.permRequest?.toolName === 'ExitPlanMode' && session.permissionMode === 'plan') {
        session.permissionMode = 'acceptEdits';
        saveSessions();
        broadcastSessionList();
        if (session.providerSession) {
          try { await session.providerSession.setPermissionMode('acceptEdits'); } catch {}
        }
        log(`[${session.id.slice(0, 8)}] ExitPlanMode approved — switched to acceptEdits`);
      }
    }

    // Clear permission request from state and notify ALL subscribed clients
    // (including the one that responded — its own UI may have already cleared
    // optimistically; for any other connected client this is the only signal).
    updateSessionState(sessionId, s => ({ ...s, permRequest: null }));
    broadcastToSession(sessionId, { type: 'permission_cancelled', sessionId, requestId });

    // Update the original Telegram alert (if any) in place so the message
    // becomes "✅ Approved" / "❌ Denied" instead of staying as a stale
    // "🔔 Permission needed" record.
    notifyPermissionResolved(requestId, { allow });
    return;
  }

  // ---- browser_response (from desktop frontend) ----------------------------
  // Reply to a `browser_request` issued by an SDK browser_* tool. The CDP
  // round-trip is bridge → frontend → Electron main → CDP; this is the
  // last hop back. Non-desktop viewers never send these — `cdpRequest`
  // times out and the tool reports failure.
  if (type === 'browser_response') {
    handleBrowserResponse(msg as { requestId?: string; result?: unknown; error?: string });
    return;
  }

  // ---- interrupt -----------------------------------------------------------
  if (type === 'interrupt') {
    const { sessionId } = msg as { sessionId: string };
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    // Stop is also the user's escape hatch when `isStreaming` is wedged with
    // no live provider (SDK crashed silently, runtime hung past onExit, etc.).
    // Always force-clear server state below; only call provider.interrupt()
    // when the runtime is actually around.
    if (session.providerSession) {
      try { await session.providerSession.interrupt(); } catch (err) {
        log(`[${sessionId.slice(0, 8)}] interrupt failed: ${err}`);
      }
    }
    // Authoritatively flip the session out of "streaming" and notify viewers.
    // Without this the SDK can keep emitting in-flight tool events for a beat
    // after interrupt(), each of which re-arms `isStreaming` in the bridge —
    // leaving the Stop button visible but ineffective. The bridge guards on
    // `wasInterrupted` (set here) so those late events stop re-arming.
    updateSessionState(sessionId, s => ({ ...s, isStreaming: false, partialText: '', wasInterrupted: true }));
    // Pair every in-flight tool_use with a synthetic error result so the
    // per-tool "running" dot clears in the UI. Without this, an interrupted
    // Bash (etc.) shows an amber pulse forever — `anyRunning` keys off
    // unmatched tool_use messages.
    const synthetic = healOrphanedToolUses(sessionId, 'Interrupted by user.');
    for (const msg of synthetic) {
      broadcastToSession(sessionId, { type: 'message', sessionId, message: msg });
    }
    broadcastToSession(sessionId, { type: 'status', sessionId, status: 'interrupted' });
    return;
  }

  // ---- terminal_attach -----------------------------------------------------
  // Re-attach a viewer to a live PTY (tab switch / bubble remount / reload).
  // Terminals are CREATED over REST (`POST /session/:id/terminals`), so this
  // never spawns — it only replays the authoritative buffer + resizes.
  if (type === 'terminal_attach') {
    const { sessionId, procId, cols, rows } = msg as { sessionId: string; procId: string; cols?: number; rows?: number };
    if (!sessionId || !procId) return;
    const attached = attachTerminal(sessionId, procId, Number(cols) || 120, Number(rows) || 30);
    if (!attached) {
      // The PTY is gone (exited / GC'd). Tell the viewer to render as exited
      // so it stops waiting for a replay that will never come.
      broadcastToSession(sessionId, { type: 'terminal_exit', sessionId, procId, code: -1 });
    }
    return;
  }

  // ---- terminal_input ------------------------------------------------------
  // Write raw keystrokes (already encoded by xterm) to an interactive PTY.
  if (type === 'terminal_input') {
    const { procId, data } = msg as { procId: string; data: string };
    if (!procId || typeof data !== 'string') return;
    const tp = trackedProcesses.get(procId);
    if (!tp || tp.kind !== 'pty' || tp.exitCode !== null) return;
    tp.pty?.write(data);
    return;
  }

  // ---- terminal_resize -----------------------------------------------------
  if (type === 'terminal_resize') {
    const { procId, cols, rows } = msg as { procId: string; cols: number; rows: number };
    if (!procId || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
    const tp = trackedProcesses.get(procId);
    if (!tp || tp.kind !== 'pty' || tp.exitCode !== null) return;
    tp.cols = cols; tp.rows = rows;
    tp.pty?.resize(cols, rows);
    return;
  }

  // Terminal lifecycle (create / kill) is handled over REST — see the
  // `/session/:id/terminals` CRUD routes below. The WS carries live I/O only.

  // ---- update_ui_state -----------------------------------------------------
  if (type === 'update_ui_state') {
    const { sessionId, state } = msg as { sessionId: string; state: Record<string, unknown> };
    if (!sessionId || !state) return;
    updateUIState(sessionId, state);
    return;
  }

  // ---- set_model -----------------------------------------------------------
  if (type === 'set_model') {
    const { sessionId, model } = msg as { sessionId: string; model: string };
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    session.model = model || null;
    saveSessions();
    if (session.providerSession) {
      try { await session.providerSession.setModel(session.model); } catch {}
    }
    // Notify all subscribed clients
    broadcastToSession(sessionId, {
      type: 'session_state',
      sessionId,
      state: getStateForClient(sessionId),
    });
    return;
  }

  // ---- set_permission_mode -------------------------------------------------
  if (type === 'set_permission_mode') {
    const { sessionId, mode } = msg as { sessionId: string; mode: string };
    if (!sessionId || !mode) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    session.permissionMode = mode;
    saveSessions();
    if (session.providerSession) {
      try { await session.providerSession.setPermissionMode(mode as any); } catch {}
    }
    broadcastSessionList();
    return;
  }
}

// ---------------------------------------------------------------------------
// Mobile auth + static asset serving
// ---------------------------------------------------------------------------

// Don't cache the token in a module-level constant — it can be rotated via
// POST /mobile/pair/regenerate, and a captured copy would keep accepting the
// old value until process restart. `loadOrCreateMobileToken()` reads the
// in-memory cache that `regenerateMobileToken()` invalidates.
loadOrCreateMobileToken();

/**
 * Treat the request as "trusted" if it comes from localhost. The Electron
 * desktop app always uses localhost, so this preserves zero-config desktop
 * usage while requiring the bearer token from any LAN client.
 */
function isLocalhostRequest(req: Request): boolean {
  const host = req.headers.get('host') || '';
  // Strip port; accept both IPv4/IPv6 loopback
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/** Routes that must remain reachable without the bearer token. */
function isPublicRoute(pathname: string): boolean {
  if (pathname === '/health') return true;
  if (pathname === '/manifest.webmanifest') return true;
  if (pathname === '/favicon.ico' || pathname === '/favicon.svg') return true;
  if (pathname.startsWith('/brand/')) return true;
  // Desktop UI — served by the same bridge that owns the API + WS.
  // Auth (when required) happens client-side; LAN / Funnel browsers bring
  // the bearer token into `/sessions` / `/ws/*` calls.
  if (pathname === '/' || pathname === '/index.html') return true;
  // The mobile page itself is public — auth happens client-side via the token
  // in localStorage / URL fragment before WebSocket / HTTP calls are made.
  if (pathname === '/m' || pathname === '/m/' || pathname === '/m/index.html') return true;
  // PWA service worker — must be reachable without auth so the browser can
  // register it on every page load.
  if (pathname === '/sw.js') return true;
  // Hashed asset chunks produced by `bun build` (was `/_astro/` under Astro).
  if (pathname.startsWith('/assets/')) return true;
  // Shared React runtime bundles referenced by the importmap. Loaded by
  // <script> tags from /m and /, which can't carry the bearer token.
  if (pathname.startsWith('/runtime/')) return true;
  return false;
}

function authCheck(req: Request, url: URL): boolean {
  if (isLocalhostRequest(req)) return true;
  if (isPublicRoute(url.pathname)) return true;
  // Read the current token live so rotation takes effect without a restart.
  const token = loadOrCreateMobileToken();
  // Token sources, in priority order:
  //   1. Authorization: Bearer <token>
  //   2. ?t=<token> query string
  //   3. Sec-WebSocket-Protocol: <token>   (the only header browsers allow on WS upgrade)
  const auth = req.headers.get('authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1].trim() === token) return true;
  }
  const qt = url.searchParams.get('t');
  if (qt && qt === token) return true;
  const wsProto = req.headers.get('sec-websocket-protocol');
  if (wsProto && wsProto.split(',').map(s => s.trim()).includes(token)) return true;
  return false;
}

// Serve built static files (desktop + mobile UI) from `dist/`. Produced by
// `bun build` via `scripts/build.ts`. We probe a few common locations so
// this works from source (`bun run server/index.ts`), from a bundled
// `server.js` next to `dist/`, and from the Docker image layout.
const DIST_CANDIDATES = (() => {
  const candidates: string[] = [];
  try {
    const scriptDir = dirname(process.argv[1] || '');
    if (scriptDir) {
      candidates.push(join(scriptDir, 'dist'));        // bundled alongside server.js
      candidates.push(join(scriptDir, '..', 'dist'));  // server in /server, dist in /
    }
  } catch {}
  // Source tree
  try {
    const here = dirname(new URL(import.meta.url).pathname);
    candidates.push(join(here, '..', 'dist'));
  } catch {}
  candidates.push(join(process.cwd(), 'dist'));
  return candidates;
})();

function findDist(): string | null {
  for (const p of DIST_CANDIDATES) {
    try { if (existsSync(p)) return p; } catch {}
  }
  return null;
}

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.map':   'application/json',
};

async function serveStaticFromDist(pathname: string): Promise<Response | null> {
  const dist = findDist();
  if (!dist) return null;
  // Map URL → file
  let rel: string;
  if (pathname === '/' || pathname === '/index.html') rel = 'index.html';
  else if (pathname === '/m' || pathname === '/m/' || pathname === '/m/index.html') rel = 'm/index.html';
  else rel = pathname.replace(/^\//, '');
  const filePath = join(dist, rel);
  // Prevent directory traversal
  if (!filePath.startsWith(dist)) return null;
  try {
    if (!existsSync(filePath)) return null;
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    const mime = STATIC_MIME[ext] || 'application/octet-stream';
    const file = Bun.file(filePath);
    return new Response(file, {
      headers: {
        'Content-Type': mime,
        'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        ...corsHeaders,
      },
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

// Auto-enable HTTPS when cert + key are present under ~/.codiby/tls/
const TLS = resolveTls();

// ===========================================================================
// HTTP routing (Hono).
//
// Cross-cutting concerns — CORS preflight, mobile bearer auth, the `?remoteId`
// remote proxy, sideloaded plugins, static UI assets, the localhost-only mobile
// pair endpoints, request logging, and every WebSocket upgrade — stay in the
// Bun.serve `fetch` handler below (they need the raw `server` and/or must run
// in a specific order). Everything else is dispatched here.
//
// Handlers receive the raw Request via `c.req.raw`, so the original logic
// (`req.json()`, `url.searchParams`, `proxyHttpToRemote(req, …)`) is preserved
// verbatim; path params that used regex capture groups now use `c.req.param()`.
// All handlers close over module state (`server`, `sessions`, broadcasters, …);
// `server` is assigned just below and only dereferenced at request time.
// ===========================================================================
const app = new Hono();

// ── Sessions ───────────────────────────────────────────────────────────────
app.get('/sessions', () => {
  return Response.json(buildFullSessionList(), { headers: corsHeaders });
});

app.post('/sessions', async (c) => {
  const req = c.req.raw;
  const url = new URL(req.url);
  // Remote sessions are created by the renderer DIRECTLY on the remote bridge
  // (through its tunnel), so this endpoint is local-only now.
  const resp = await handleCreateSession(req, server.port);
  // Apply the `autoGroupSessions` preference server-side so every entry
  // point (frontend, mobile, CLI) honors it without each client needing
  // its own copy of the logic.
  let createdId: string | null = null;
  if (resp.ok) {
    try {
      const created = await resp.clone().json() as { id?: string; cwd?: string; group_cwd?: string };
      if (created?.id) {
        createdId = created.id;
        const groupingCwd = created.group_cwd || created.cwd;
        if (groupingCwd) maybeAutoGroupSession(created.id, groupingCwd);
      }
    } catch {}
  }
  broadcastSessionList();
  if (url.searchParams.get('focus') === '1' && createdId) {
    broadcastFocusSession(createdId);
  }
  return resp;
});

app.post('/sessions/:id/resume', (c) => {
  const sid = c.req.param('id');
  const resp = handleResumeSession(sid, server.port);
  broadcastSessionList();
  return resp;
});

app.get('/providers/opencode/info', async () => {
  const info = await getOpencodeInfo();
  return Response.json(info, { headers: corsHeaders });
});

app.get('/providers/claude/info', () => {
  return Response.json(getClaudeInfo(), { headers: corsHeaders });
});

app.post('/sessions/:id/stop', (c) => {
  const sid = c.req.param('id');
  const resp = handleStopSession(sid);
  broadcastSessionList();
  return resp;
});

app.post('/sessions/:id/restart', async (c) => {
  const sid = c.req.param('id');
  const resp = await handleRestartSession(sid, server.port);
  broadcastSessionList();
  return resp;
});

app.post('/sessions/:id/clear', async (c) => {
  const sid = c.req.param('id');
  const resp = await handleClearSession(sid);
  // Tell every connected UI to drop its in-memory chat for this session
  // before pushing the updated session list.
  const clearedMsg = JSON.stringify({ type: 'session_cleared', sessionId: sid });
  for (const ws of frontendClients) { try { ws.send(clearedMsg); } catch {} }
  broadcastSessionList();
  return resp;
});

app.patch('/sessions/:id', async (c) => {
  const req = c.req.raw;
  const sid = c.req.param('id');
  const resp = await handleRenameSession(sid, req);
  broadcastSessionList();
  return resp;
});

// Per-session port forwards moved to the Electron main process (it owns the
// SSH ControlMaster). The renderer drives them via IPC — no bun route.

// ── Terminals (CRUD) ─────────────────────────────────────────────────────────
// Single source of truth for terminal lifecycle, shared by the UI and the MCP
// tools. Live I/O stays on the /ws multiplexer (terminal_input / terminal_data).

// List every terminal for a session. The UI fetches this as soon as it
// subscribes so open terminals repopulate the dock on (re)connect.
app.get('/session/:id/terminals', (c) => {
  return Response.json({ terminals: listTerminals(c.req.param('id')) }, { headers: corsHeaders });
});

// Create a terminal. Spawns the PTY, then broadcasts `terminal_created` — the
// UI adds the tab only when that broadcast arrives (never optimistically).
app.post('/session/:id/terminals', async (c) => {
  const sessionId = c.req.param('id');
  let body: { command?: string; cwd?: string; cols?: number; rows?: number; label?: string; terminalName?: string } = {};
  try { body = await c.req.raw.json() as typeof body; } catch {}

  const session = sessions.get(sessionId);
  const cwd = body.cwd || session?.cwd || process.env.HOME || '/';

  // Cross-action env injection so a manually-run `npm run dev` sees the same
  // API_URL / WEB_URL an action-spawned shell gets. Worktree detection uses
  // the shell's own cwd so injected URLs match the active branch.
  const prefs = loadPreferences();
  const group = resolveGroupForSession(prefs, sessionId);
  const injectedEnv = buildInjectedActionEnv(group, getGlobalTld(prefs), undefined, cwd);

  const result = createTerminal({
    sessionId,
    cwd,
    cols: body.cols,
    rows: body.rows,
    command: body.command,
    terminalName: body.terminalName,
    injectedEnv,
  });
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 500, headers: corsHeaders });
  }
  return Response.json({ terminal: result.info }, { headers: corsHeaders });
});

// Read one terminal. `?output=1` also returns the buffered scrollback.
app.get('/session/:id/terminals/:procId', (c) => {
  const sessionId = c.req.param('id');
  const procId = c.req.param('procId');
  const info = getTerminal(sessionId, procId);
  if (!info) return Response.json({ error: 'not found' }, { status: 404, headers: corsHeaders });
  const wantOutput = new URL(c.req.url).searchParams.get('output') === '1';
  const output = wantOutput ? getTerminalOutput(sessionId, procId) : undefined;
  return Response.json({ terminal: info, output }, { headers: corsHeaders });
});

// Delete (kill) a terminal. Close === kill; broadcasts `terminal_removed`.
app.delete('/session/:id/terminals/:procId', (c) => {
  const removed = removeTerminal(c.req.param('id'), c.req.param('procId'));
  if (!removed) return Response.json({ error: 'not found' }, { status: 404, headers: corsHeaders });
  return Response.json({ ok: true }, { headers: corsHeaders });
});

// POST /sessions/:id/messages — HTTP path a remote bridge serves when the
// renderer sends a message to a remote session directly through its tunnel.
app.post('/sessions/:id/messages', async (c) => {
  const req = c.req.raw;
  const sid = c.req.param('id');
  let body: { text?: string; images?: { media_type: string; data: string }[] } = {};
  try { body = await req.json() as typeof body; } catch {}
  if (!body.text) return Response.json({ error: 'text required' }, { status: 400, headers: corsHeaders });
  const result = await sendMessageToSession(sid, body.text, body.images);
  return Response.json(result, { headers: corsHeaders });
});

app.delete('/sessions/:id', async (c) => {
  const req = c.req.raw;
  const url = new URL(req.url);
  const sid = c.req.param('id');
  // ?purge=1 → also delete the on-disk chat history + UI state.
  // ?worktree=1 → also remove the git worktree (when cwd looks like one).
  const purge = url.searchParams.get('purge') === '1';
  const removeWorktree = url.searchParams.get('worktree') === '1';
  const resp = handleDeleteSession(sid, purge, removeWorktree);
  broadcastSessionList();
  return resp;
});

app.post('/save-commands', async (c) => {
  const body = await c.req.raw.json() as { sessionId: string; commands: string[] };
  if (!body.sessionId) return Response.json({ error: 'sessionId required' }, { status: 400, headers: corsHeaders });
  const session = sessions.get(body.sessionId);
  if (!session) return Response.json({ error: 'not found' }, { status: 404, headers: corsHeaders });
  session.savedCommands = body.commands || [];
  saveSessions();
  return Response.json({ ok: true }, { headers: corsHeaders });
});

// ── Remotes ────────────────────────────────────────────────────────────────
app.get('/remotes', () => handleListRemotes());
app.post('/remotes', async (c) => {
  const resp = await handleAddRemote(c.req.raw);
  broadcastRemoteList();
  return resp;
});
app.patch('/remotes/:id', async (c) => {
  const resp = await handleUpdateRemote(c.req.param('id'), c.req.raw);
  broadcastRemoteList();
  return resp;
});
app.delete('/remotes/:id', async (c) => {
  const resp = await handleRemoveRemote(c.req.param('id'));
  broadcastRemoteList();
  broadcastSessionList();
  return resp;
});
app.post('/remotes/:id/test', (c) => handleTestRemote(c.req.param('id')));

// ── Files ──────────────────────────────────────────────────────────────────
app.get('/ls', (c) => {
  const prefix = new URL(c.req.url).searchParams.get('prefix') || '/';
  return handleListDirs(prefix);
});
app.get('/user-home', () => {
  return Response.json({ home: homedir() }, { headers: corsHeaders });
});
app.get('/files', (c) => {
  const dirPath = new URL(c.req.url).searchParams.get('path') || '/';
  return handleListFiles(dirPath);
});
app.get('/file-index', (c) => {
  const root = new URL(c.req.url).searchParams.get('root');
  if (!root) return Response.json({ error: 'root required' }, { status: 400, headers: corsHeaders });
  return handleFileIndex(root);
});
// Reading a huge file into a JS string (and later JSON.stringify-ing the
// response) can blow past Blink's partition allocator and SIGTRAP-crash the
// renderer — this isn't a V8 heap OOM (it stays small), it's a native abort.
// Cap it here so a growing log/output file an editor tab is watching can't
// take the whole window down.
const FILE_CONTENT_MAX_BYTES = 10 * 1024 * 1024;
const FILE_RAW_MAX_BYTES = 50 * 1024 * 1024;

app.get('/file-content', (c) => {
  const filePath = new URL(c.req.url).searchParams.get('path');
  if (!filePath) return Response.json({ error: 'path required' }, { status: 400, headers: corsHeaders });
  try {
    const { size } = statSync(filePath);
    if (size > FILE_CONTENT_MAX_BYTES) {
      return Response.json(
        { error: `File too large to open (${(size / 1048576).toFixed(1)}MB > ${FILE_CONTENT_MAX_BYTES / 1048576}MB limit)`, size, tooLarge: true },
        { status: 413, headers: corsHeaders },
      );
    }
    const content = readFileSync(filePath, 'utf-8');
    return Response.json({ path: filePath, content }, { headers: corsHeaders });
  } catch {
    return Response.json({ error: 'Cannot read file' }, { status: 404, headers: corsHeaders });
  }
});
// Serve a file's raw bytes with a best-effort content-type. Used by the image
// preview tab, which needs binary (png/jpg/gif/…) that `/file-content` would
// corrupt by decoding as utf-8.
const RAW_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon', '.avif': 'image/avif', '.svg': 'image/svg+xml',
};
app.get('/file-raw', (c) => {
  const filePath = new URL(c.req.url).searchParams.get('path');
  if (!filePath) return Response.json({ error: 'path required' }, { status: 400, headers: corsHeaders });
  try {
    const { size } = statSync(filePath);
    if (size > FILE_RAW_MAX_BYTES) {
      return Response.json(
        { error: `File too large to open (${(size / 1048576).toFixed(1)}MB > ${FILE_RAW_MAX_BYTES / 1048576}MB limit)`, size, tooLarge: true },
        { status: 413, headers: corsHeaders },
      );
    }
    const bytes = readFileSync(filePath);
    const mime = RAW_MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    return new Response(bytes, { headers: { ...corsHeaders, 'content-type': mime } });
  } catch {
    return Response.json({ error: 'Cannot read file' }, { status: 404, headers: corsHeaders });
  }
});
app.put('/file-content', async (c) => {
  try {
    const body = await c.req.raw.json() as { path: string; content: string };
    if (!body.path) return Response.json({ error: 'path required' }, { status: 400, headers: corsHeaders });
    writeFileSync(body.path, body.content, 'utf-8');
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
  }
});
// Write a file's raw bytes — the binary counterpart to `PUT /file-content`.
// Used by the file-explorer "Upload" action; on remote sessions the request is
// proxied over the SSH tunnel by the `?remoteId=` catchall, so the bytes land
// on the remote filesystem.
app.put('/file-raw', async (c) => {
  const filePath = new URL(c.req.url).searchParams.get('path');
  if (!filePath) return Response.json({ error: 'path required' }, { status: 400, headers: corsHeaders });
  try {
    const bytes = Buffer.from(await c.req.raw.arrayBuffer());
    writeFileSync(filePath, bytes);
    return Response.json({ ok: true, path: filePath }, { headers: corsHeaders });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
  }
});
app.delete('/file-content', (c) => {
  const filePath = new URL(c.req.url).searchParams.get('path');
  if (!filePath) return Response.json({ error: 'path required' }, { status: 400, headers: corsHeaders });
  return handleDeletePath(filePath);
});
// Persist a pasted code snippet under ~/.codiby/<sessionId>/<uuid><ext>. The
// composer calls this when a paste is too large to inline; the returned path
// is referenced from the chat message as a clickable badge.
app.post('/snippet', async (c) => {
  try {
    const body = await c.req.raw.json() as { sessionId: string; content: string; ext?: string };
    if (!body.sessionId || body.content == null) {
      return Response.json({ error: 'sessionId and content required' }, { status: 400, headers: corsHeaders });
    }
    // Sanitize the extension to a short alnum token so we never build a weird path.
    const ext = (body.ext || '').replace(/[^a-z0-9]/gi, '').slice(0, 12);
    const uuid = randomUUID();
    const name = ext ? `${uuid}.${ext}` : uuid;
    const dir = join(CODIBY_DIR, body.sessionId);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, name);
    writeFileSync(filePath, body.content, 'utf-8');
    return Response.json({ path: filePath, name, uuid }, { headers: corsHeaders });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
  }
});
app.post('/file-rename', async (c) => {
  try {
    const body = await c.req.raw.json() as { from: string; to: string };
    if (!body.from || !body.to) return Response.json({ error: 'from and to required' }, { status: 400, headers: corsHeaders });
    return handleRenamePath(body.from, body.to);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
  }
});
app.post('/file-new', async (c) => {
  try {
    const body = await c.req.raw.json() as { path: string; kind: 'file' | 'dir' };
    if (!body.path || !body.kind) return Response.json({ error: 'path and kind required' }, { status: 400, headers: corsHeaders });
    return body.kind === 'dir' ? handleCreateDir(body.path) : handleCreateFile(body.path);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
  }
});
app.post('/file-reveal', async (c) => {
  try {
    const body = await c.req.raw.json() as { path: string };
    if (!body.path) return Response.json({ error: 'path required' }, { status: 400, headers: corsHeaders });
    return handleRevealInFinder(body.path);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
  }
});

// ── Git ──────────────────────────────────────────────────────────────────────
app.get('/file-original', async (c) => {
  const url = new URL(c.req.url);
  const filePath = url.searchParams.get('path');
  if (!filePath) return Response.json({ error: 'path required' }, { status: 400, headers: corsHeaders });
  // When `base` is given, diff against the merge-base of that branch and HEAD;
  // otherwise against the working tree's HEAD.
  const base = url.searchParams.get('base');
  try {
    const cwd = dirname(filePath);
    const relPath = (await runShell(`git ls-files --full-name "${filePath}"`, cwd)).trim();
    if (!relPath) return Response.json({ path: filePath, content: '' }, { headers: corsHeaders });
    let ref = 'HEAD';
    if (base) ref = (await baseDiffRef(cwd, base)) || 'HEAD';
    const content = await runShell(`git show ${JSON.stringify(ref)}:"${relPath}"`, cwd);
    return Response.json({ path: filePath, content }, { headers: corsHeaders });
  } catch {
    return Response.json({ path: filePath, content: '' }, { headers: corsHeaders });
  }
});
app.get('/git-modified', async (c) => {
  const url = new URL(c.req.url);
  const root = url.searchParams.get('root');
  if (!root) return Response.json({ error: 'root required' }, { status: 400, headers: corsHeaders });
  return await handleGitModified(root, url.searchParams.get('base'));
});
app.post('/git-stage', async (c) => {
  const body = await c.req.raw.json() as { root: string; files: string[]; unstage?: boolean };
  if (!body.root || !body.files?.length) return Response.json({ error: 'root and files required' }, { status: 400, headers: corsHeaders });
  try {
    const gitTop = (await runShell('git rev-parse --show-toplevel', body.root)).trim();
    const cmd = body.unstage ? 'git reset HEAD --' : 'git add --';
    await runShell(
      `${cmd} ${body.files.map(f => `'${f.replace(/'/g, "'\\''")}'`).join(' ')}`,
      gitTop,
    );
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
  }
});
app.get('/git-info', async (c) => {
  const dirPath = new URL(c.req.url).searchParams.get('path');
  if (!dirPath) return Response.json({ error: 'path required' }, { status: 400, headers: corsHeaders });
  return await handleGitInfo(dirPath);
});
app.get('/git-branches', async (c) => {
  const cwd = new URL(c.req.url).searchParams.get('cwd');
  if (!cwd) return Response.json({ error: 'cwd required' }, { status: 400, headers: corsHeaders });
  return await handleGitBranches(cwd);
});
app.post('/git-checkout', async (c) => {
  const body = await c.req.raw.json() as { cwd: string; branch: string };
  if (!body.cwd || !body.branch) return Response.json({ error: 'cwd and branch required' }, { status: 400, headers: corsHeaders });
  return await handleGitCheckout(body.cwd, body.branch);
});
app.get('/gh-prs', async (c) => {
  const url = new URL(c.req.url);
  const cwd = url.searchParams.get('cwd');
  const sessionName = url.searchParams.get('session') || '';
  if (!cwd) return Response.json({ error: 'cwd required' }, { status: 400, headers: corsHeaders });
  return await handleGhPrs(cwd, sessionName);
});
app.get('/pr-detail', async (c) => {
  const url = new URL(c.req.url);
  const prNumber = url.searchParams.get('number');
  const cwd = url.searchParams.get('cwd') || CWD;
  if (!prNumber) return Response.json({ error: 'missing number' }, { status: 400, headers: corsHeaders });
  try {
    const prJson = await runShell(
      `gh pr view ${prNumber} --json number,title,body,headRefName,baseRefName,state,url,isDraft,additions,deletions,changedFiles,commits,reviews,comments,labels,author,createdAt,updatedAt,mergedAt,mergeable`,
      cwd,
      15000,
    );
    return Response.json(JSON.parse(prJson), { headers: corsHeaders });
  } catch (e: any) {
    return Response.json({ error: e.message || String(e) }, { status: 502, headers: corsHeaders });
  }
});

// ── PR Links ─────────────────────────────────────────────────────────────────
app.get('/pr-links', () => Response.json(loadPRLinks(), { headers: corsHeaders }));
app.get('/pr-link/:sessionId', (c) => {
  const link = getPRLink(c.req.param('sessionId'));
  return Response.json({ link }, { headers: corsHeaders });
});
app.put('/pr-link/:sessionId', async (c) => {
  const body = await c.req.raw.json() as { prNumber: number; title: string; url: string; headRefName: string; state: string };
  savePRLink(c.req.param('sessionId'), body);
  return Response.json({ ok: true }, { headers: corsHeaders });
});
app.delete('/pr-link/:sessionId', (c) => {
  removePRLink(c.req.param('sessionId'));
  return Response.json({ ok: true }, { headers: corsHeaders });
});

// ── MCP servers (config CRUD) ────────────────────────────────────────────────
app.get('/mcp-servers', (c) => handleListMcpServers(new URL(c.req.url).searchParams.get('cwd')));
app.post('/mcp-servers', (c) => handleAddMcpServer(c.req.raw));
app.delete('/mcp-servers/:name', (c) => {
  const url = new URL(c.req.url);
  const name = c.req.param('name'); // Hono already URL-decodes path params.
  const scope = url.searchParams.get('scope') === 'project' ? 'project' : 'user';
  return handleRemoveMcpServer(name, scope, url.searchParams.get('cwd'));
});
// The bridge's own MCP server (Streamable HTTP transport) — all methods.
app.all('/mcp', (c) => handleMcpRequest(c.req.raw));

// ── Search ────────────────────────────────────────────────────────────────────
app.get('/search', (c) => {
  const url = new URL(c.req.url);
  const root = url.searchParams.get('root');
  const query = url.searchParams.get('q') || '';
  const caseParam = url.searchParams.get('case');
  const caseMode = caseParam === 'sensitive' || caseParam === 'insensitive' ? caseParam : 'smart';
  const ignoreParam = url.searchParams.get('ignore') || '';
  const ignoreGlobs = ignoreParam
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 32);
  if (!root || !query) return Response.json({ results: [] }, { headers: corsHeaders });
  return handleSearch(root, query, caseMode, ignoreGlobs);
});

// ── Worktree ──────────────────────────────────────────────────────────────────
app.post('/worktree', (c) => handleCreateWorktree(c.req.raw));
app.post('/worktree/remove', (c) => handleRemoveWorktree(c.req.raw));

// ── Telegram ──────────────────────────────────────────────────────────────────
app.get('/telegram/settings', () => {
  const settings = loadTelegramSettings();
  return Response.json({
    botToken: settings.botToken,
    chatId: settings.chatId,
    running: isTelegramBotRunning(),
  }, { headers: corsHeaders });
});
app.put('/telegram/settings', async (c) => {
  const body = await c.req.raw.json() as { botToken?: string; chatId?: string };
  saveTelegramSettings({
    botToken: (body.botToken ?? '').trim(),
    chatId: (body.chatId ?? '').trim(),
  });
  restartTelegramBot();
  return Response.json({ ok: true, running: isTelegramBotRunning() }, { headers: corsHeaders });
});

// ── Deepgram ──────────────────────────────────────────────────────────────────
app.get('/deepgram/settings', () => {
  const settings = loadDeepgramSettings();
  return Response.json({
    apiKey: settings.apiKey,
    model: settings.model,
    language: settings.language,
    configured: Boolean(settings.apiKey),
  }, { headers: corsHeaders });
});
app.put('/deepgram/settings', async (c) => {
  const body = await c.req.raw.json() as { apiKey?: string; model?: string; language?: string };
  const apiKey = (body.apiKey ?? '').trim();
  const model = (body.model ?? '').trim() || 'nova-3';
  const language = (body.language ?? '').trim() || 'multi';
  saveDeepgramSettings({ apiKey, model, language });
  return Response.json({ ok: true, configured: Boolean(apiKey) }, { headers: corsHeaders });
});
app.post('/deepgram/transcribe', async (c) => {
  try {
    const buf = new Uint8Array(await c.req.raw.arrayBuffer());
    if (buf.byteLength === 0) {
      return new Response('empty audio body', { status: 400, headers: corsHeaders });
    }
    const { transcript, detectedLanguage, durationSec } = await transcribeAudioBuffer(buf);
    return Response.json({ transcript, detectedLanguage, durationSec }, { headers: corsHeaders });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(msg, { status: 500, headers: corsHeaders });
  }
});

// ── Tailscale Funnel ───────────────────────────────────────────────────────────
app.get('/tailscale/settings', () => {
  const settings = loadTailscaleSettings();
  const available = isTailscaleAvailable();
  const hostname = available ? getTailscaleHostname() : null;
  const status = available ? getFunnelStatus() : { active: false, ports: [] };
  return Response.json({
    funnelEnabled: settings.funnelEnabled,
    available,
    hostname,
    funnelActive: status.active,
    funnelPorts: status.ports,
    funnelUrl: settings.funnelEnabled && hostname ? `https://${hostname}` : null,
  }, { headers: corsHeaders });
});
app.put('/tailscale/settings', async (c) => {
  const body = await c.req.raw.json() as { funnelEnabled?: boolean };
  const enabled = !!body.funnelEnabled;
  let error: string | null = null;
  if (enabled) {
    const res = enableFunnel(PORT);
    if (!res.ok) error = res.error;
  } else {
    const res = disableFunnel();
    if (!res.ok && isTailscaleAvailable()) error = res.error;
  }
  // Persist intent even if the CLI call fails so the UI reflects the user's
  // choice and we can surface the underlying error.
  saveTailscaleSettings({ funnelEnabled: enabled && !error });
  const hostname = isTailscaleAvailable() ? getTailscaleHostname() : null;
  const status = isTailscaleAvailable() ? getFunnelStatus() : { active: false, ports: [] };
  return Response.json({
    ok: !error,
    error,
    funnelEnabled: enabled && !error,
    available: isTailscaleAvailable(),
    hostname,
    funnelActive: status.active,
    funnelPorts: status.ports,
    funnelUrl: enabled && !error && hostname ? `https://${hostname}` : null,
  }, { status: error ? 400 : 200, headers: corsHeaders });
});

// ── Portless ────────────────────────────────────────────────────────────────────
app.get('/portless/cli-status', () => Response.json(getPortlessCliStatus(), { headers: corsHeaders }));
app.get('/portless/status', () => Response.json({ actions: portlessSnapshotAll() }, { headers: corsHeaders }));
app.post('/portless/run', async (c) => {
  const body = await c.req.raw.json().catch(() => ({})) as {
    groupId?: string; actionId?: string;
    name?: string; command?: string; hostname?: string; cwd?: string;
    noTls?: boolean; source?: 'user' | 'agent'; sessionId?: string;
  };
  if (!body.groupId || !body.actionId || !body.name || !body.command || !body.hostname || !body.cwd) {
    return Response.json({ error: 'groupId, actionId, name, command, hostname and cwd are required.' }, { status: 400, headers: corsHeaders });
  }
  const res = portlessRunAction({
    groupId: body.groupId,
    actionId: body.actionId,
    name: body.name,
    command: body.command,
    hostname: body.hostname,
    cwd: body.cwd,
    noTls: body.noTls === true,
    source: body.source === 'agent' ? 'agent' : 'user',
    sessionId: body.sessionId,
  });
  if (!res.ok) {
    return Response.json({ error: res.error }, { status: 400, headers: corsHeaders });
  }
  return Response.json({ status: res.status }, { headers: corsHeaders });
});
app.post('/portless/stop', async (c) => {
  const body = await c.req.raw.json().catch(() => ({})) as { groupId?: string; actionId?: string };
  if (!body.groupId || !body.actionId) {
    return Response.json({ error: 'groupId and actionId are required.' }, { status: 400, headers: corsHeaders });
  }
  const stopped = portlessStopAction(body.groupId, body.actionId);
  return Response.json({ stopped }, { headers: corsHeaders });
});
app.post('/portless/stop-all', () => {
  portlessStopAll();
  return Response.json({ ok: true }, { headers: corsHeaders });
});
app.post('/portless/forget', async (c) => {
  const body = await c.req.raw.json().catch(() => ({})) as { groupId?: string; actionId?: string };
  if (!body.groupId || !body.actionId) {
    return Response.json({ error: 'groupId and actionId are required.' }, { status: 400, headers: corsHeaders });
  }
  portlessForgetAction(body.groupId, body.actionId);
  return Response.json({ ok: true }, { headers: corsHeaders });
});
app.get('/portless/detect', (c) => {
  const cwd = new URL(c.req.url).searchParams.get('cwd');
  if (!cwd) return Response.json({ error: 'cwd is required.' }, { status: 400, headers: corsHeaders });
  try {
    const pkgPath = join(cwd, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string>; name?: string };
    const scripts = pkg.scripts || {};
    const suggested: { name: string; command: string }[] = [];
    for (const [scriptName] of Object.entries(scripts)) {
      // Surface scripts that look like dev servers: keys starting with
      // `start`, `dev`, `serve`, or `nx run <app>:serve` style scripts.
      if (/^(start|dev|serve)([:-].+)?$/.test(scriptName)) {
        suggested.push({ name: scriptName, command: `npm run ${scriptName}` });
      }
    }
    return Response.json({ projectName: pkg.name || null, suggested }, { headers: corsHeaders });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'could not read package.json' }, { status: 400, headers: corsHeaders });
  }
});
app.get('/portless/scan-env', (c) => {
  const url = new URL(c.req.url);
  const cwd = url.searchParams.get('cwd');
  const actionNamesRaw = url.searchParams.get('actionNames') || '';
  if (!cwd) return Response.json({ error: 'cwd required' }, { status: 400, headers: corsHeaders });
  const actionNames = actionNamesRaw.split(',').map(s => s.trim()).filter(Boolean);
  try {
    const { readFileSync: rf, readdirSync: rd, statSync: st } = require('fs') as typeof import('fs');
    const { join: jp } = require('path') as typeof import('path');
    const found: { var: string; value: string; file: string; line: number; suggestedAction: string | null; ambiguous: boolean }[] = [];
    // Walk top-level + apps/*/ for .env* files. Two levels is plenty for
    // nx/turborepo layouts without going wild on huge monorepos.
    const candidates: string[] = [];
    try {
      for (const f of rd(cwd)) {
        if (f.startsWith('.env')) candidates.push(jp(cwd, f));
      }
    } catch {}
    try {
      const appsDir = jp(cwd, 'apps');
      if (st(appsDir).isDirectory()) {
        for (const sub of rd(appsDir)) {
          const dir = jp(appsDir, sub);
          try {
            if (!st(dir).isDirectory()) continue;
            for (const f of rd(dir)) {
              if (f.startsWith('.env')) candidates.push(jp(dir, f));
            }
          } catch {}
        }
      }
    } catch {}
    const urlish = /^(?:https?:\/\/|localhost|127\.0\.0\.1|0\.0\.0\.0)/i;
    for (const file of candidates) {
      let content = '';
      try { content = rf(file, 'utf-8'); } catch { continue; }
      const lines = content.split('\n');
      lines.forEach((raw, idx) => {
        const line = raw.replace(/^export\s+/, '').trim();
        if (!line || line.startsWith('#')) return;
        const m = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/);
        if (!m) return;
        const key = m[1]!;
        let val = m[2]!.trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!urlish.test(val)) return;
        // Heuristic: pull all action names whose slug is a substring of the
        // env key. e.g. `API_URL` matches action `api`; `WEB_URL` matches
        // `web` AND `web-renter`.
        const keyLow = key.toLowerCase().replace(/[^a-z0-9]+/g, '');
        const matches = actionNames.filter(n => {
          const slug = n.toLowerCase().replace(/[^a-z0-9]+/g, '');
          return slug && keyLow.includes(slug);
        });
        // Prefer the longest matching action name when ambiguous.
        matches.sort((a, b) => b.length - a.length);
        found.push({
          var: key,
          value: val,
          file: file.startsWith(cwd) ? file.slice(cwd.length + 1) : file,
          line: idx + 1,
          suggestedAction: matches[0] || null,
          ambiguous: matches.length > 1,
        });
      });
    }
    return Response.json({ candidates: found, scanned: candidates }, { headers: corsHeaders });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'scan failed' }, { status: 500, headers: corsHeaders });
  }
});
// Reverse-proxy controls. NOTE: these four routes were previously unreachable —
// they had been nested inside the `/pr-detail` handler block (dead code that
// TypeScript flagged). The Hono migration restores them as real routes.
app.get('/portless/proxy/status', async () => {
  const status = await getPortlessProxyStatus();
  return Response.json(status, { headers: corsHeaders });
});
app.post('/portless/proxy/start', async (c) => {
  const body = await c.req.raw.json().catch(() => ({})) as { mode?: ProxyMode };
  const mode: ProxyMode = body.mode === 'http80' || body.mode === 'https443' ? body.mode : 'default';
  const result = await startPortlessProxy(mode);
  return Response.json(result, { status: result.ok ? 200 : 400, headers: corsHeaders });
});
app.post('/portless/proxy/stop', async () => {
  const result = await stopPortlessProxy();
  return Response.json(result, { status: result.ok ? 200 : 400, headers: corsHeaders });
});
app.post('/portless/trust', async () => {
  const result = await trustPortlessCA();
  return Response.json(result, { status: result.ok ? 200 : 400, headers: corsHeaders });
});

// ── Preferences ───────────────────────────────────────────────────────────────
app.get('/preferences', () => Response.json(loadPreferences(), { headers: corsHeaders }));
app.put('/preferences', async (c) => {
  const body = await c.req.raw.json() as Record<string, unknown>;
  updatePreferences(body);
  return Response.json({ ok: true }, { headers: corsHeaders });
});

// ── Keyboard shortcuts (user overrides; defaults live in the frontend) ──────────
app.get('/keybindings', () => Response.json(loadKeybindings(), { headers: corsHeaders }));
app.put('/keybindings', async (c) => {
  // PUT replaces the whole overrides map (not a merge) so removing a key on the
  // client genuinely deletes the override. The body is the full overrides
  // object: command id → chord, or null to force-unbind.
  const body = await c.req.raw.json() as Record<string, string | null>;
  saveKeybindings(body);
  broadcastKeybindings(body);
  return Response.json({ ok: true }, { headers: corsHeaders });
});

// ── Claude hooks (read/write ~/.claude/settings.json and project) ──────────────
app.get('/claude-hooks', (c) => {
  const url = new URL(c.req.url);
  const scope = (url.searchParams.get('scope') || 'global') as 'global' | 'project';
  const cwd = url.searchParams.get('cwd') || undefined;
  try {
    const result = readClaudeHooks(scope, cwd);
    return Response.json(result, { headers: corsHeaders });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 400, headers: corsHeaders });
  }
});
app.put('/claude-hooks', async (c) => {
  const body = await c.req.raw.json() as { scope?: 'global' | 'project'; cwd?: string; hooks?: ClaudeHooks };
  try {
    const result = writeClaudeHooks(body.scope || 'global', body.cwd, body.hooks || {});
    return Response.json({ ok: true, ...result }, { headers: corsHeaders });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 400, headers: corsHeaders });
  }
});

// ── LSP ────────────────────────────────────────────────────────────────────────
app.get('/lsp/languages', () => Response.json(supportedLanguages(), { headers: corsHeaders }));

// ── Debug (CDP) ──────────────────────────────────────────────────────────────────
app.get('/debug/targets', async (c) => {
  const url = new URL(c.req.url);
  const host = url.searchParams.get('host') || '127.0.0.1';
  const port = parseInt(url.searchParams.get('port') || '9229', 10);
  const targets = await discoverTargets(host, port);
  return Response.json(targets, { headers: corsHeaders });
});
app.post('/debug/connect', async (c) => {
  const body = await c.req.raw.json() as Record<string, unknown>;
  const host = (body.host as string) || '127.0.0.1';
  const port = (body.port as number) || 9229;
  const targetId = body.targetId as string | undefined;
  const conn = await connectToTarget(host, port, targetId);
  if (!conn) return Response.json({ error: 'Failed to connect' }, { status: 502, headers: corsHeaders });
  return Response.json({ connectionId: conn.id, host: conn.host, port: conn.port, targetId: conn.targetId }, { headers: corsHeaders });
});
app.post('/debug/disconnect', async (c) => {
  const body = await c.req.raw.json() as Record<string, unknown>;
  const connectionId = body.connectionId as string;
  if (connectionId) disconnectTarget(connectionId);
  return Response.json({ ok: true }, { headers: corsHeaders });
});

// ── Health ──────────────────────────────────────────────────────────────────────
app.get('/health', () => Response.json({ status: 'ok', sessions: sessions.size }, { headers: corsHeaders }));

// ── API docs ──────────────────────────────────────────────────────────────────
// Swagger UI mounted on the bridge itself, so it lives on the same port as the
// API (default 3111) at `/docs`. The spec's server URL is pinned to the live
// bridge port at request time. (`server` is initialized further below; the
// closure only reads it once a request arrives, well after startup.)
app.route('/docs', createDocsApp(() => server.port));
app.post('/ui-log', async (c) => {
  try {
    const body = await c.req.raw.json() as { msg: string };
    log(`[UI] ${body.msg}`);
  } catch {}
  return Response.json({ ok: true }, { headers: corsHeaders });
});

// Diagnostic snapshot of a session's runtime state. Registered last so the
// static `/debug/targets` route wins (Hono prefers static over `:param`).
app.get('/debug/:sessionId', (c) => {
  const id = c.req.param('sessionId');
  const s = sessions.get(id);
  if (!s) return Response.json({ error: 'not found' }, { status: 404, headers: corsHeaders });
  return Response.json({
    id: s.id,
    status: s.status,
    runtimeStatus: s.runtimeStatus,
    ready: s.ready,
    provider: s.provider,
    hasProviderSession: !!s.providerSession,
    browserWsCount: s.browserWs.size,
    frontendClientsCount: frontendClients.size,
    subscribedCount: [...subscriptions.values()].filter(subs => subs.has(id)).length,
  }, { headers: corsHeaders });
});

app.notFound(() => new Response('Not found', { status: 404 }));

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  ...(TLS ? { tls: TLS } : {}),

  async fetch(req, server) {
    const url = new URL(req.url);

    // CORS preflight (always allowed; auth header is checked on the actual request)
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Mobile bearer-token auth (no-op for localhost / public routes)
    if (!authCheck(req, url)) {
      return new Response('Unauthorized', { status: 401, headers: corsHeaders });
    }

    // (Remote routing removed: the renderer now talks to each remote's
    // tunnelled bridge directly, so there is no `?remoteId=` forwarding here.)

    // Sideloaded plugins (`~/.codiby/plugins/<id>/`).
    // - GET /plugins         → manifest list for the frontend loader
    // - /plugins/<id>/...    → plugin-registered routes & static assets
    if (url.pathname === '/plugins' && req.method === 'GET') {
      return new Response(JSON.stringify(pluginHost.getPluginListEntries()), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    if (url.pathname.startsWith('/plugins/')) {
      const resp = await pluginHost.dispatch(req, url);
      if (resp) return resp;
    }

    // Static assets for the desktop + mobile UI (built by `bun build` into dist/)
    if (
      url.pathname === '/' ||
      url.pathname === '/index.html' ||
      url.pathname === '/m' ||
      url.pathname === '/m/' ||
      url.pathname === '/m/index.html' ||
      url.pathname === '/manifest.webmanifest' ||
      url.pathname === '/favicon.svg' ||
      url.pathname === '/favicon.ico' ||
      url.pathname === '/sw.js' ||
      url.pathname.startsWith('/brand/') ||
      url.pathname.startsWith('/assets/') ||
      // Shared React runtime bundles for the importmap (host ↔ plugins).
      url.pathname.startsWith('/runtime/')
    ) {
      const resp = await serveStaticFromDist(url.pathname);
      if (resp) return resp;
      if (
        url.pathname === '/' ||
        url.pathname === '/index.html' ||
        url.pathname === '/m' ||
        url.pathname === '/m/'
      ) {
        return new Response(
          'UI not built. Run `bun run build-server` first.',
          { status: 503, headers: { 'Content-Type': 'text/plain', ...corsHeaders } },
        );
      }
      // For asset requests, fall through (they'd return 404 below anyway)
    }

    // Mobile pair endpoints — restricted to localhost so only the desktop user
    // can read/rotate the token.
    if (url.pathname === '/mobile/pair' && req.method === 'GET') {
      if (!isLocalhostRequest(req)) {
        return new Response('Forbidden', { status: 403, headers: corsHeaders });
      }
      return handleMobilePair();
    }
    if (url.pathname === '/mobile/pair/regenerate' && req.method === 'POST') {
      if (!isLocalhostRequest(req)) {
        return new Response('Forbidden', { status: 403, headers: corsHeaders });
      }
      const res = await handleMobilePairRegenerate();
      // Kick already-authenticated WebSockets so they reconnect with the new
      // token. Localhost clients (the desktop UI) bypass auth and reconnect
      // transparently; remote clients (mobile) will fail re-auth until they
      // re-pair via QR.
      for (const ws of [...frontendClients]) {
        try { ws.close(4401, 'Token rotated'); } catch {}
      }
      for (const tp of trackedProcesses.values()) {
        for (const ws of [...tp.viewers]) {
          try { ws.close(4401, 'Token rotated'); } catch {}
        }
      }
      return res;
    }
    if (url.pathname === '/mobile/notify-test' && req.method === 'POST') {
      return handleMobileNotifyTest(req);
    }

    // Log requests (skip noisy endpoints)
    if (
      url.pathname !== '/health' &&
      url.pathname !== '/file-index' &&
      url.pathname !== '/git-modified'
    ) {
      log(`${req.method} ${url.pathname}${url.search}`);
    }

    // -----------------------------------------------------------------------
    // WebSocket upgrades
    // -----------------------------------------------------------------------

    // Single multiplexed frontend WebSocket
    if (url.pathname === '/ws') {
      const upgraded = server.upgrade(req, { data: { type: 'frontend' } });
      return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
    }

    // Legacy per-session browser WebSocket. Remote sessions connect to their
    // remote bridge's own /browser/ws directly through the tunnel, so this is
    // local-only now.
    if (url.pathname.startsWith('/browser/ws/')) {
      const sessionId = url.pathname.split('/browser/ws/')[1];
      const session = sessions.get(sessionId!);
      if (!session) {
        return new Response('Session not found', { status: 404 });
      }
      const upgraded = server.upgrade(req, { data: { type: 'browser', sessionId } });
      return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
    }


    // LSP WebSocket — /lsp/ws/{sessionId}/{languageId}
    const lspWsMatch = url.pathname.match(/^\/lsp\/ws\/([^/]+)\/([^/]+)$/);
    if (lspWsMatch) {
      const [, sessionId, languageId] = lspWsMatch;
      const upgraded = server.upgrade(req, { data: { type: 'lsp', sessionId, languageId } });
      return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
    }

    // CDP Debug WebSocket — /debug/ws/{connectionId}
    const cdpWsMatch = url.pathname.match(/^\/debug\/ws\/(.+)$/);
    if (cdpWsMatch) {
      const connectionId = decodeURIComponent(cdpWsMatch[1]!);
      const conn = getConnection(connectionId);
      if (!conn) return new Response('Debug connection not found', { status: 404 });
      const upgraded = server.upgrade(req, { data: { type: 'cdp', connectionId } });
      return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
    }

    // All HTTP routes are registered on the Hono `app` (defined above).
    return app.fetch(req);
  },

  // -------------------------------------------------------------------------
  // WebSocket handlers
  // -------------------------------------------------------------------------

  websocket: {
    open(ws) {
      const { type, sessionId, procId } = ws.data as { type: string; sessionId?: string; procId?: string };

      // Multiplexed frontend WebSocket
      if (type === 'frontend') {
        frontendClients.add(ws);
        subscriptions.set(ws, new Set());
        log(`[/ws] Frontend client connected (${frontendClients.size} total)`);
        // Welcome message first so the client knows whether to auto-resume
        // every stopped session (service mode — sessions are already up) or
        // wait for `active_tab_change` to spawn lazily (app mode).
        ws.send(JSON.stringify({ type: 'welcome', spawnMode: SPAWN_MODE }));
        // Preferences must arrive before the sessions list — the client uses
        // tabOrder/tabGroups/etc to decide which tabs to
        // show, so receiving the session list first would race the prefs and
        // briefly render every persisted session as an open tab.
        ws.send(JSON.stringify({ type: 'preferences', preferences: withRemoteGroups(loadPreferences()) }));
        ws.send(JSON.stringify({ type: 'sessions', sessions: buildFullSessionList() }));
        return;
      }

      // Legacy per-session browser WebSocket (kept for compatibility with the
      // older frontend socket; new clients use the multiplexed /ws endpoint).
      if (type === 'browser') {
        const session = sessions.get(sessionId!);
        if (!session) { ws.close(4001, 'Session not found'); return; }
        session.browserWs.add(ws);
        log(`[${sessionId!.slice(0, 8)}] Legacy browser WS connected (${session.browserWs.size} total)`);
        if (session.ready) {
          ws.send(JSON.stringify({ type: 'bridge', status: 'claude_connected' }) + '\n');
        }
        return;
      }

      // LSP WebSocket
      if (type === 'lsp') {
        const { sessionId: sid, languageId } = ws.data as any;
        const lsp = getOrCreateLsp(sid, languageId);
        if (!lsp) { ws.close(4002, 'No language server available'); return; }
        addLspClient(lsp, ws);
        log(`[LSP] Client connected session=${sid?.slice(0, 8)} lang=${languageId}`);
        return;
      }

      // CDP Debug WebSocket
      if (type === 'cdp') {
        const { connectionId } = ws.data as any;
        const conn = getConnection(connectionId);
        if (!conn) { ws.close(4003, 'Debug connection not found'); return; }
        addCdpClient(conn, ws);
        log(`[CDP] Client connected to ${connectionId}`);
        return;
      }

    },

    message(ws, message) {
      const { type, sessionId, procId } = ws.data as { type: string; sessionId?: string; procId?: string };

      if (type === 'terminal') return;

      // CDP — forward message to debug target
      if (type === 'cdp') {
        const { connectionId } = ws.data as any;
        const conn = getConnection(connectionId);
        if (!conn) return;
        const data = typeof message === 'string' ? message : new TextDecoder().decode(message as ArrayBuffer);
        sendCdpMessage(conn, data);
        return;
      }

      // LSP — forward message to language server stdin
      if (type === 'lsp') {
        const { sessionId: sid, languageId } = ws.data as any;
        const lsp = getOrCreateLsp(sid, languageId);
        if (!lsp) return;
        try {
          const json = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message as ArrayBuffer));
          sendToLsp(lsp, json);
        } catch {}
        return;
      }

      // Multiplexed frontend WebSocket
      if (type === 'frontend') {
        handleFrontendMessage(ws, message as string | ArrayBuffer);
        return;
      }

      // Legacy per-session browser WebSocket — messages are ignored.
      // New clients use the multiplexed frontend socket; this endpoint remains
      // open only for older clients that expect a one-way event feed.
    },

    close(ws) {
      const { type, sessionId, procId } = ws.data as { type: string; sessionId?: string; procId?: string };

      if (type === 'frontend') {
        frontendClients.delete(ws);
        subscriptions.delete(ws);
        log(`[/ws] Frontend client disconnected (${frontendClients.size} remaining)`);
        return;
      }

      if (type === 'cdp') {
        const { connectionId } = ws.data as any;
        const conn = getConnection(connectionId);
        if (conn) removeCdpClient(conn, ws);
        log(`[CDP] Client disconnected from ${connectionId}`);
        return;
      }

      if (type === 'lsp') {
        const { sessionId: sid, languageId } = ws.data as any;
        const lsp = getOrCreateLsp(sid, languageId);
        if (lsp) removeLspClient(lsp, ws);
        log(`[LSP] Client disconnected session=${sid?.slice(0, 8)} lang=${languageId}`);
        return;
      }

      const session = sessions.get(sessionId!);
      if (!session) return;

      if (type === 'browser') {
        session.browserWs.delete(ws);
        log(`[${sessionId!.slice(0, 8)}] Legacy browser WS disconnected (${session.browserWs.size} remaining)`);
        return;
      }
    },
  },
});

// ---------------------------------------------------------------------------
// Startup log
// ---------------------------------------------------------------------------

// Write port file for service discovery. Must match the path the desktop
// frontend reads via `electron/bridge_server.ts`:
//   - Explicit override: $CODIBY_CODE_PORT_FILE (used by the macOS LaunchAgent
//     and the Windows SCM wrapper).
//   - macOS:   ~/.codiby/server.port         (launchd)
//   - Windows: %PROGRAMDATA%\codiby\server.port (CodibyCodeBridge)
//   - Linux:   $XDG_CONFIG_HOME/codiby/port  (fallback ~/.config/codiby/port)
function resolvePortFile(): string {
  const override = process.env.CODIBY_CODE_PORT_FILE;
  if (override && override.trim()) return override.trim();

  if (process.platform === 'darwin') {
    return join(homedir(), '.codiby', 'server.port');
  }
  if (process.platform === 'win32') {
    const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';
    return join(programData, 'codiby', 'server.port');
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'codiby', 'port');
}

const PORT_FILE = resolvePortFile();
try {
  mkdirSync(dirname(PORT_FILE), { recursive: true });
  writeFileSync(PORT_FILE, String(server.port));
} catch {}
process.on('exit', () => { try { unlinkSync(PORT_FILE); } catch {} });
process.on('SIGINT', () => { try { unlinkSync(PORT_FILE); } catch {}; process.exit(0); });
process.on('SIGTERM', () => { try { unlinkSync(PORT_FILE); } catch {}; process.exit(0); });

{
  const scheme = TLS ? 'https' : 'http';
  log(`Bridge server listening on ${scheme}://localhost:${server.port} (host=${HOST}, tls=${!!TLS})`);
  log(`Swagger docs: ${scheme}://localhost:${server.port}/docs`);
  log(`Claude binary: ${CLAUDE_BIN}`);
  log(`Working directory: ${CWD}`);
  log(`Spawn mode: ${SPAWN_MODE}`);
  const lanIp = getLanIp();
  if (lanIp && lanIp !== '127.0.0.1') {
    log(`Mobile URL: ${scheme}://${lanIp}:${server.port}/m#t=${loadOrCreateMobileToken()}`);
  } else {
    log('Mobile URL: (no LAN IP detected — connect to a WiFi network)');
  }
}
console.log(`BRIDGE_SERVER_PORT:${server.port}`);
setMcpDeps({
  port: server.port,
  sendMessageToSession,
  broadcastSessionList,
  broadcastToSession,
  updatePreferences,
  loadPreferences,
  maybeAutoGroupSession,
});
setTelegramBroadcaster(broadcastToSession);
startTelegramBot(server.port);

// Lazy spawn: sessions are persisted and shown in the UI immediately, but each
// provider is only booted (and `claude --resume` is only issued) when the user
// activates the tab via `active_tab_change`, or when a message arrives via
// `send_message`/Telegram/MCP. No bulk boot at startup — keeps Claude's auth
// backend from rate-limiting 20 simultaneous handshakes and avoids spawning
// processes the user may never open.
