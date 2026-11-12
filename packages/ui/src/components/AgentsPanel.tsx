/**
 * Agents drawer — the session's sub-agents and workflows, live.
 *
 * Same shell as ResourcesPanel (440px drawer inside the chat panel, opened
 * from the "Agents" chip next to Resources). Data comes from the Claude
 * Agent SDK's task_* events (folded server-side into `state.tasks`); a row's
 * steps and the full-chat window come from the sub-agent's own messages.
 *
 * A workflow is one SDK task with no stream of its own agents, so those are
 * polled from the bridge (it reads the run's transcript files). A workflow
 * that has them renders as a group header with a done/total meter, its agents
 * as rows under it; clicking one opens its chat.
 */

import { Fragment, useMemo, useState } from 'react';
import { Bot, Check, Maximize2, Square, X, ArrowDownToLine, CircleSlash } from 'lucide-react';
import type { ChatMessage, ClaudeClient, SubagentTask, WorkflowAgent } from '../lib/claude-client';
import {
  formatElapsed, formatTokens, groupTasks, isAgentActing, isAgentTask, isTaskRunning, isWorkflowTask, taskElapsedMs, taskKindLabel, taskTitle,
  plainPreview, toolArg, useNow, usePageVisible, useTaskTranscript, useWorkflowAgents, visibleWorkflowAgents,
  workflowAgentElapsedMs, workflowAgentTask, workflowProgress,
} from '../lib/subagents';
import { shortToolName } from './MessageBubble';
import { AgentChatWindow } from './AgentChatWindow';

type Filter = 'all' | 'running' | 'done';

interface Props {
  open: boolean;
  onClose: () => void;
  client: ClaudeClient | null;
  sessionId: string | null;
  tasks: Record<string, SubagentTask>;
  /** The chat's live messages — the sub-agents' tool calls arrive there. */
  messages: ChatMessage[];
}

export function AgentsPanel({ open, onClose, client, sessionId, tasks, messages }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [windowId, setWindowId] = useState<string | null>(null);
  const [windowAgent, setWindowAgent] = useState<{ workflowId: string; agentId: string } | null>(null);

  const list = useMemo(() => Object.values(tasks), [tasks]);
  const workflows = useMemo(() => list.filter(t => isAgentTask(t) && isWorkflowTask(t)), [list]);
  const pageVisible = usePageVisible();
  const innerByWorkflow = useWorkflowAgents(client, sessionId, workflows, open && pageVisible);
  const { running, done } = useMemo(() => groupTasks(list), [list]);
  const runningCount = running.reduce((n, g) => n + g.tasks.length, 0);
  const now = useNow(open && runningCount > 0);
  const shown = [...running.flatMap(g => g.tasks), ...done];
  const totals = useMemo(() => ({
    tokens: shown.reduce((n, t) => n + t.totalTokens, 0),
    tools: shown.reduce((n, t) => n + t.toolUses, 0),
    longest: shown.reduce((n, t) => Math.max(n, taskElapsedMs(t, now)), 0),
  }), [shown, now]);

  const windowTask = windowId ? tasks[windowId] ?? null : null;
  // A workflow pruned while its agent's chat was open closes the window.
  const agentWorkflow = windowAgent ? tasks[windowAgent.workflowId] ?? null : null;
  const agentInWindow: WorkflowAgent | null = windowAgent && agentWorkflow
    ? innerByWorkflow[agentWorkflow.taskId]?.find(a => a.agentId === windowAgent.agentId) ?? null
    : null;
  const openTask = (id: string) => { setWindowAgent(null); setWindowId(id); };
  const openAgent = (workflowId: string, agentId: string) => { setWindowId(null); setWindowAgent({ workflowId, agentId }); };

  if (!open) return null;

  const stop = (t: SubagentTask) => { if (client && sessionId) client.stopTask(sessionId, t.taskId); };
  const background = (t: SubagentTask) => { if (client && sessionId) client.backgroundTask(sessionId, t.toolUseId); };

  const filters: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: runningCount + done.length },
    { key: 'running', label: 'Running', count: runningCount },
    { key: 'done', label: 'Completed', count: done.length },
  ];

  return (
    <div className="h-full w-[440px] shrink-0 flex flex-col bg-surface border-l border-border">
      {/* Header */}
      <div className="flex items-center gap-2.5 h-12 px-3 pl-4 border-b border-border shrink-0">
        <Bot size={16} className="text-cyan-300" />
        <span className="text-[13px] font-semibold text-zinc-100">Agents</span>
        <span className="text-[11px] text-zinc-600 ml-auto">
          {runningCount} running · {done.length} done
        </span>
        <button
          type="button" onClick={onClose} aria-label="Close agents"
          className="w-7 h-7 rounded-md flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-surface-lighter"
        >
          <X size={15} />
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-1.5 px-4 py-3 border-b border-border shrink-0">
        {filters.map(f => (
          <button
            key={f.key} type="button" onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}
            className={`text-[11.5px] px-2.5 py-1 rounded-md border transition-colors ${
              filter === f.key ? 'bg-surface-lighter text-zinc-200 border-border-light' : 'text-zinc-500 border-transparent hover:text-zinc-300'
            }`}
          >
            {f.label}{f.count > 0 && <span className="ml-1.5 text-[10px] text-zinc-600">{f.count}</span>}
          </button>
        ))}
      </div>

      {shown.length > 0 && (
        <div className="flex gap-3.5 px-4 py-2 border-b border-border shrink-0 font-mono text-[10.5px] text-zinc-600">
          <span><span className="text-zinc-400">{formatTokens(totals.tokens)}</span> tokens</span>
          <span><span className="text-zinc-400">{totals.tools}</span> tool uses</span>
          <span><span className="text-zinc-400">{formatElapsed(totals.longest)}</span> longest</span>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {shown.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center gap-2 text-zinc-600 px-6">
            <Bot size={26} className="opacity-40" />
            <div className="text-[12px]">No sub-agents yet.</div>
            <div className="text-[11px] max-w-[240px] leading-snug">When the agent delegates work to sub-agents or a workflow, they show up here live.</div>
          </div>
        ) : (
          <>
            {filter !== 'done' && running.map(group => {
              const inner = group.workflow ? innerByWorkflow[group.workflow.taskId] : undefined;
              if (group.workflow && inner?.length) {
                const wf = group.workflow;
                return (
                  <div key={group.key}>
                    <WorkflowHeader workflow={wf} agents={inner} now={now} onStop={() => stop(wf)} />
                    {visibleWorkflowAgents(inner, filter).map(a => (
                      <WorkflowAgentRow key={a.agentId} agent={a} now={now} acting={isAgentActing(a, wf)} onOpen={() => openAgent(wf.taskId, a.agentId)} />
                    ))}
                  </div>
                );
              }
              return (
              <div key={group.key}>
                <GroupLabel>
                  {group.workflow ? (
                    <>
                      Workflow
                      <span className="font-mono normal-case tracking-normal text-[11px] font-medium text-zinc-400">{group.workflow.workflowName || taskTitle(group.workflow)}</span>
                    </>
                  ) : 'Running'}
                </GroupLabel>
                {group.tasks.map(t => (
                  <TaskRow
                    key={t.taskId}
                    task={t}
                    now={now}
                    selected={selectedId === t.taskId}
                    onSelect={() => setSelectedId(id => (id === t.taskId ? null : t.taskId))}
                    onOpen={() => openTask(t.taskId)}
                    onStop={() => stop(t)}
                    onBackground={() => background(t)}
                    client={client}
                    sessionId={sessionId}
                    messages={messages}
                  />
                ))}
              </div>
              );
            })}
            {filter === 'running' && runningCount === 0 && (
              <div className="text-[12px] text-zinc-600 px-2 py-6 text-center">Nothing running.</div>
            )}
            {filter !== 'running' && done.length > 0 && (
              <>
                <GroupLabel>Completed</GroupLabel>
                {done.map(t => {
                  const inner = isWorkflowTask(t) ? innerByWorkflow[t.taskId] : undefined;
                  if (inner?.length) {
                    return (
                      <Fragment key={t.taskId}>
                        <WorkflowHeader workflow={t} agents={inner} now={now} nested />
                        {inner.map(a => (
                          <WorkflowAgentRow key={a.agentId} agent={a} now={now} acting={false} onOpen={() => openAgent(t.taskId, a.agentId)} />
                        ))}
                      </Fragment>
                    );
                  }
                  return (
                  <TaskRow
                    key={t.taskId}
                    task={t}
                    now={now}
                    selected={selectedId === t.taskId}
                    onSelect={() => setSelectedId(id => (id === t.taskId ? null : t.taskId))}
                    onOpen={() => openTask(t.taskId)}
                    onStop={() => stop(t)}
                    onBackground={() => background(t)}
                    client={client}
                    sessionId={sessionId}
                    messages={messages}
                  />
                  );
                })}
              </>
            )}
          </>
        )}
      </div>

      {windowTask && (
        <AgentChatWindow
          task={windowTask}
          client={client}
          sessionId={sessionId}
          messages={messages}
          onClose={() => setWindowId(null)}
          onStop={() => stop(windowTask)}
          onBackground={() => background(windowTask)}
        />
      )}

      {windowAgent && agentWorkflow && (
        <AgentChatWindow
          key={`${windowAgent.workflowId}/${windowAgent.agentId}`}
          task={workflowAgentTask(agentInWindow ?? pendingAgent(windowAgent.agentId, agentWorkflow), agentWorkflow)}
          workflowAgent={{ workflow: agentWorkflow, agentId: windowAgent.agentId }}
          client={client}
          sessionId={sessionId}
          messages={messages}
          onClose={() => setWindowAgent(null)}
        />
      )}
    </div>
  );
}

/** Stand-in until the agent's first poll lands (it was clicked, so it exists). */
function pendingAgent(agentId: string, workflow: SubagentTask): WorkflowAgent {
  return {
    agentId, label: agentId, phase: null, status: isTaskRunning(workflow) ? 'running' : 'stopped',
    startedAt: null, endedAt: null, toolUses: 0, outputTokens: 0, lastToolName: null, lastText: null, summary: null,
  };
}

/**
 * A workflow that reported its agents: the group's label line plus a meter of
 * how many handed back their result. Stays one line tall like GroupLabel so
 * the list does not jump when the first poll arrives.
 */
function WorkflowHeader({ workflow, agents, now, onStop, nested }: {
  workflow: SubagentTask;
  agents: WorkflowAgent[];
  now: number;
  onStop?: () => void;
  /** Under "Completed": no "Workflow" caption, the section already says what it is. */
  nested?: boolean;
}) {
  const { done, total, percent } = workflowProgress(agents);
  const running = isTaskRunning(workflow);
  const name = workflow.workflowName || taskTitle(workflow);
  const bar = running ? 'bg-cyan-400' : workflow.status === 'completed' ? 'bg-emerald-400/70' : 'bg-zinc-500';
  return (
    <div className="group mx-2 mt-3 mb-1" title={taskTitle(workflow)}>
      <div className="flex items-center gap-1.5 min-w-0 text-[10px] font-semibold uppercase tracking-[0.07em] text-zinc-600">
        {nested ? <span className="w-3 flex justify-center shrink-0"><StatusIcon task={workflow} /></span> : <span className="shrink-0">Workflow</span>}
        <span className="font-mono normal-case tracking-normal text-[11px] font-medium text-zinc-400 truncate">{name}</span>
        <span className="ml-auto pl-2 font-mono normal-case tracking-normal text-[10.5px] font-normal tabular-nums text-zinc-500 shrink-0">{done}/{total}</span>
        <span className="font-mono normal-case tracking-normal text-[10.5px] font-normal tabular-nums text-zinc-600 shrink-0">{formatElapsed(taskElapsedMs(workflow, now))}</span>
        {running && onStop ? (
          <button
            type="button"
            onClick={onStop}
            title="Stop this workflow"
            aria-label="Stop this workflow"
            className="w-4 flex items-center justify-center text-zinc-500 hover:text-rose-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rose-400/60 rounded shrink-0"
          >
            <X size={12} />
          </button>
        ) : (
          <span className="w-4 shrink-0" aria-hidden />
        )}
      </div>
      <div
        role="progressbar"
        aria-label={`${name}: ${done} of ${total} agents done`}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="mt-1.5 mr-5 h-[3px] rounded-full bg-zinc-700/70 overflow-hidden"
      >
        <span className={`block h-full rounded-full transition-[width] duration-500 ${bar}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/**
 * One agent of a workflow, laid out like TaskRow so the columns line up.
 * Clicking opens its chat: there is no inline detail, its steps live there.
 */
function WorkflowAgentRow({ agent, now, acting, onOpen }: {
  agent: WorkflowAgent;
  now: number;
  /** The agent the workflow's latest progress tick named. */
  acting: boolean;
  onOpen: () => void;
}) {
  const running = agent.status === 'running';
  const line = running
    ? [agent.lastToolName && shortToolName(agent.lastToolName), agent.lastText].filter(Boolean).join(' · ') || 'Starting…'
    : [agent.phase, `${agent.toolUses} tools`].filter(Boolean).join(' · ');
  return (
    <div
      role="button"
      tabIndex={0}
      title={`${agent.label} — open its chat`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
      }}
      className={`group flex items-center gap-2 h-7 px-2 rounded-md cursor-pointer min-w-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500/50 ${acting ? 'bg-cyan-500/[0.07] hover:bg-cyan-500/[0.11]' : 'hover:bg-surface-light'}`}
    >
      {/* Fixed slot: the spinner is narrower than the check, and these rows mix both. */}
      <span className="w-3 flex justify-center shrink-0"><StatusGlyph status={agent.status} /></span>
      <span className={`font-mono text-[11.5px] truncate max-w-[150px] shrink-0 ${acting ? 'text-cyan-200' : 'text-zinc-200'}`}>{agent.label}</span>
      <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-zinc-600">{line}</span>
      <span className="font-mono text-[10.5px] text-zinc-600 shrink-0 tabular-nums" title={`${agent.outputTokens} output tokens`}>{formatTokens(agent.outputTokens)}</span>
      <span className="font-mono text-[10.5px] text-zinc-600 shrink-0 tabular-nums">{formatElapsed(workflowAgentElapsedMs(agent, now))}</span>
      <span className="w-[18px] h-[18px] rounded flex items-center justify-center text-zinc-500 group-hover:text-cyan-300 shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden>
        <Maximize2 size={11} />
      </span>
      <span className="w-4 shrink-0" aria-hidden />
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 mx-2 mt-3 mb-1 text-[10px] font-semibold uppercase tracking-[0.07em] text-zinc-600">
      {children}
    </div>
  );
}

function StatusIcon({ task }: { task: SubagentTask }) {
  return <StatusGlyph status={task.status} />;
}

function StatusGlyph({ status }: { status: SubagentTask['status'] }) {
  if (status === 'running' || status === 'pending' || status === 'paused') {
    return <span className="w-2.5 h-2.5 rounded-full border-[1.5px] border-cyan-500/30 border-t-cyan-300 animate-spin shrink-0" aria-label="Running" />;
  }
  if (status === 'completed') return <Check size={12} className="text-emerald-400 shrink-0" aria-label="Completed" />;
  return <CircleSlash size={12} className={`shrink-0 ${status === 'failed' ? 'text-rose-400' : 'text-zinc-500'}`} aria-label={status} />;
}

function TaskRow({ task, now, selected, onSelect, onOpen, onStop, onBackground, client, sessionId, messages }: {
  task: SubagentTask;
  now: number;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onStop: () => void;
  onBackground: () => void;
  client: ClaudeClient | null;
  sessionId: string | null;
  messages: ChatMessage[];
}) {
  const running = isTaskRunning(task);
  const line = running
    ? [task.lastToolName, task.progress].filter(Boolean).join(' · ') || 'Starting…'
    : `${taskKindLabel(task)} · ${formatTokens(task.totalTokens)} tokens`;
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={selected}
        title={taskTitle(task)}
        onClick={onSelect}
        onDoubleClick={onOpen}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
        }}
        className={`group flex items-center gap-2 h-7 px-2 rounded-md cursor-pointer min-w-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500/50 ${selected ? 'bg-surface-lighter' : 'hover:bg-surface-light'}`}
      >
        <StatusIcon task={task} />
        <span className="font-mono text-[11.5px] text-zinc-200 truncate max-w-[150px] shrink-0">{taskTitle(task)}</span>
        <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-zinc-600">{line}</span>
        <span className="font-mono text-[10.5px] text-zinc-600 shrink-0 tabular-nums">{formatElapsed(taskElapsedMs(task, now))}</span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onOpen(); }}
          title="Open full chat"
          aria-label="Open full chat"
          className={`w-[18px] h-[18px] rounded flex items-center justify-center text-zinc-500 hover:text-cyan-300 hover:bg-cyan-500/10 shrink-0 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/60 ${selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'}`}
        >
          <Maximize2 size={11} />
        </button>
        {/* Finished rows keep the stop slot empty so every elapsed time lines up. */}
        {running ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onStop(); }}
            title="Stop this agent"
            aria-label="Stop this agent"
            className="w-4 flex items-center justify-center text-zinc-500 hover:text-rose-400 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rose-400/60 rounded shrink-0"
          >
            <X size={12} />
          </button>
        ) : (
          <span className="w-4 shrink-0" aria-hidden />
        )}
      </div>
      {selected && (
        <TaskDetail task={task} onOpen={onOpen} onStop={onStop} onBackground={onBackground} client={client} sessionId={sessionId} messages={messages} />
      )}
    </>
  );
}

function TaskDetail({ task, onOpen, onStop, onBackground, client, sessionId, messages }: {
  task: SubagentTask;
  onOpen: () => void;
  onStop: () => void;
  onBackground: () => void;
  client: ClaudeClient | null;
  sessionId: string | null;
  messages: ChatMessage[];
}) {
  const running = isTaskRunning(task);
  const transcript = useTaskTranscript(client, sessionId, task, messages);
  const steps = transcript.messages.filter(m => m.toolName).slice(-6);
  const text = plainPreview((running ? task.progress : task.summary) || '');
  return (
    <div className="ml-[22px] mr-1 mt-0.5 mb-2 pl-2.5 border-l border-border">
      {text && <div className="text-[11.5px] text-zinc-400 leading-[1.45] py-0.5 whitespace-pre-wrap break-words line-clamp-6">{text}</div>}
      {task.error && <div className="text-[11.5px] text-rose-300 py-0.5">{task.error}</div>}
      <div className="flex gap-2.5 py-1 font-mono text-[10.5px] text-zinc-600">
        <span><span className="text-zinc-400">{task.toolUses}</span> tools</span>
        <span><span className="text-zinc-400">{formatTokens(task.totalTokens)}</span> tokens</span>
        <span>{taskKindLabel(task)}</span>
      </div>
      {steps.length > 0 && (
        <div className="py-0.5">
          {steps.map(m => (
            <div key={m.id} className="flex items-center gap-1.5 min-h-[20px] text-[11px] min-w-0">
              <span className="font-mono text-zinc-400 shrink-0">{shortToolName(m.toolName || '')}</span>
              <span className="font-mono text-zinc-600 truncate">{toolArg(m)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5 pt-1">
        {running && (
          <>
            {!task.backgrounded && (
              <button type="button" onClick={onBackground} className="inline-flex items-center gap-1 h-[22px] px-2 rounded-md border border-border text-[11px] text-zinc-400 hover:text-zinc-100 hover:bg-surface-lighter transition-colors">
                <ArrowDownToLine size={11} /> Background
              </button>
            )}
            <button type="button" onClick={onStop} className="inline-flex items-center gap-1 h-[22px] px-2 rounded-md border border-rose-500/35 text-[11px] text-rose-300 hover:bg-rose-500/10 transition-colors">
              <Square size={9} fill="currentColor" /> Stop
            </button>
          </>
        )}
        <button type="button" onClick={onOpen} className="ml-auto inline-flex items-center gap-1 h-[22px] px-2 rounded-md border border-cyan-500/35 text-[11px] text-cyan-300 hover:bg-cyan-500/10 transition-colors">
          <Maximize2 size={10} /> Open chat
        </button>
      </div>
    </div>
  );
}
