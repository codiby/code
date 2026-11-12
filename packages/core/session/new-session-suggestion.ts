/**
 * `suggest_new_session` — the agent's way of saying "this is new work, it
 * deserves its own session".
 *
 * Like `suggest_archive`, the tool does nothing on the bridge: the UI reads
 * the call out of the transcript and shows a card above the composer with
 * "Create session" (a sibling session seeded with `prompt`) and "Continue
 * here". Stateless, so a reload, a second window or the phone all see the
 * same card.
 *
 * Shared by the in-process SDK server (`suggest_new_session`) and the HTTP
 * one (`ui_suggest_new_session`) so both describe it the same way.
 */

export const SUGGEST_NEW_SESSION_DESCRIPTION = [
  'Offer to move a piece of NEW work into its own Codiby Code session. Shows a card above the chat composer with "Create session" and "Continue here" — it creates nothing by itself.',
  '',
  'Call it only at the moment the user commits to starting a distinct piece of work that is not what this session is about, e.g. the session is a tour of their tickets and they now say "let\'s start working on FEAT-H43". Signals that it is warranted:',
  '- The work is a task of its own (a ticket, a feature, a bug, a PR review) that will take several turns, edits or commands.',
  '- It differs from this session\'s purpose: a different ticket, repo or goal than the one this conversation was opened for.',
  '',
  'Do NOT call it for: questions or lookups (even about another ticket), follow-ups on the current task, small one-off actions, work the user explicitly asked to do here, or when this session was opened precisely for that work. When in doubt, do not call it. At most once per piece of work; if the user chose "Continue here", do not offer again for it.',
  '',
  'After calling it, END YOUR TURN with one short sentence (e.g. "I can open a new session for this, or we continue here."). Do not start the work in the same turn: the user\'s choice decides where it happens.',
].join('\n');

export const SUGGEST_NEW_SESSION_TITLE =
  'Name for the new session (≤ 40 chars), in the session-naming format: "{TICKET-ID} {3-4 word Title Case description}", ticket id omitted when there is none.';

export const SUGGEST_NEW_SESSION_REASON =
  'Why this deserves its own session, one short clause shown on the card (≤ 120 chars), e.g. "Implementing FEAT-H43 is separate from reviewing your board". Same language as the conversation.';

export const SUGGEST_NEW_SESSION_PROMPT = [
  'First message the new session starts with, written to the agent that will do the work (≤ 1500 chars, same language as the conversation).',
  'Only the essentials it cannot find on its own: the goal in one or two sentences, identifiers (ticket id, PR, branch, repo), decisions or constraints the user stated here, and where to start. No transcript, no restating what tools or docs will show it.',
].join(' ');

export const SUGGEST_NEW_SESSION_CWD =
  'Absolute folder to open the new session in, on the same host. Omit to use this session\'s folder.';
