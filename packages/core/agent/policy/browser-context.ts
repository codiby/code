/**
 * What the agent's transcript says about its browser previews: the last URL
 * it opened in each, and the snapshot line for an element ref. Browser
 * action tools only carry a preview name and a ref (`e12`), so without this
 * the purchase heuristic would have nothing to look at.
 *
 * Read-only over in-memory session state; safe for the preview phase.
 */

import { getSessionState, type ChatMessage } from '../../session/state';
import type { BrowserLookup } from './classify';

const WINDOW = 400;

const isBrowserTool = (m: ChatMessage, suffix: string) => !!m.toolName && !m.isToolResult && (m.toolName === suffix || m.toolName.endsWith(`__${suffix}`));

function inputOf(m: ChatMessage): Record<string, unknown> {
  return m.toolInput && typeof m.toolInput === 'object' ? (m.toolInput as Record<string, unknown>) : {};
}

export function browserLookup(sessionId: string): BrowserLookup {
  const recent = () => {
    const msgs = getSessionState(sessionId).messages;
    return msgs.slice(Math.max(0, msgs.length - WINDOW));
  };
  return {
    pageUrl(name) {
      const msgs = recent();
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]!;
        if (!isBrowserTool(m, 'browser_open') && !isBrowserTool(m, 'browser_navigate')) continue;
        const input = inputOf(m);
        if (input.name === name && typeof input.url === 'string' && input.url) return input.url;
      }
      return null;
    },
    refLabel(name, ref) {
      const msgs = recent();
      const browserUses = new Map<string, Record<string, unknown>>();
      for (const m of msgs) {
        if (m.toolName && !m.isToolResult && /(^|__)browser_/.test(m.toolName)) browserUses.set(m.id, inputOf(m));
      }
      const marker = `[ref=${ref}]`;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]!;
        if (!m.isToolResult || !m.toolUseId) continue;
        const use = browserUses.get(m.toolUseId);
        if (!use || use.name !== name || !m.content.includes(marker)) continue;
        const line = m.content.split('\n').find(l => l.includes(marker));
        return line ? line.trim().slice(0, 200) : null;
      }
      return null;
    },
  };
}
