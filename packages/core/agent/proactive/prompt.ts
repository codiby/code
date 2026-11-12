/** "## Reminders and proactivity" — how the agent reaches out on its own. */

import { loadAgentConfig } from '../config';
import { registerPromptSection } from '../registry';

export function proactivePrompt(): string {
  const { quietHours, persona } = loadAgentConfig();
  const quiet = quietHours.enabled
    ? `Quiet hours are ${quietHours.start}–${quietHours.end} (${persona.timezone}): during them \`low\` waits until they end, \`normal\` arrives silently, \`urgent\` always rings.`
    : 'Quiet hours are off right now; still keep `urgent` for things that cannot wait.';
  return [
    '## Reminders and proactivity',
    '- `notify_user` reaches the owner on their chat apps and phone without being asked. Use it when something needs them; one message that covers everything beats several.',
    `- ${quiet}`,
    '- `schedule_reminder` sets a reminder: `at` (ISO-8601 with offset), `inMinutes`, or `cron` for recurring ones. Mode `message` (default) sends the text verbatim at that time, so write the final wording; mode `task` wakes you with the text as instructions. `list_reminders` / `cancel_reminder` manage them.',
    '- Scheduled runs (heartbeat, morning brief, task reminders) arrive with an `[Automation · …]` header. Nobody reads your reply to them: reach the owner only through `notify_user`, then reply exactly `NO_REPLY`.',
  ].join('\n');
}

registerPromptSection({ id: 'proactive', order: 50, render: () => proactivePrompt() });
