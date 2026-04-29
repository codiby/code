/**
 * In-process SDK MCP server — tools that run inside the bridge process
 * with direct access to session state (no HTTP hop). Built per-session so
 * each tool closure captures the session id it belongs to.
 *
 * Add more tools here by appending to the `tools` array in
 * `buildSessionSdkMcpServer`.
 */

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { extname } from 'path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { addMessage } from '../state';
import type { ChatMessage } from '../state';
import { sessions, saveSessions } from '../sessions';
import { getSdkToolDefs as getPluginSdkToolDefs } from '../plugin-host';

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export type SdkToolDeps = {
  broadcastToSession: (sessionId: string, msg: object) => void;
  broadcastSessionList: () => void;
};

export function buildSessionSdkMcpServer(sessionId: string, deps: SdkToolDeps) {
  return createSdkMcpServer({
    name: 'codiby-code-sdk',
    version: '1.0.0',
    tools: [
      tool(
        'open_file_in_editor',
        'Open a file in the editor side-panel of Codiby Code. Use when the user would benefit from reviewing a file inline alongside the chat. Optional `line` jumps to a specific line.',
        {
          path: z.string().describe('Absolute path of the file to open.'),
          line: z.number().int().positive().optional().describe('1-based line number to jump to.'),
        },
        async (args) => {
          deps.broadcastToSession(sessionId, {
            type: 'open_file',
            sessionId,
            path: args.path,
            line: args.line ?? null,
          });
          const where = args.line != null ? `${args.path}:${args.line}` : args.path;
          return { content: [{ type: 'text', text: `Opened ${where} in the side editor.` }] };
        },
      ),
      tool(
        'rename_session',
        [
          'Rename the current Codiby Code session (the chat tab the user is interacting with). The new name appears in the tab bar and session list.',
          '',
          'CALL EXACTLY ONCE per session. Treat this as a one-shot decision: pick the name that will best identify the work for the rest of the conversation. Do not call again afterwards even if the work evolves — the user can rename manually if they want.',
          '',
          'WHEN to call: immediately after the first user message, every session — no exceptions. This includes greetings ("hi", "hello"), chitchat, vague one-liners, and clarifying questions. Do NOT skip the rename because the message seems low-stakes; derive the best name you can from whatever was said (e.g. "Greeting", "Quick Question"). The user can rename manually later if it turns out wrong.',
          '',
          'NAME must fit a narrow sidebar tab. Keep it SHORT — aim for ≤ 24 characters total. Format: "{TICKET-ID} {VERY SHORT DESCRIPTION}".',
          '- {TICKET-ID}: ticket/issue identifier mentioned by the user (e.g. "ENG-1234"). Omit entirely if no ticket — do not invent placeholders.',
          '- {VERY SHORT DESCRIPTION}: 3-4 words max, Title Case, no trailing punctuation, no quotes.',
          '',
          'Examples:',
          '- "ENG-1234 Fix Login Redirect"',
          '- "PROJ-42 Stripe Webhook"',
          '- "Refactor Auth Middleware" (no ticket mentioned)',
        ].join('\n'),
        {
          name: z.string().min(1).max(60).describe('New session name. Aim for ≤ 24 chars so it fits a narrow tab. Format: "{TICKET-ID} {SHORT DESCRIPTION, 3-4 WORDS MAX}". Omit ticket id if none was mentioned.'),
        },
        async (args) => {
          const session = sessions.get(sessionId);
          if (!session) {
            return { content: [{ type: 'text', text: `Session ${sessionId} not found.` }], isError: true };
          }
          const previous = session.name;
          const next = args.name.trim();
          if (!next) {
            return { content: [{ type: 'text', text: 'Name cannot be empty or whitespace.' }], isError: true };
          }
          session.name = next;
          saveSessions();
          deps.broadcastSessionList();
          return { content: [{ type: 'text', text: `Renamed session from "${previous}" to "${next}".` }] };
        },
      ),
      tool(
        'post_system_note',
        "Post a non-model system note into the session's chat log (separator-style). Use sparingly for status updates the user should see (e.g. \"Deployed commit abc123\"). Not visible to the model in future turns.",
        {
          content: z.string().min(1).max(500).describe('Short note text (<= 500 chars).'),
        },
        async (args) => {
          const msg: ChatMessage = {
            id: randomUUID(),
            role: 'system',
            content: args.content,
            timestamp: Date.now(),
          };
          if (addMessage(sessionId, msg)) {
            deps.broadcastToSession(sessionId, { type: 'message', sessionId, message: msg });
          }
          return { content: [{ type: 'text', text: `Posted note: ${args.content}` }] };
        },
      ),
      tool(
        'post_image_to_session',
        "Post an image into the session's chat log so the user can see it inline. Reads the file from a local absolute path and embeds it as base64 — supported formats: PNG, JPEG, GIF, WebP. Use for screenshots, generated charts, or other visual artifacts you want to surface to the user. Not visible to the model in future turns.",
        {
          path: z.string().min(1).describe('Absolute path to an image file (.png, .jpg, .jpeg, .gif, or .webp).'),
          caption: z.string().max(500).optional().describe('Optional short caption shown beneath the image.'),
        },
        async (args) => {
          const mediaType = IMAGE_MEDIA_TYPES[extname(args.path).toLowerCase()];
          if (!mediaType) {
            return {
              content: [{ type: 'text', text: `Unsupported image extension for ${args.path}. Supported: .png, .jpg, .jpeg, .gif, .webp.` }],
              isError: true,
            };
          }
          let buf: Buffer;
          try {
            buf = await fs.readFile(args.path);
          } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            return { content: [{ type: 'text', text: `Failed to read image at ${args.path}: ${err}` }], isError: true };
          }
          const msg: ChatMessage = {
            id: randomUUID(),
            role: 'system',
            content: args.caption ?? '',
            timestamp: Date.now(),
            images: [{ media_type: mediaType, data: buf.toString('base64') }],
          };
          if (addMessage(sessionId, msg)) {
            deps.broadcastToSession(sessionId, { type: 'message', sessionId, message: msg });
          }
          const sizeKb = Math.max(1, Math.round(buf.length / 1024));
          const tail = args.caption ? ` — "${args.caption}"` : '';
          return { content: [{ type: 'text', text: `Posted ${mediaType} (${sizeKb} KB) from ${args.path}${tail}.` }] };
        },
      ),
      // Plugin-contributed SDK tools — already prefixed with `<pluginId>_`
      // and built with the bridge's installed `tool()`/`z` so they're
      // shape-compatible with the built-ins above.
      ...getPluginSdkToolDefs(),
    ],
  });
}
