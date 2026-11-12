/**
 * Bridge — translates ProviderEvents into session state updates and
 * WebSocket broadcasts to connected frontend clients.
 *
 * This is the compatibility layer that preserves the browser protocol while
 * the underlying runtime changes from the Claude CLI to the Agent SDK.
 */

import { randomUUID } from 'crypto';
import { ACCEPT_EDITS_TOOLS, ALWAYS_AUTO_APPROVE_TOOLS, MAIN_SESSION_ID, PLAN_DENY_TOOLS, PLAN_READ_ONLY_TOOLS, touchesProtectedPath, USER_INTERACTION_TOOLS } from '../config/config';
import { log, logError } from '../lib/logger';
import { isGrantedRead } from '../session/granted-paths';
import { isWorkspaceRead } from '../session/workspace';
import { saveSessions } from '../session/sessions';
import { addMessage, getSessionState, updateSessionState, updateUIState } from '../session/state';
import type { ChatMessage, PermissionRequest } from '../session/state';
import type { Session } from '../types';
import { notify } from '../integrations/notify';
import { setClaudeModels } from '../handlers/claude-info';
import { emitAgentToolUse, emitApprovalRequested, emitApprovalResolved, evaluateAgentPolicy } from '../agent/registry';
import { handleAgentProviderError, handleAgentTurnComplete } from '../agent/dispatch';
import { applyTaskEvent, pruneTasks, seedFromSnapshot, settleRunningTasks } from '../session/tasks';
import type { PermissionDecision, PermissionRequestDetail, ProviderEvents, TurnCompleteInfo } from './types';

export type BridgeDeps = {
  broadcastToSession: (sessionId: string, msg: object) => void;
  sendBrowserRequest: (sessionId: string, msg: object) => void;
  broadcastSessionList: () => void;
  onTurnComplete?: (sessionId: string, info: TurnCompleteInfo) => void;
  onError?: (sessionId: string, error: Error) => void;
  onExit?: (sessionId: string, code: number | null) => void;
};

export function createBridgeEvents(session: Session, deps: BridgeDeps): ProviderEvents {
  const sid8 = session.id.slice(0, 8);
  // Capture the generation of the provider we're bridging. If the session
  // bumps this (via startProviderSession, e.g. on a restart) before our
  // onExit fires, we'll know the exit is for a previous provider and skip
  // the state mutations so they don't clobber the fresh one.
  const gen = session.providerSessionGen;
  const compaction = (active: boolean) => {
    if (session.providerSessionGen !== gen) return;
    const state = getSessionState(session.id);
    if (active && state.wasInterrupted) return;
    if (!!state.isCompacting === active) return;
    updateSessionState(session.id, s => ({ ...s, isCompacting: active, isStreaming: active || s.isStreaming }));
    deps.broadcastToSession(session.id, { type: 'compaction', sessionId: session.id, active });
  };

  /** A sub-agent's own text/thinking goes out as `subagent_message`: it belongs
   *  to the Agents window, not to the chat's message list (see isSubagentChatter). */
  const broadcastChatter = (msg: ChatMessage) => {
    deps.broadcastToSession(session.id, { type: 'subagent_message', sessionId: session.id, message: msg });
  };

  const commitText = (text: string, meta?: { model?: string; usage?: any; parentToolUseId?: string | null; agentId?: string | null }) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const fromSubagent = !!(meta?.parentToolUseId || meta?.agentId);
    const msg: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: text,
      timestamp: Date.now(),
      model: meta?.model,
      usage: meta?.usage,
      parentToolUseId: meta?.parentToolUseId ?? null,
      ...(meta?.agentId ? { agentId: meta.agentId } : {}),
    };
    if (fromSubagent) {
      // The main thread is still working while its sub-agent talks: leave its
      // live preview and streaming flag alone.
      if (addMessage(session.id, msg)) broadcastChatter(msg);
      return;
    }
    if (addMessage(session.id, msg)) {
      deps.broadcastToSession(session.id, { type: 'message', sessionId: session.id, message: msg });
    }
    updateSessionState(session.id, s => ({ ...s, partialText: '', isStreaming: false }));
  };

  /** Stop-mark the tasks a dead provider left running (see settleRunningTasks). */
  const settleTasks = () => {
    const tasks = getSessionState(session.id).tasks;
    if (!tasks) return;
    const settled = settleRunningTasks(tasks);
    if (settled.length === 0) return;
    const next = { ...tasks };
    for (const t of settled) next[t.taskId] = t;
    updateSessionState(session.id, s => ({ ...s, tasks: next }));
    for (const t of settled) deps.broadcastToSession(session.id, { type: 'task_update', sessionId: session.id, task: t });
  };
  // A new provider for this session means the previous one (and every
  // sub-agent it was running) is gone — close() does not always deliver an
  // onExit, so settle here too.
  settleTasks();

  return {
    onCompaction: compaction,
    onInit(info) {
      session.claudeSessionId = info.providerSessionId;
      // A branch now owns its forked conversation; later restarts resume it.
      session.forkPending = false;
      saveSessions();

      const initInfo = {
        tools: info.tools,
        // The session's working directory, not the process's: a resumed
        // provider may have been spawned where the conversation started
        // (see session/workspace.ts), and the UI roots its explorer here.
        cwd: session.cwd || info.cwd,
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

    onSlashCommands(commands) {
      // Fills the picker before the first turn. A later `onInit` replaces the
      // whole initInfo, so here we only add to what is already known.
      const prev = getSessionState(session.id).initInfo;
      const known = prev?.slashCommands ?? [];
      const slashCommands = [...known, ...commands.filter(c => !known.includes(c))];
      const initInfo = prev
        ? { ...prev, slashCommands }
        : {
            tools: [],
            cwd: session.cwd,
            version: '',
            slashCommands,
            model: session.model || '',
            permissionMode: session.permissionMode || 'default',
          };
      updateSessionState(session.id, s => ({ ...s, initInfo }));
      deps.broadcastToSession(session.id, { type: 'init_info', sessionId: session.id, info: initInfo });
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
      if (block.parentToolUseId || block.agentId) {
        const sub: ChatMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: block.text,
          timestamp: Date.now(),
          isThinking: true,
          thinkingRedacted: block.redacted || undefined,
          parentToolUseId: block.parentToolUseId ?? null,
          ...(block.agentId ? { agentId: block.agentId } : {}),
        };
        if (addMessage(session.id, sub)) broadcastChatter(sub);
        return;
      }
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
      // `partialText` only ever holds the main thread's text (sub-agent
      // partials are dropped in the adapter), so it commits as main even when
      // this tool call is a background sub-agent's — tagging it with the
      // sub-agent's ids would file it as chatter, out of the chat and the
      // channel reply, and leave the preview set to be committed again.
      const pending = getSessionState(session.id).partialText;
      if (pending?.trim()) commitText(pending);

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
      const toolInput = (tool.input ?? {}) as Record<string, unknown>;
      // The agent's policy has the final word on its own tool cards (preview
      // only — the real decision is recorded in onPermissionRequest).
      const policyPreview = !USER_INTERACTION_TOOLS.has(tool.name)
        ? evaluateAgentPolicy({ session, toolName: tool.name, input: toolInput, phase: 'preview' })
        : null;
      const willAutoApprove = policyPreview
        ? policyPreview.action === 'allow'
        : ALWAYS_AUTO_APPROVE_TOOLS.has(tool.name) ||
          isGrantedRead(session, tool.name, toolInput) ||
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
        ...(tool.agentId ? { agentId: tool.agentId } : {}),
        autoApproved: willAutoApprove || undefined,
      };
      if (addMessage(session.id, chatMsg)) {
        deps.broadcastToSession(session.id, { type: 'message', sessionId: session.id, message: chatMsg });
      }

      // The agent's channels show tool progress (Telegram's working bubble).
      if (session.id === MAIN_SESSION_ID) {
        emitAgentToolUse(session.id, tool.name, summariseToolInput(tool.name, toolInput));
      }
    },

    onToolResult(result) {
      // Same safety flush — a tool_result could arrive while partialText is set
      // (main-thread text, as in onToolUse).
      const pending = getSessionState(session.id).partialText;
      if (pending?.trim()) commitText(pending);

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
        ...(result.agentId ? { agentId: result.agentId } : {}),
        isError: result.isError,
      };
      if (addMessage(session.id, chatMsg)) {
        deps.broadcastToSession(session.id, { type: 'message', sessionId: session.id, message: chatMsg });
      }
    },

    onTaskEvent(event) {
      // Sub-agent / workflow lifecycle from the SDK → one record per task,
      // pushed to the Agents panel as it changes.
      const state = getSessionState(session.id);
      const tasks = { ...(state.tasks ?? {}) };
      const changed = event.kind === 'snapshot'
        ? seedFromSnapshot(tasks, event)
        : [applyTaskEvent(tasks[event.taskId], event)];
      if (changed.length === 0) return;
      for (const t of changed) tasks[t.taskId] = t;
      updateSessionState(session.id, s => ({ ...s, tasks: pruneTasks(tasks) }));
      for (const t of changed) {
        deps.broadcastToSession(session.id, { type: 'task_update', sessionId: session.id, task: t });
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

      // Auto-deny: anything reaching for the requirements ledger or its
      // signing key. Signature verification would catch the edit afterwards,
      // but denying here keeps the attempt in the transcript where the user
      // can see it.
      if (touchesProtectedPath(inputRecord)) {
        log(`[${sid8}] Auto-denied ${req.toolName} (protected path)`);
        return {
          allow: false,
          message: 'Denied: the requirements database and its signing key are off limits. Requirement outcomes are written by the server only — use run_requirements.',
        };
      }

      // Agent policy (packages/core/agent/policy). Only has an opinion about
      // the agent session; USER_INTERACTION_TOOLS always reach the user.
      if (!USER_INTERACTION_TOOLS.has(req.toolName)) {
        const verdict = evaluateAgentPolicy({ session, toolName: req.toolName, input: inputRecord, phase: 'decide', requestId: req.requestId });
        if (verdict?.action === 'deny') {
          log(`[${sid8}] Policy denied ${req.toolName}${verdict.ruleId ? ` (rule ${verdict.ruleId})` : ''}`);
          return { allow: false, message: `Denied by the agent's policy${verdict.reason ? `: ${verdict.reason}` : ''}. Do not retry; tell the owner what you were trying to do.` };
        }
        if (verdict?.action === 'allow') {
          log(`[${sid8}] Policy allowed ${req.toolName}${verdict.ruleId ? ` (rule ${verdict.ruleId})` : ''}`);
          return { allow: true };
        }
        if (verdict?.action === 'ask') {
          return requestPermissionDecision(session, deps, { ...req, input: inputRecord });
        }
      }

      // Auto-allow by mode (or always-allow list for safe in-process tools).
      // USER_INTERACTION_TOOLS (AskUserQuestion, ExitPlanMode) always prompt —
      // even in bypassPermissions — because their whole job is to hand control
      // back to the user. Reads of a file the user attached to a message are
      // pre-approved by the act of sending it.
      const shouldAutoAccept =
        ALWAYS_AUTO_APPROVE_TOOLS.has(req.toolName) ||
        isGrantedRead(session, req.toolName, inputRecord) ||
        isWorkspaceRead(session, req.toolName, inputRecord) ||
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
      // Set by a Stop (or an error) during this turn and cleared below; dispatch needs to know.
      const stopped = getSessionState(session.id).wasInterrupted;
      compaction(false);
      deps.onTurnComplete?.(session.id, info);
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
      // `info` tells dispatch whether resultText is the model's answer or a provider error.
      handleAgentTurnComplete(session.id, info, { interrupted: stopped });
      // Generic "session finished" alert for any session but the agent's,
      // whose replies already go back to its channels through dispatch.
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
      compaction(false);
      if (session.providerSessionGen !== gen) return;
      const message: ChatMessage = {
        id: randomUUID(), role: 'system', timestamp: Date.now(),
        content: `${session.provider || 'Provider'}: ${err.message}`,
      };
      if (addMessage(session.id, message)) {
        deps.broadcastToSession(session.id, { type: 'message', sessionId: session.id, message });
      }
      deps.onError?.(session.id, err);
      logError(`[${sid8}] Provider error: ${err.message}`);
      // If a turn was in flight when the runtime errored, the indicator is
      // about to go dark — flag it as interrupted so the UI can show "last
      // turn died" (red dot) instead of an idle gray dot.
      const wasStreaming = getSessionState(session.id).isStreaming;
      if (wasStreaming) {
        updateSessionState(session.id, s => ({ ...s, isStreaming: false, partialText: '', partialThinking: '', wasInterrupted: true }));
        deps.broadcastToSession(session.id, { type: 'status', sessionId: session.id, status: 'interrupted' });
        // The agent's channels would otherwise never hear that their message died.
        handleAgentProviderError(session.id, err.message);
      }
    },

    onExit(code) {
      compaction(false);
      // A previous provider's exit arriving after a new one was spawned
      // (typically the case for `handleRestartSession`, where we close
      // and re-spawn in the same handler). Drop the stale state
      // mutations so they don't clobber the new session.
      if (session.providerSessionGen !== gen) {
        log(`[${sid8}] Ignoring stale provider exit (gen ${gen} != current ${session.providerSessionGen})`);
        return;
      }
      log(`[${sid8}] Provider session exited with code ${code}`);
      deps.onExit?.(session.id, code);
      session.ready = false;
      session.runtimeStatus = 'stopped';
      session.providerSession = null;
      settleTasks();
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
  toolName: string;
  /** The same promise `requestPermissionDecision` returned to its first
   *  caller. Kept so a duplicate request for the same session+tool can await
   *  the decision the user is already looking at (see `findPendingDecision`). */
  promise: Promise<PermissionDecision>;
  resolve: (decision: PermissionDecision) => void;
};

const pendingDecisions = new Map<string, PendingDecision>();

/**
 * The in-flight decision for this session+tool, if the user is already being
 * asked. Callers that would otherwise raise a second, identical prompt (an
 * agent retrying `ExitPlanMode` after its MCP call timed out, say) await this
 * instead — one card, one notification, and the retry stays blocked until the
 * user actually answers.
 */
export function findPendingDecision(
  sessionId: string,
  toolName: string,
): Promise<PermissionDecision> | null {
  for (const pending of pendingDecisions.values()) {
    if (pending.sessionId === sessionId && pending.toolName === toolName) return pending.promise;
  }
  return null;
}

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

  let resolve!: (decision: PermissionDecision) => void;
  const promise = new Promise<PermissionDecision>((res) => { resolve = res; });
  pendingDecisions.set(req.requestId, { sessionId: session.id, toolName: req.toolName, promise, resolve });

  // Approval surfaces beyond the session's own UI (agent channels, push).
  emitApprovalRequested({
    requestId: req.requestId,
    sessionId: session.id,
    sessionName: session.name,
    toolName: req.toolName,
    title: req.title || req.displayName || req.toolName,
    summary: req.description || summariseToolInput(req.toolName, permRequest.input),
    input: permRequest.input,
  });
  return promise;
}

/**
 * Settle a pending permission request. `via` names the surface that answered
 * ('desktop', 'mobile', 'telegram', 'whatsapp', 'push', 'expired'…) so the
 * other surfaces can update and the activity log can record it.
 */
export function resolvePermissionDecision(
  requestId: string,
  decision: PermissionDecision,
  via = 'ui',
): boolean {
  const pending = pendingDecisions.get(requestId);
  if (!pending) return false;
  pendingDecisions.delete(requestId);
  pending.resolve(decision);
  emitApprovalResolved({ requestId, allow: decision.allow, via });
  return true;
}

/** Session id and tool of a pending request — for surfaces that only hold the id. */
export function getPendingDecision(requestId: string): { sessionId: string; toolName: string } | null {
  const pending = pendingDecisions.get(requestId);
  return pending ? { sessionId: pending.sessionId, toolName: pending.toolName } : null;
}

export function clearPendingDecisionsForSession(sessionId: string, reason = 'Session stopped'): void {
  for (const [id, pending] of pendingDecisions) {
    if (pending.sessionId !== sessionId) continue;
    pendingDecisions.delete(id);
    pending.resolve({ allow: false, message: reason, interrupt: true });
    emitApprovalResolved({ requestId: id, allow: false, via: 'cancelled' });
  }
}

/** Pull a short, human-readable summary out of a tool's input — used in
 *  notification text. Falls back to a JSON dump for unknown tools. */
export function summariseToolInput(toolName: string, input: Record<string, unknown>): string {
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
