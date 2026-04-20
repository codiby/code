/**
 * Bridge — translates ProviderEvents into session state updates and
 * WebSocket broadcasts to connected frontend clients.
 *
 * This is the compatibility layer that preserves the browser protocol while
 * the underlying runtime changes from the Claude CLI to the Agent SDK.
 */

import { randomUUID } from 'crypto';
import { ACCEPT_EDITS_TOOLS, PLAN_DENY_TOOLS, PLAN_READ_ONLY_TOOLS } from '../config';
import { log, logError } from '../logger';
import { saveSessions } from '../sessions';
import { addMessage, getSessionState, updateSessionState, updateUIState } from '../state';
import type { ChatMessage, PermissionRequest } from '../state';
import type { Session } from '../types';
import type { PermissionDecision, PermissionRequestDetail, ProviderEvents } from './types';

export type BridgeDeps = {
  broadcastToSession: (sessionId: string, msg: object) => void;
  broadcastSessionList: () => void;
  notifyTelegramIfMainSession: (sessionId: string) => void;
};

export function createBridgeEvents(session: Session, deps: BridgeDeps): ProviderEvents {
  const sid8 = session.id.slice(0, 8);

  const commitText = (text: string, meta?: { model?: string; usage?: any }) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const msg: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: text,
      timestamp: Date.now(),
      model: meta?.model,
      usage: meta?.usage,
    };
    if (addMessage(session.id, msg)) {
      deps.broadcastToSession(session.id, { type: 'message', sessionId: session.id, message: msg });
    }
    updateSessionState(session.id, s => ({ ...s, partialText: '', isStreaming: false }));
  };

  return {
    onInit(info) {
      session.claudeSessionId = info.providerSessionId;
      saveSessions();

      const initInfo = {
        tools: info.tools,
        cwd: info.cwd || session.cwd,
        version: info.version,
        slashCommands: info.slashCommands,
        model: info.model || session.model || '',
        permissionMode: info.permissionMode || session.permissionMode || 'default',
      };
      updateSessionState(session.id, s => ({ ...s, initInfo }));
      session.ready = true;
      session.status = 'running';
      deps.broadcastToSession(session.id, { type: 'init_info', sessionId: session.id, info: initInfo });
      deps.broadcastToSession(session.id, { type: 'status', sessionId: session.id, status: 'connected' });
      deps.broadcastSessionList();
      log(`[${sid8}] Provider session initialized (${info.providerSessionId})`);
    },

    onAssistantDelta(text) {
      if (!session.replayDone) return;
      updateSessionState(session.id, s => ({ ...s, partialText: text, isStreaming: true }));
      deps.broadcastToSession(session.id, { type: 'partial_text', sessionId: session.id, text });
    },

    onAssistantText(text, meta) {
      commitText(text, meta);
    },

    onToolUse(tool) {
      // When partial messages are enabled, the SDK sends streaming text in one
      // assistant message and the follow-up tool_use in a SEPARATE message.
      // The text was written to `state.partialText` via onAssistantDelta but
      // never committed through `onAssistantText` (the adapter's local
      // partialText variable starts empty on each dispatch). If we don't flush
      // here, the client's `onMessage` handler will clear partialText when the
      // tool_use arrives and the streaming text VANISHES from the UI.
      const pending = getSessionState(session.id).partialText;
      if (pending?.trim()) commitText(pending);

      const mode = session.permissionMode || 'default';
      const willAutoApprove =
        mode === 'bypassPermissions' ||
        (mode === 'acceptEdits' && ACCEPT_EDITS_TOOLS.has(tool.name)) ||
        (mode === 'plan' && PLAN_READ_ONLY_TOOLS.has(tool.name));
      const chatMsg: ChatMessage = {
        id: tool.id || randomUUID(),
        role: 'assistant',
        content: `Using tool: **${tool.name}**`,
        timestamp: Date.now(),
        toolName: tool.name,
        toolInput: tool.input,
        autoApproved: willAutoApprove || undefined,
      };
      if (addMessage(session.id, chatMsg)) {
        deps.broadcastToSession(session.id, { type: 'message', sessionId: session.id, message: chatMsg });
      }
    },

    onToolResult(result) {
      // Same safety flush — a tool_result could arrive while partialText is set.
      const pending = getSessionState(session.id).partialText;
      if (pending?.trim()) commitText(pending);

      const chatMsg: ChatMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
        timestamp: Date.now(),
        isToolResult: true,
        toolUseId: result.toolUseId,
        isError: result.isError,
      };
      if (addMessage(session.id, chatMsg)) {
        deps.broadcastToSession(session.id, { type: 'message', sessionId: session.id, message: chatMsg });
      }
    },

    onTodosUpdate(todos) {
      updateUIState(session.id, { todos: todos as any });
      deps.broadcastToSession(session.id, { type: 'todos', sessionId: session.id, todos });
    },

    async onPermissionRequest(req: PermissionRequestDetail): Promise<PermissionDecision> {
      const mode = session.permissionMode || 'default';
      const inputRecord = req.input || {};

      // Auto-deny: plan mode + write tool
      if (mode === 'plan' && PLAN_DENY_TOOLS.has(req.toolName)) {
        log(`[${sid8}] Auto-denied ${req.toolName} (plan mode)`);
        return {
          allow: false,
          message: `Denied: session is in plan mode. Do not attempt to use ${req.toolName} — only read the codebase and write your plan to the plan file, then call ExitPlanMode.`,
        };
      }

      // Auto-allow by mode
      const shouldAutoAccept =
        mode === 'bypassPermissions' ||
        (mode === 'acceptEdits' && ACCEPT_EDITS_TOOLS.has(req.toolName)) ||
        (mode === 'plan' && PLAN_READ_ONLY_TOOLS.has(req.toolName));

      if (shouldAutoAccept) {
        // The tool_use ChatMessage itself now carries `autoApproved: true`
        // (set in onToolUse based on the mode), so the UI shows the badge
        // inside the tool card — no separate system message needed.
        log(`[${sid8}] Auto-approved ${req.toolName} (mode=${mode})`);
        return { allow: true };
      }

      // Prompt the user via WebSocket and await their response
      const permRequest: PermissionRequest = {
        requestId: req.requestId,
        toolName: req.toolName,
        displayName: req.displayName,
        description: req.description,
        input: inputRecord,
        title: req.title,
      };
      updateSessionState(session.id, s => ({ ...s, permRequest }));
      deps.broadcastToSession(session.id, { type: 'permission_request', sessionId: session.id, request: permRequest });

      return new Promise<PermissionDecision>((resolve) => {
        pendingDecisions.set(req.requestId, { sessionId: session.id, resolve });
      });
    },

    onTurnComplete(info) {
      if (info.resultText) {
        const chatMsg: ChatMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: info.resultText,
          timestamp: Date.now(),
          costUsd: info.costUsd,
          durationMs: info.durationMs,
          usage: info.usage as any,
        };
        if (addMessage(session.id, chatMsg)) {
          deps.broadcastToSession(session.id, { type: 'message', sessionId: session.id, message: chatMsg });
        }
      }
      session.replayDone = true;
      updateSessionState(session.id, s => ({ ...s, partialText: '', isStreaming: false, permRequest: null }));
      deps.broadcastToSession(session.id, { type: 'status', sessionId: session.id, status: 'turn_complete' });
      deps.notifyTelegramIfMainSession(session.id);
    },

    onAutoNameCandidate(text) {
      if (!session.name.startsWith('Session ')) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      const newName = trimmed.slice(0, 40).replace(/\n/g, ' ');
      session.name = newName;
      saveSessions();
      deps.broadcastToSession(session.id, { type: 'session_name', sessionId: session.id, name: newName });
      deps.broadcastSessionList();
    },

    onError(err) {
      logError(`[${sid8}] Provider error: ${err.message}`);
    },

    onExit(code) {
      log(`[${sid8}] Provider session exited with code ${code}`);
      session.ready = false;
      session.status = 'stopped';
      session.providerSession = null;
      const state = getSessionState(session.id);
      if (state.partialText?.trim()) {
        const msg: ChatMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: state.partialText,
          timestamp: Date.now(),
        };
        if (addMessage(session.id, msg)) {
          deps.broadcastToSession(session.id, { type: 'message', sessionId: session.id, message: msg });
        }
      }
      updateSessionState(session.id, s => ({ ...s, partialText: '', isStreaming: false }));
      deps.broadcastToSession(session.id, { type: 'status', sessionId: session.id, status: 'disconnected' });
      deps.broadcastSessionList();
    },
  };
}

// ---------------------------------------------------------------------------
// Pending permission decisions — resolved by frontend permission_response
// ---------------------------------------------------------------------------

type PendingDecision = {
  sessionId: string;
  resolve: (decision: PermissionDecision) => void;
};

const pendingDecisions = new Map<string, PendingDecision>();

export function resolvePermissionDecision(
  requestId: string,
  decision: PermissionDecision,
): boolean {
  const pending = pendingDecisions.get(requestId);
  if (!pending) return false;
  pendingDecisions.delete(requestId);
  pending.resolve(decision);
  return true;
}

export function clearPendingDecisionsForSession(sessionId: string, reason = 'Session stopped'): void {
  for (const [id, pending] of pendingDecisions) {
    if (pending.sessionId !== sessionId) continue;
    pendingDecisions.delete(id);
    pending.resolve({ allow: false, message: reason, interrupt: true });
  }
}
