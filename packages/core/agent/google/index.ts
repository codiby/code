/**
 * Google (workstream 5): OAuth connection, Gmail and Calendar tools, the
 * "## Connections" prompt block, and the saved-logins vault routes used by
 * the browser area's `browser_fill_secret`.
 *
 * Imported for its side effects by agent/index.ts. Everything registers
 * through ../registry, so the bridge never imports this folder directly.
 */

import { logError } from '../../lib/logger';
import { registerPromptSection, registerRoutes, registerToolGroup } from '../registry';
import { textResult } from '../tools';
import type { AgentToolGroup, CallToolResult } from '../types';
import { GoogleApiError } from './api';
import { ToolInputError } from './args';
import { CALENDAR_HANDLERS, CALENDAR_TOOLS } from './calendar';
import { GMAIL_HANDLERS, GMAIL_TOOLS } from './gmail';
import { GoogleAuthError } from './oauth';
import { GOOGLE_ROUTES } from './routes';
import { SECRET_ROUTES } from './secrets';
import { renderConnectionsPrompt } from './status';

const HANDLERS = { ...GMAIL_HANDLERS, ...CALENDAR_HANDLERS };

/** Expected failures go back to the model as a fixable message; anything else is a bug and gets logged. */
async function runGoogleTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const handler = HANDLERS[name];
  if (!handler) return textResult(`Unknown Google tool ${name}`, true);
  try {
    return await handler(args);
  } catch (err) {
    if (err instanceof ToolInputError || err instanceof GoogleAuthError || err instanceof GoogleApiError) {
      return textResult(err.message, true);
    }
    logError(`[google] ${name} failed: ${err instanceof Error ? err.stack || err.message : err}`);
    return textResult(`${name} failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

export const googleToolGroup: AgentToolGroup = {
  id: 'google',
  tools: () => [...GMAIL_TOOLS, ...CALENDAR_TOOLS],
  execute: (name, args) => runGoogleTool(name, args),
};

registerRoutes([...GOOGLE_ROUTES, ...SECRET_ROUTES]);
registerToolGroup(googleToolGroup);
registerPromptSection({ id: 'connections', order: 40, render: () => renderConnectionsPrompt() });
