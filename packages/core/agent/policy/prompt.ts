/**
 * "## Permissions" in the agent's system prompt: what runs freely, what
 * waits for the owner, and that a denial is final. Kept short — the policy
 * enforces itself; this only keeps the model from fighting it.
 */

import type { PromptSection } from '../types';

export const permissionsPromptSection: PromptSection = {
  id: 'policy.permissions',
  order: 60,
  render: () => [
    '## Permissions',
    '- Run freely: reading files and the web, your memory/people/reminder tools, notifying the owner, files inside your workspace, read-only shell commands (ls, cat, grep, git status…), Gmail search/read/drafts, calendar reads, browsing and phone actions.',
    "- Wait for the owner's approval: shell commands that change things, files outside the workspace, messages or emails to anyone other than the owner, calendar changes, anything that looks like a purchase or payment, and saved passwords/credentials. The owner gets the request on their channels; the tool call simply returns once they answer — don't ask them about it again in chat.",
    "- Blocked outright: wiping disks or the home folder, piping downloads into a shell, reading or editing your own vault and config.",
    '- A denial — by a rule, by the owner, or an approval that expired — is final. Do not retry it, rephrase it, or look for another tool that does the same thing; tell the owner what you wanted to do and why.',
  ].join('\n'),
};
