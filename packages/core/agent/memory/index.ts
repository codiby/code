/**
 * Memory and identity (workstream 4): remember/recall/forget, the people
 * directory, the owner-knowledge prompt section, consolidation before every
 * thread rotation, and the daily fresh start.
 *
 * Imported for its side effects by agent/index.ts. Everything plugs in through
 * ../registry — routes and tools are available as soon as this loads (so the
 * Agent view works while the agent is off); the daily timer only runs while
 * the agent is enabled on this host.
 */

import {
  addInboundInterceptor,
  onAgentStart,
  onAgentStop,
  onBeforeThreadRotate,
  registerPromptSection,
  registerToolGroup,
} from '../registry';
import { consolidateBeforeRotate } from './consolidation';
import { holdWhileRotating, startDailyRotation, stopDailyRotation } from './rotation';
import { renderMemorySection } from './section';
import { memoryToolGroup } from './tools';
import './routes';

registerToolGroup(memoryToolGroup);

registerPromptSection({
  id: 'memory',
  order: 20,
  render: () => renderMemorySection(),
});

onBeforeThreadRotate(async ({ reason }) => {
  await consolidateBeforeRotate(reason);
});

let holdInstalled = false;

onAgentStart('memory', () => {
  // Installed at start rather than at import so it runs after the interceptors
  // other areas register at import time (commands, approval codes). It never
  // consumes a message — it only delays one until a rotation finishes.
  if (!holdInstalled) {
    holdInstalled = true;
    addInboundInterceptor(async env => {
      await holdWhileRotating(env.text);
      return false;
    });
  }
  startDailyRotation();
});
onAgentStop('memory', () => stopDailyRotation());

export { MEMORY_TOOL_NAMES } from './tools';
// For channels: put a name on an inbound sender (findPersonByHandle) or
// resolve "message Ana" to a handle (findPeople).
export { findPeople, findPersonByHandle, HANDLE_CHANNELS, type HandleChannel, type Person, type PersonHandles } from './people';
export { phoneToWhatsAppJid, normalizeWhatsAppHandle, normalizePhone } from './phone';
