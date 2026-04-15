/**
 * Server-side session state management.
 * Each session has its own state, persisted to disk.
 * The server is the single source of truth.
 */

import { loadMessages, loadUIState, saveUIState, appendMessage } from './storage';
import { log } from './logger';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  images?: { media_type: string; data: string }[];
  toolName?: string;
  toolInput?: unknown;
  isToolResult?: boolean;
  isError?: boolean;
  isTerminal?: boolean;
  terminalCommand?: string;
  exitCode?: number;
  costUsd?: number;
  durationMs?: number;
  usage?: { input_tokens: number; output_tokens: number };
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
  permRequest: PermissionRequest | null;
  initInfo: {
    tools: string[];
    cwd: string;
    version: string;
    slashCommands: string[];
    model: string;
    permissionMode: string;
  } | null;
  ui: SessionUIState;
}

const sessionStates = new Map<string, SessionState>();
const messageIdSets = new Map<string, Set<string>>();

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
    permRequest: null,
    initInfo: null,
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
      for (const m of msgs) if (m.id) idSet.add(m.id);
      messageIdSets.set(sessionId, idSet);
    }
    const uiData = loadUIState(sessionId) as Partial<SessionUIState>;
    state.ui = { ...emptyUIState(), ...uiData };
    sessionStates.set(sessionId, state);
  }
  return state;
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
  // Deduplicate by ID
  let idSet = messageIdSets.get(sessionId);
  if (!idSet) { idSet = new Set(); messageIdSets.set(sessionId, idSet); }
  if (idSet.has(msg.id)) return false;
  // Deduplicate by content+role (CLI replay generates new IDs for same content)
  // Skip for tool-use messages — each invocation is distinct even with same tool name
  if (!msg.toolName) {
    const msgs = state.messages;
    for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 50); i--) {
      const m = msgs[i];
      if (m.role === msg.role && m.content === msg.content && !m.toolName) return false;
    }
  }
  idSet.add(msg.id);
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
    saveUIState(sessionId, state.ui);
  }, 500));
}

export function clearSessionState(sessionId: string) {
  sessionStates.delete(sessionId);
  messageIdSets.delete(sessionId);
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
    permRequest: state.permRequest,
    initInfo: state.initInfo,
    ...state.ui,
  };
}
