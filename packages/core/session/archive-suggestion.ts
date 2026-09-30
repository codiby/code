/**
 * `suggest_archive` — the agent's way of saying "this task looks done".
 *
 * The tool itself does nothing on the bridge: the UI reads the call straight
 * out of the transcript and shows a small "Archive" pill above the composer
 * until the user archives, dismisses it, or keeps talking. Keeping it
 * stateless means a reload, a second window or a floating bubble all see the
 * same suggestion without any extra sync.
 *
 * Shared by the in-process SDK server (`suggest_archive`) and the HTTP one
 * (`ui_suggest_archive`) so both describe it the same way.
 */

export const SUGGEST_ARCHIVE_DESCRIPTION = [
  'Suggest to the user that this session can be archived because its task is finished. Shows a small, dismissible "Archive" pill above the chat composer — it never archives anything by itself.',
  '',
  'Call it at the END of the turn that completes the task, only when ALL of these hold:',
  '- What the user asked for is done and verified (tests pass, PR opened, deploy confirmed, question fully answered).',
  '- Nothing is left for the user to decide, review or answer in this session.',
  '',
  'Do NOT call it on greetings, clarifying questions, in the middle of a plan, after a failure, or when you just asked the user something. Call it at most once per task; if the user keeps working in the session after a suggestion, wait until the new work is done too.',
].join('\n');

export const SUGGEST_ARCHIVE_REASON =
  'Why the task looks done, in one short clause the user can glance at (≤ 120 chars), e.g. "PR #318 opened, tests green". Same language as the conversation.';
