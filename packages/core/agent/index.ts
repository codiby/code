/**
 * Codiby Agent — entry point.
 *
 * Importing this module registers every area (routes, tools, prompt
 * sections, channels) so the UI can configure them even while the agent is
 * disabled. `startAgent` wires the runtime and, when the agent is enabled on
 * this host, creates its session and runs each area's start hooks.
 */

import { existsSync } from 'fs';
import { log } from '../lib/logger';
import { isAgentEnabled, loadAgentConfig, saveAgentConfig } from './config';
import { primeDispatch } from './dispatch';
import { syncAgentLifecycle } from './registry';
import { configureAgentRuntime } from './runtime';
import { ensureAgentSession } from './session';
import { agentDataDir } from './store';
import type { AgentDeps } from './types';

import './routes';
import './retention';
import './channels';
import './proactive';
import './policy';
import './memory';
import './google';
import './push';
import './browser';

export { handleAgentRoute } from './routes';
export { listAgentToolsFor, isAgentTool, executeAgentTool } from './tools';
export { agentSystemPrompt } from './prompt';
export { handleAgentTurnComplete } from './dispatch';
export { evaluateAgentPolicy, emitApprovalRequested, emitApprovalResolved, emitAgentToolUse } from './registry';

let started = false;

export async function startAgent(deps: AgentDeps): Promise<void> {
  configureAgentRuntime(deps);
  // Persist first-boot defaults (derived from any legacy Telegram setup) so a
  // later Telegram change can't flip the agent on or off by surprise.
  if (!existsSync(agentDataDir('config.json'))) saveAgentConfig(loadAgentConfig());
  primeDispatch();
  if (started) return;
  started = true;
  if (!loadAgentConfig().enabled) {
    log('[agent] Disabled on this host — channels stay off (enable it in the Agent view)');
    return;
  }
  // Through the same queue as PUT /agent/config: the bridge already serves
  // requests, and an Agent view save during boot must wait for this start.
  await syncAgentLifecycle(isAgentEnabled, ensureAgentSession);
  log('[agent] Started');
}
