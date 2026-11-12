/**
 * Headless browser (workstream 7) — the agent's side of the bridge's own
 * Chromium (packages/core/browser): the `browser_fill_secret` tool, the
 * "## Your browser" prompt section and the live-view routes.
 *
 * Imported for its side effects by agent/index.ts. The `browser_*` action
 * tools themselves live on the per-session SDK server (provider/sdk-tools.ts)
 * and are routed to this browser by provider/browser-cdp.ts.
 */

import { headlessPage } from '../../provider/browser-cdp';
import { registerPromptSection, registerRoutes, registerToolGroup } from '../registry';
import { textResult } from '../tools';
import { getSecretJson } from '../vault';
import { FILL_SECRET_TOOL, fillSecret, type FillSecretDeps, type SiteLogin } from './fill-secret';
import { browserPromptSection } from './prompt';
import { browserRoutes } from './routes';

const fillSecretDeps: FillSecretDeps = {
  getLogin: (secretName) => getSecretJson<SiteLogin>(secretName),
  page: (sessionId, name) => headlessPage(sessionId, name),
};

registerToolGroup({
  id: 'browser',
  tools: () => [FILL_SECRET_TOOL],
  execute: async (name, args, ctx) => {
    if (name !== FILL_SECRET_TOOL.name) return textResult(`Unknown browser tool ${name}`, true);
    return fillSecret(args, ctx, fillSecretDeps);
  },
});

registerPromptSection(browserPromptSection);
registerRoutes(browserRoutes);

export {};
