/**
 * Agent tools on the `codiby-code` MCP server (works for every provider).
 * mcp/mcp.ts lists `listAgentToolsFor(sessionId)` and routes calls through
 * `executeAgentTool`; the scope check is repeated at call time because the
 * peer endpoint and localhost callers can claim any session id.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { logError } from '../lib/logger';
import { isAgentEnabled } from './config';
import { listToolGroups } from './registry';
import { AGENT_SESSION_ID } from './session';
import type { AgentTool, AgentToolGroup, ToolContext } from './types';

function visible(tool: AgentTool, sessionId: string): boolean {
  if (tool.scope === 'all') return true;
  return sessionId === AGENT_SESSION_ID && isAgentEnabled();
}

/** MCP tool definitions for the tools/list response. */
export function listAgentToolsFor(sessionId: string): { name: string; description: string; inputSchema: AgentTool['inputSchema'] }[] {
  const out: { name: string; description: string; inputSchema: AgentTool['inputSchema'] }[] = [];
  for (const group of listToolGroups()) {
    let tools: AgentTool[] = [];
    try { tools = group.tools(); } catch (err) { logError(`[agent] tool group ${group.id} failed to list: ${err}`); }
    for (const t of tools) {
      if (visible(t, sessionId)) out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
    }
  }
  return out;
}

function findTool(name: string): { group: AgentToolGroup; tool: AgentTool } | null {
  for (const group of listToolGroups()) {
    let tools: AgentTool[] = [];
    try { tools = group.tools(); } catch { continue; }
    const tool = tools.find(t => t.name === name);
    if (tool) return { group, tool };
  }
  return null;
}

export function isAgentTool(name: string): boolean {
  return findTool(name) !== null;
}

export async function executeAgentTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  const found = findTool(name);
  if (!found) return { content: [{ type: 'text', text: `Unknown agent tool ${name}` }], isError: true };
  if (!visible(found.tool, ctx.sessionId)) {
    return { content: [{ type: 'text', text: `${name} is only available to the Codiby agent session.` }], isError: true };
  }
  try {
    return await found.group.execute(name, args ?? {}, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[agent] tool ${name} failed: ${message}`);
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

/** Convenience for tool implementations. */
export function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
