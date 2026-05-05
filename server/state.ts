/**
 * Server-side session state management.
 * Each session has its own state, persisted to disk.
 * The server is the single source of truth.
 */

import { randomUUID } from 'crypto';
import { loadMessages, loadUIState, saveUIState, appendMessage } from './storage';
import type { ProviderModelInfo } from './provider/types';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  seq?: number;
  images?: { media_type: string; data: string }[];
  toolName?: string;
  toolInput?: unknown;
  isToolResult?: boolean;
  toolUseId?: string;
  /**
   * When this message was produced by a sub-agent (spawned via the Agent
   * tool), this is the `tool_use` id of the parent Agent invocation. The
   * frontend groups every message sharing this id under the Agent card.
   */
  parentToolUseId?: string | null;
  autoApproved?: boolean;
  isError?: boolean;
  isTerminal?: boolean;
  terminalCommand?: string;
  exitCode?: number;
  costUsd?: number;
  durationMs?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
}

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  displayName?: string;
  description?: string;
  input: Record<string, unknown>;
  title?: string;
}

export interface SessionUIState {
  input: string;
  inputHistory: string[];
  openFile: { path: string; content: string } | null;
  openTerminalId: string | null;
  diffView: { path: string; original: string; modified: string } | null;
  editorFullWidth: boolean;
  reviewMode: boolean;
  reviewComments: Record<string, unknown[]>;
  reviewFiles: string[];
  reviewIndex: number;
  todos: { content: string; status: string; activeForm?: string }[];
}

export interface SessionState {
  messages: ChatMessage[];
  partialText: string;
  isStreaming: boolean;
  /**
   * The previous turn ended without an `onTurnComplete` — usually a provider
   * crash, hard exit, or socket teardown mid-tool. Set in the bridge when the
   * runtime dies while `isStreaming` was true; cleared the next time the
   * session sees activity (new prompt, new assistant event). Drives a red
   * indicator in the UI so the user knows the last turn died.
   */
  wasInterrupted: boolean;
  permRequest: PermissionRequest | null;
  initInfo: {
    tools: string[];
    cwd: string;
    version: string;
    slashCommands: string[];
    model: string;
    permissionMode: string;
  } | null;
  /**
   * Models the provider exposes for the model picker. Populated by the
   * adapter once the live session is responsive (e.g. Claude Agent SDK's
   * `runtime.supportedModels()`). Empty until the probe lands; the frontend
   * falls back to its built-in list while it's still empty.
   */
  supportedModels: ProviderModelInfo[];
  ui: SessionUIState;
}

const sessionStates = new Map<string, SessionState>();
const messageIdSets = new Map<string, Set<string>>();
const sessionSeqCounters = new Map<string, number>();

// Debounce timers for saving UI state
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function emptyUIState(): SessionUIState {
  return {
    input: '',
    inputHistory: [],
    openFile: null,
    openTerminalId: null,
    diffView: null,
    editorFullWidth: false,
    reviewMode: false,
    reviewComments: {},
    reviewFiles: [],
    reviewIndex: 0,
    todos: [],
  };
}

export function emptyState(): SessionState {
  return {
    messages: [],
    partialText: '',
    isStreaming: false,
    wasInterrupted: false,
    permRequest: null,
    initInfo: null,
    supportedModels: [],
    ui: emptyUIState(),
  };
}

export function getSessionState(sessionId: string): SessionState {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = emptyState();
    // Load persisted data
    const msgs = loadMessages(sessionId) as ChatMessage[];
    if (msgs.length > 0) {
      state.messages = msgs;
      const idSet = new Set<string>();
      let maxSeq = 0;
      for (const m of msgs) {
        if (m.id) idSet.add(m.id);
        if (typeof m.seq === 'number' && m.seq > maxSeq) maxSeq = m.seq;
      }
      messageIdSets.set(sessionId, idSet);
      sessionSeqCounters.set(sessionId, maxSeq);
    }
    const uiData = loadUIState(sessionId) as Partial<SessionUIState>;
    state.ui = { ...emptyUIState(), ...uiData };
    sessionStates.set(sessionId, state);
    // The bridge dying mid-tool leaves a tool_use on disk with no matching
    // tool_result — the UI keys "still running" off that pairing, so the
    // amber dot would stick forever after a restart. Synthesize an error
    // result for each orphan now so the chat reflects reality.
    healOrphanedToolUses(sessionId, 'No result: the bridge restarted before this tool finished.');
  }
  return state;
}

/**
 * Append a synthetic error tool_result for every tool_use in this session
 * that doesn't already have a matching tool_result. Safe to call repeatedly:
 * once a tool_use is paired, it's skipped on subsequent calls.
 *
 * Used in two places:
 *  - On cold session load (bridge restart healed in `getSessionState`).
 *  - On user interrupt, when in-flight tools won't ever produce a real
 *    result.
 */
export function healOrphanedToolUses(sessionId: string, reason: string): ChatMessage[] {
  const state = sessionStates.get(sessionId);
  if (!state) return [];
  const resultIds = new Set<string>();
  for (const m of state.messages) {
    if (m.isToolResult && m.toolUseId) resultIds.add(m.toolUseId);
  }
  const orphans: ChatMessage[] = [];
  for (const m of state.messages) {
    // Skip TodoWrite — it's tracked via the todos UI state, not chat
    // tool_results, so it never has a paired result by design.
    if (!m.toolName || m.isToolResult) continue;
    if (m.toolName === 'TodoWrite') continue;
    if (!m.id) continue;
    if (resultIds.has(m.id)) continue;
    orphans.push(m);
  }
  const added: ChatMessage[] = [];
  for (const orphan of orphans) {
    const synthetic: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: reason,
      timestamp: Date.now(),
      isToolResult: true,
      toolUseId: orphan.id,
      parentToolUseId: orphan.parentToolUseId ?? null,
      isError: true,
    };
    if (addMessage(sessionId, synthetic)) added.push(synthetic);
  }
  return added;
}

export function updateSessionState(sessionId: string, fn: (state: SessionState) => SessionState): SessionState {
  const current = getSessionState(sessionId);
  const next = fn(current);
  sessionStates.set(sessionId, next);
  return next;
}

/** Returns true if message was added, false if duplicate */
export function addMessage(sessionId: string, msg: ChatMessage): boolean {
  const state = getSessionState(sessionId);
  // Deduplicate by ID only. A prior content+role scan (inherited from the
  // pre-SDK CLI-pipe design) was dropping legitimate repeats — e.g.
  // identical short assistant texts or tool-results with matching stdout,
  // which happens constantly in bypassPermissions mode.
  let idSet = messageIdSets.get(sessionId);
  if (!idSet) { idSet = new Set(); messageIdSets.set(sessionId, idSet); }
  if (idSet.has(msg.id)) return false;
  idSet.add(msg.id);
  const nextSeq = (sessionSeqCounters.get(sessionId) ?? 0) + 1;
  sessionSeqCounters.set(sessionId, nextSeq);
  msg.seq = nextSeq;
  state.messages.push(msg);
  appendMessage(sessionId, msg);
  return true;
}

export function updateUIState(sessionId: string, partial: Partial<SessionUIState>) {
  const state = getSessionState(sessionId);
  Object.assign(state.ui, partial);
  // Debounced persist
  clearTimeout(saveTimers.get(sessionId));
  saveTimers.set(sessionId, setTimeout(() => {
    saveUIState(sessionId, state.ui as unknown as Record<string, unknown>);
  }, 500));
}

export function clearSessionState(sessionId: string) {
  sessionStates.delete(sessionId);
  messageIdSets.delete(sessionId);
  sessionSeqCounters.delete(sessionId);
  clearTimeout(saveTimers.get(sessionId));
}

const MAX_CLIENT_MESSAGES = 200;

export function getStateForClient(sessionId: string) {
  const state = getSessionState(sessionId);
  const msgs = state.messages;
  return {
    messages: msgs.length > MAX_CLIENT_MESSAGES ? msgs.slice(-MAX_CLIENT_MESSAGES) : msgs,
    totalMessages: msgs.length,
    partialText: state.partialText,
    isStreaming: state.isStreaming,
    wasInterrupted: state.wasInterrupted,
    permRequest: state.permRequest,
    initInfo: state.initInfo,
    supportedModels: state.supportedModels,
    ...state.ui,
  };
}
