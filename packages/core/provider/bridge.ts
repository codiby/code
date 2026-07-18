/**
 * Bridge — translates ProviderEvents into session state updates and
 * WebSocket broadcasts to connected frontend clients.
 *
 * This is the compatibility layer that preserves the browser protocol while
 * the underlying runtime changes from the Claude CLI to the Agent SDK.
 */

import { randomUUID } from 'crypto';
import { ACCEPT_EDITS_TOOLS, ALWAYS_AUTO_APPROVE_TOOLS, MAIN_SESSION_ID, PLAN_DENY_TOOLS, PLAN_READ_ONLY_TOOLS, USER_INTERACTION_TOOLS } from '../config/config';
import { log, logError } from '../lib/logger';
import { saveSessions } from '../session/sessions';
import { addMessage, getSessionState, updateSessionState, updateUIState } from '../session/state';
import type { ChatMessage, PermissionRequest } from '../session/state';
import type { Session } from '../types';
import { notify } from '../integrations/notify';
import { updateWorkingWithTool } from '../integrations/telegram';
import { setClaudeModels } from '../handlers/claude-info';
import type { PermissionDecision, PermissionRequestDetail, ProviderEvents } from './types';

export type BridgeDeps = {
  broadcastToSession: (sessionId: string, msg: object) => void;
  broadcastSessionList: () => void;
  notifyTelegramIfMainSession: (sessionId: string) => void;
};

export function createBridgeEvents(session: Session, deps: BridgeDeps): ProviderEvents {
  const sid8 = session.id.slice(0, 8);
  // Capture the generation of the provider we're bridging. If the session
  // bumps this (via startProviderSession, e.g. on a restart) before our
  // onExit fires, we'll know the exit is for a previous provider and skip
  // the state mutations so they don't clobber the fresh one.
  const gen = session.providerSessionGen;

  const commitText = (text: string, meta?: { model?: string; usage?: any; parentToolUseId?: string | null }) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const msg: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: text,
      timestamp: Date.now(),
      model: meta?.model,
      usage: meta?.usage,
      parentToolUseId: meta?.parentToolUseId ?? null,
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
      session.runtimeStatus = 'running';
      deps.broadcastToSession(session.id, { type: 'init_info', sessionId: session.id, info: initInfo });
      deps.broadcastToSession(session.id, { type: 'status', sessionId: session.id, status: 'connected' });
      deps.broadcastSessionList();
      log(`[${sid8}] Provider session initialized (${info.providerSessionId})`);
    },

    onAssistantDelta(text) {
      if (!session.replayDone) return;
      // After a user interrupt the SDK can still flush a few deltas before it
      // settles. Drop them — re-arming `isStreaming` here would put the Stop
      // button back on screen until the next status change.
      if (getSessionState(session.id).wasInterrupted) return;
      updateSessionState(session.id, s => ({ ...s, partialText: text, isStreaming: true, wasInterrupted: false }));
      deps.broadcastToSession(session.id, { type: 'partial_text', sessionId: session.id, text });
    },

    onAssistantText(text, meta) {
      commitText(text, meta);
    },

    onThinkingDelta(text) {
      if (!session.replayDone) return;
      if (getSessionState(session.id).wasInterrupted) return;
      updateSessionState(session.id, s => ({ ...s, partialThinking: text, isStreaming: true, wasInterrupted: false }));
      deps.broadcastToSession(session.id, { type: 'partial_thinking', sessionId: session.id, text });
    },

    onThinking(block) {
      // Post-interrupt flush of the aborted turn: the interrupt handler
      // already committed the streamed preview as a permanent message, so
      // committing this block too would duplicate the thought — with a fresh
      // UUID, past the id dedup — at the bottom of the transcript. The flag
      // clears on the next user send / turn completion, so live turns are
      // never gated here.
      if (getSessionState(session.id).wasInterrupted) return;
      // A thinking block usually precedes text/tool_use within the same
      // Anthropic Message, but in case the bridge has any pending streaming
      // text (rare — partial deltas should have been overwritten by the
      // assistant message that carried the thinking), flush it first so the
      // UI doesn't render the thought below text it actually preceded.
      const pending = getSessionState(session.id).partialText;
      if (pending?.trim()) commitText(pending, { parentToolUseId: block.parentToolUseId });

      const msg: ChatMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: block.text,
        timestamp: Date.now(),
        isThinking: true,
        thinkingRedacted: block.redacted || undefined,
        parentToolUseId: block.parentToolUseId ?? null,
      };
      if (addMessage(session.id, msg)) {
        deps.broadcastToSession(session.id, { type: 'message', sessionId: session.id, message: msg });
      }

      // The permanent thinking ChatMessage is now in the log — drop the
      // transient streaming preview. The client clears the same field when
      // it sees the matching `message` event.
      updateSessionState(session.id, s => ({ ...s, partialThinking: '' }));
      deps.broadcastToSession(session.id, { type: 'partial_thinking', sessionId: session.id, text: '' });

      // The model is still mid-turn after a thought — keep the streaming
      // indicator on so the UI doesn't briefly flash idle.
      if (!getSessionState(session.id).wasInterrupted) {
        updateSessionState(session.id, s => ({ ...s, isStreaming: true, wasInterrupted: false }));
        deps.broadcastToSession(session.id, { type: 'status', sessionId: session.id, status: 'streaming' });
      }
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
      if (pending?.trim()) commitText(pending, { parentToolUseId: tool.parentToolUseId });

      // The agent is still actively working — it's now running a tool. Keep
      // the "streaming" indicator on so the orange dot / mobile thinking
      // state persists through tool execution. `commitText` above flips
      // server-side isStreaming to false; re-arm it here and re-broadcast
      // the streaming status so observing/reconnected clients agree.
      // Skip the re-arm if the user just interrupted — late tool_use events
      // would otherwise put the Stop pill back on screen.
      if (!getSessionState(session.id).wasInterrupted) {
        updateSessionState(session.id, s => ({ ...s, isStreaming: true, wasInterrupted: false }));
        deps.broadcastToSession(session.id, { type: 'status', sessionId: session.id, status: 'streaming' });
      }

      const mode = session.permissionMode || 'default';
      const willAutoApprove =
        ALWAYS_AUTO_APPROVE_TOOLS.has(tool.name) ||
        (!USER_INTERACTION_TOOLS.has(tool.name) && (
          mode === 'bypassPermissions' ||
          (mode === 'acceptEdits' && ACCEPT_EDITS_TOOLS.has(tool.name)) ||
          (mode === 'plan' && PLAN_READ_ONLY_TOOLS.has(tool.name))
        ));
      const chatMsg: ChatMessage = {
        id: tool.id || randomUUID(),
        role: 'assistant',
        content: `Using tool: **${tool.name}**`,
        timestamp: Date.now(),
        toolName: tool.name,
        toolInput: tool.input,
        parentToolUseId: tool.parentToolUseId ?? null,
        autoApproved: willAutoApprove || undefined,
      };
      if (addMessage(session.id, chatMsg)) {
        deps.broadcastToSession(session.id, { type: 'message', sessionId: session.id, message: chatMsg });
      }

      // For the Telegram-driven main session, stream tool progress into the
      // pending "⏳ Claude is working…" bubble so the user can watch from
      // Telegram. No-op for every other session.
      if (session.id === MAIN_SESSION_ID) {
        try {
          updateWorkingWithTool(tool.name, summariseToolInput(tool.name, tool.input as Record<string, unknown>));
        } catch {}
      }
    },

    onToolResult(result) {
      // Same safety flush — a tool_result could arrive while partialText is set.
      const pending = getSessionState(session.id).partialText;
      if (pending?.trim()) commitText(pending, { parentToolUseId: result.parentToolUseId });

      // Tool finished but the turn isn't done — the agent will keep working
      // (next assistant block or another tool). Keep the indicator lit.
      // Skip if the user just interrupted; the result still gets recorded
      // below but the streaming indicator should stay off.
      if (!getSessionState(session.id).wasInterrupted) {
        updateSessionState(session.id, s => ({ ...s, isStreaming: true, wasInterrupted: false }));
        deps.broadcastToSession(session.id, { type: 'status', sessionId: session.id, status: 'streaming' });
      }

      const chatMsg: ChatMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
        timestamp: Date.now(),
        isToolResult: true,
        toolUseId: result.toolUseId,
        parentToolUseId: result.parentToolUseId ?? null,
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

    onModelsAvailable(models) {
      updateSessionState(session.id, s => ({ ...s, supportedModels: models }));
      deps.broadcastToSession(session.id, { type: 'supported_models', sessionId: session.id, models });
      // Snapshot the Claude list to the global cache so non-session pickers
      // (project settings, new-session modals) can surface the SDK's models
      // even when no live session is around to ask.
      if (session.provider === 'claude') setClaudeModels(models);
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

      // Auto-allow by mode (or always-allow list for safe in-process tools).
      // USER_INTERACTION_TOOLS (AskUserQuestion, ExitPlanMode) always prompt —
      // even in bypassPermissions — because their whole job is to hand control
      // back to the user.
      const shouldAutoAccept =
        ALWAYS_AUTO_APPROVE_TOOLS.has(req.toolName) ||
        (!USER_INTERACTION_TOOLS.has(req.toolName) && (
          mode === 'bypassPermissions' ||
          (mode === 'acceptEdits' && ACCEPT_EDITS_TOOLS.has(req.toolName)) ||
          (mode === 'plan' && PLAN_READ_ONLY_TOOLS.has(req.toolName))
        ));

      if (shouldAutoAccept) {
        // The tool_use ChatMessage itself now carries `autoApproved: true`
        // (set in onToolUse based on the mode), so the UI shows the badge
        // inside the tool card — no separate system message needed.
        log(`[${sid8}] Auto-approved ${req.toolName} (mode=${mode})`);
        return { allow: true };
      }

      return requestPermissionDecision(session, deps, { ...req, input: inputRecord });
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
      updateSessionState(session.id, s => ({ ...s, partialText: '', partialThinking: '', isStreaming: false, wasInterrupted: false, permRequest: null }));
      deps.broadcastToSession(session.id, { type: 'status', sessionId: session.id, status: 'turn_complete' });
      deps.notifyTelegramIfMainSession(session.id);
      // Generic "Claude is done" alert for any NON-main session's turn
      // completion. The main (Telegram-driven) session already forwards
      // its reply via notifyTelegramIfMainSession above — firing the
      // generic notify too would produce a duplicate bubble in Telegram.
      if (session.id !== MAIN_SESSION_ID) {
        try {
          const preview = (info.resultText || '').slice(0, 200);
          if (preview.trim()) {
            notify({ type: 'turn_complete', sessionId: session.id, preview });
          }
        } catch {}
      }
    },

    onError(err) {
      logError(`[${sid8}] Provider error: ${err.message}`);
      // If a turn was in flight when the runtime errored, the indicator is
      // about to go dark — flag it as interrupted so the UI can show "last
      // turn died" (red dot) instead of an idle gray dot.
      const wasStreaming = getSessionState(session.id).isStreaming;
      if (wasStreaming) {
        updateSessionState(session.id, s => ({ ...s, isStreaming: false, partialText: '', partialThinking: '', wasInterrupted: true }));
        deps.broadcastToSession(session.id, { type: 'status', sessionId: session.id, status: 'interrupted' });
      }
    },

    onExit(code) {
      // A previous provider's exit arriving after a new one was spawned
      // (typically the case for `handleRestartSession`, where we close
      // and re-spawn in the same handler). Drop the stale state
      // mutations so they don't clobber the new session.
      if (session.providerSessionGen !== gen) {
        log(`[${sid8}] Ignoring stale provider exit (gen ${gen} != current ${session.providerSessionGen})`);
        return;
      }
      log(`[${sid8}] Provider session exited with code ${code}`);
      session.ready = false;
      session.runtimeStatus = 'stopped';
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
      // Exiting mid-turn (no `onTurnComplete` arrived) — mark the session as
      // interrupted so the UI can render a red dot instead of leaving the
      // user staring at a stuck "thinking" indicator forever.
      const interrupted = state.isStreaming;
      updateSessionState(session.id, s => ({ ...s, partialText: '', partialThinking: '', isStreaming: false, wasInterrupted: interrupted || s.wasInterrupted }));
      deps.broadcastToSession(session.id, { type: 'status', sessionId: session.id, status: 'disconnected' });
      if (interrupted) {
        deps.broadcastToSession(session.id, { type: 'status', sessionId: session.id, status: 'interrupted' });
      }
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

/**
 * Surface a provider-agnostic approval request. HTTP MCP tools use this path
 * too, so their approval UI and remote notifications match native SDK tools.
 */
export function requestPermissionDecision(
  session: Session,
  deps: BridgeDeps,
  req: PermissionRequestDetail,
): Promise<PermissionDecision> {
  const permRequest: PermissionRequest = {
    requestId: req.requestId,
    toolName: req.toolName,
    displayName: req.displayName,
    description: req.description,
    input: req.input || {},
    title: req.title,
  };
  updateSessionState(session.id, s => ({ ...s, permRequest }));
  deps.broadcastToSession(session.id, { type: 'permission_request', sessionId: session.id, request: permRequest });

  try {
    const summary = summariseToolInput(req.toolName, permRequest.input);
    notify({
      type: 'permission_request',
      requestId: req.requestId,
      sessionId: session.id,
      toolName: req.toolName,
      summary: req.title || req.description || summary,
    });
  } catch {}

  return new Promise<PermissionDecision>((resolve) => {
    pendingDecisions.set(req.requestId, { sessionId: session.id, resolve });
  });
}

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

/** Pull a short, human-readable summary out of a tool's input — used in
 *  notification text. Falls back to a JSON dump for unknown tools. */
function summariseToolInput(toolName: string, input: Record<string, unknown>): string {
  if (!input || typeof input !== 'object') return '';
  const get = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  switch (toolName) {
    case 'Bash':
      return get('command') || '';
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return get('file_path') || get('path') || '';
    case 'Grep':
    case 'Glob':
      return get('pattern') || get('query') || '';
    case 'WebFetch':
    case 'WebSearch':
      return get('url') || get('query') || '';
    default:
      try {
        const json = JSON.stringify(input);
        return json.length > 200 ? json.slice(0, 199) + '…' : json;
      } catch {
        return '';
      }
  }
}
