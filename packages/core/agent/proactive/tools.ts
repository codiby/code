/**
 * Proactivity tools on the `codiby-code` MCP server:
 *   notify_user (every session) · schedule_reminder, list_reminders,
 *   cancel_reminder (the agent session only).
 */

import { loadAgentConfig } from '../config';
import { registerToolGroup } from '../registry';
import { AGENT_SESSION_ID } from '../session';
import { jsonResult, textResult } from '../tools';
import type { AgentTool, CallToolResult, OutboundPriority, ToolContext } from '../types';
import { activeManagedKind } from './heartbeat';
import { notifyOwner, type NotifyOrigin } from './notify';
import { cancelReminder, listReminders, ReminderError, scheduleReminder, type ReminderView } from './reminders';
import { formatLocal } from './time';

const MAX_NOTIFY_TEXT = 4_000;
const MAX_TITLE = 120;

const PRIORITY = {
  type: 'string',
  enum: ['low', 'normal', 'urgent'],
  description: 'low = nice to know (held until quiet hours end) · normal = default (silent during quiet hours) · urgent = cannot wait (always rings, on every channel).',
};

const TOOLS: AgentTool[] = [
  {
    name: 'notify_user',
    scope: 'all',
    description: [
      'Send a message to the owner right now on their chat apps (Telegram/WhatsApp) and phone, without being asked.',
      'Use it for something they need to know or act on: a long task finished or failed, a decision only they can make, something time-sensitive.',
      'Keep it to a few lines. Quiet hours apply: low waits until they end, normal arrives silently, urgent always rings.',
      'Returns where it was delivered.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message, plain text or light Markdown.' },
        title: { type: 'string', description: 'Optional short heading (shown in bold, and as the push title).' },
        priority: PRIORITY,
        channelId: { type: 'string', description: 'Optional channel id to deliver on (see channels_status). Omit to let the agent pick the owner\'s preferred channel.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'schedule_reminder',
    scope: 'agent',
    description: [
      'Schedule a reminder for the owner. Give exactly one of: `at` (ISO-8601, ideally with offset, e.g. "2026-11-12T09:30:00-06:00"), `inMinutes`, or `cron` (5-field, recurring).',
      'mode "message" (default) sends `text` to the owner verbatim at that time — no thinking, so write the final wording now.',
      'mode "task" wakes you at that time with `text` as your instructions (e.g. "check the flight status and tell the owner if it changed").',
      'Times without an offset, and cron expressions, are read in the agent\'s timezone unless you pass `timezone`.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to send (mode "message") or what to do (mode "task").' },
        at: { type: 'string', description: 'When, ISO-8601. Include the offset; without one it is read in `timezone`.' },
        inMinutes: { type: 'number', description: 'Alternatively: minutes from now.' },
        cron: { type: 'string', description: 'Alternatively: a recurring 5-field cron, e.g. "0 9 * * 1" (Mondays 09:00).' },
        timezone: { type: 'string', description: 'IANA zone for `cron` and offset-less `at`. Defaults to the agent\'s timezone.' },
        mode: { type: 'string', enum: ['message', 'task'], description: 'Default "message".' },
        priority: PRIORITY,
      },
      required: ['text'],
    },
  },
  {
    name: 'list_reminders',
    scope: 'agent',
    description: 'List the reminders you scheduled, soonest first. Pass includeDone to also see ones that already fired, were missed or failed.',
    inputSchema: {
      type: 'object',
      properties: {
        includeDone: { type: 'boolean', description: 'Also list reminders that already fired. Default false.' },
      },
    },
  },
  {
    name: 'cancel_reminder',
    scope: 'agent',
    description: 'Cancel a reminder by the id list_reminders or schedule_reminder returned (looks like "aut_…").',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Reminder id.' } },
      required: ['id'],
    },
  },
];

/** A malformed argument the model can fix from the message alone. */
class InvalidArgs extends Error {}

/** Tool arguments come from a model: blank strings and nulls mean "not given". */
function given(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && !value.trim());
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (!given(value)) return undefined;
  if (typeof value !== 'string') throw new InvalidArgs(`\`${field}\` must be a string.`);
  const text = value.trim();
  if (text.length > max) throw new InvalidArgs(`\`${field}\` is limited to ${max} characters.`);
  return text;
}

function priorityArg(value: unknown): OutboundPriority | undefined {
  if (!given(value)) return undefined;
  if (value === 'low' || value === 'normal' || value === 'urgent') return value;
  throw new InvalidArgs('`priority` must be "low", "normal" or "urgent".');
}

function originFor(ctx: ToolContext): NotifyOrigin {
  if (ctx.sessionId !== AGENT_SESSION_ID) return 'tool';
  switch (activeManagedKind(ctx.sessionId)) {
    case 'heartbeat': return 'heartbeat';
    case 'morning_brief': return 'brief';
    case 'reminder': return 'reminder';
    default: return 'tool';
  }
}

function whenOf(r: ReminderView): string {
  if (r.schedule === 'cron') {
    const next = r.nextRunAt ? `, next ${formatLocal(r.nextRunAt, r.timezone)}` : '';
    return `every "${r.cron}" (${r.timezone})${next}`;
  }
  return r.at ? `at ${r.at}` : 'unscheduled';
}

function describeReminder(r: ReminderView): string {
  const flags = [r.mode === 'task' ? 'task' : null, r.priority !== 'normal' ? r.priority : null, r.status !== 'scheduled' ? r.status : null]
    .filter(Boolean).join(', ');
  return `${r.id}  ${whenOf(r)}${flags ? `  [${flags}]` : ''}\n  ${r.text.replace(/\s+/g, ' ').slice(0, 300)}`;
}

async function notifyUser(args: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  const text = optionalString(args.text, 'text', MAX_NOTIFY_TEXT);
  if (!text) return textResult('`text` is required.', true);
  const result = await notifyOwner({
    text,
    title: optionalString(args.title, 'title', MAX_TITLE),
    priority: priorityArg(args.priority),
    channelId: optionalString(args.channelId, 'channelId', 200) ?? null,
    sessionId: ctx.sessionId,
    sessionName: ctx.sessionName,
    origin: originFor(ctx),
  });
  const tz = loadAgentConfig().persona.timezone;
  const summary = {
    delivered: `Delivered to ${result.deliveredTo.join(', ')}${result.quiet ? ' silently (quiet hours)' : ''}.`,
    queued: `Held until ${result.queuedUntil ? formatLocal(result.queuedUntil, tz) : 'quiet hours end'} (low priority during quiet hours); it will be sent then.`,
    push_only: `No chat channel reached the owner (${result.error}); a push notification was raised if push is set up.`,
    limited: result.error ?? 'Daily limit reached; not sent.',
  }[result.status];
  return jsonResult({ ...result, summary });
}

async function execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  try {
    switch (name) {
      case 'notify_user':
        return await notifyUser(args, ctx);
      case 'schedule_reminder': {
        const mode = given(args.mode) ? args.mode : undefined;
        if (mode !== undefined && mode !== 'message' && mode !== 'task') throw new InvalidArgs('`mode` must be "message" or "task".');
        const reminder = scheduleReminder({
          text: typeof args.text === 'string' ? args.text : '',
          at: given(args.at) ? String(args.at) : undefined,
          inMinutes: given(args.inMinutes) ? Number(args.inMinutes) : undefined,
          cron: given(args.cron) ? String(args.cron) : undefined,
          timezone: optionalString(args.timezone, 'timezone', 64),
          mode,
          priority: priorityArg(args.priority),
          createdBy: { sessionId: ctx.sessionId, sessionName: ctx.sessionName },
        });
        return textResult(`Scheduled ${reminder.mode === 'task' ? 'task ' : ''}reminder ${describeReminder(reminder)}`);
      }
      case 'list_reminders': {
        const list = listReminders({ includeDone: args.includeDone === true, limit: 100 });
        if (!list.length) return textResult(args.includeDone === true ? 'No reminders.' : 'No upcoming reminders.');
        return textResult(list.map(describeReminder).join('\n'));
      }
      case 'cancel_reminder': {
        const id = optionalString(args.id, 'id', 200);
        if (!id) return textResult('`id` is required.', true);
        return cancelReminder(id)
          ? textResult(`Cancelled reminder ${id}.`)
          : textResult(`No reminder with id ${id} (list_reminders shows the ids).`, true);
      }
      default:
        return textResult(`Unknown tool ${name}`, true);
    }
  } catch (err) {
    if (err instanceof ReminderError || err instanceof InvalidArgs) return textResult(err.message, true);
    throw err;
  }
}

registerToolGroup({ id: 'proactive', tools: () => TOOLS, execute });
