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
import { homedir } from 'os';
import { dirname, extname, join } from 'path';
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

// HTML mockups are written to disk under ~/.codiby/mockups/<sessionId>/<name>.html
// so they survive a bridge restart. The in-memory map mirrors disk for fast
// reads and to keep the iframe-broadcast hot path synchronous; on miss we fall
// back to disk and rehydrate.
const MOCKUPS_ROOT = join(homedir(), '.codiby', 'mockups');
const mockupStore = new Map<string, Map<string, string>>();
function mockupsFor(sessionId: string): Map<string, string> {
  let m = mockupStore.get(sessionId);
  if (!m) { m = new Map(); mockupStore.set(sessionId, m); }
  return m;
}

/**
 * Strip path separators / dot-traversal / control chars so a model-supplied
 * mockup name can't escape the per-session mockup directory. Returns null
 * when the name has nothing usable left.
 */
function sanitizeMockupName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return null;
  if (name === '.' || name === '..') return null;
  // Allow letters, digits, dot, dash, underscore, space — nothing that could
  // mean "directory" or "parent" on either POSIX or Windows.
  if (!/^[A-Za-z0-9._\- ]{1,80}$/.test(name)) return null;
  return name;
}

function mockupFilePath(sessionId: string, name: string): string {
  return join(MOCKUPS_ROOT, sessionId, `${name}.html`);
}

async function persistMockup(sessionId: string, name: string, html: string): Promise<void> {
  const file = mockupFilePath(sessionId, name);
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, html, 'utf-8');
}

/** Read mockup html, preferring the in-memory copy and falling back to disk.
 *  On a disk hit the value is rehydrated into memory so subsequent reads are
 *  cheap. Returns null when the mockup doesn't exist anywhere. */
async function loadMockup(sessionId: string, name: string): Promise<string | null> {
  const mem = mockupsFor(sessionId).get(name);
  if (mem != null) return mem;
  try {
    const html = await fs.readFile(mockupFilePath(sessionId, name), 'utf-8');
    mockupsFor(sessionId).set(name, html);
    return html;
  } catch {
    return null;
  }
}

async function listPersistedMockups(sessionId: string): Promise<string[]> {
  try {
    const dir = join(MOCKUPS_ROOT, sessionId);
    const files = await fs.readdir(dir);
    return files.filter(f => f.endsWith('.html')).map(f => f.slice(0, -5));
  } catch {
    return [];
  }
}

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
      tool(
        'mockup_write',
        'Create or replace an HTML mockup and open it in the live preview side-panel. Use when the user asks for a UI mockup, sketch, or "mock up X" — you author a self-contained HTML document (inline CSS/JS, no external assets unless from a CDN) and it renders in a sandboxed iframe next to the chat. Replaces any existing mockup with the same `name`. Persisted to ~/.codiby/mockups/<sessionId>/<name>.html so it survives a bridge restart.',
        {
          name: z.string().min(1).max(80).describe('Identifier for this mockup (e.g. "chatbar", "settings-modal"). Letters, digits, dot, dash, underscore, space only — no slashes. Reuse the same name to update the same preview.'),
          html: z.string().min(1).describe('Full HTML document (start with <!doctype html>). Inline all CSS/JS — the iframe is sandboxed and cannot reach the parent. Network access works for CDN scripts/fonts.'),
        },
        async (args) => {
          const name = sanitizeMockupName(args.name);
          if (!name) {
            return { content: [{ type: 'text', text: `Invalid mockup name "${args.name}". Use letters, digits, dot, dash, underscore, or space (1–80 chars), no slashes.` }], isError: true };
          }
          mockupsFor(sessionId).set(name, args.html);
          try {
            await persistMockup(sessionId, name, args.html);
          } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            return { content: [{ type: 'text', text: `Mockup "${name}" rendered but failed to persist to disk: ${err}` }], isError: true };
          }
          deps.broadcastToSession(sessionId, {
            type: 'open_mockup',
            sessionId,
            name,
            html: args.html,
          });
          const sizeKb = Math.max(1, Math.round(Buffer.byteLength(args.html, 'utf8') / 1024));
          return { content: [{ type: 'text', text: `Mockup "${name}" rendered and saved (${sizeKb} KB).` }] };
        },
      ),
      tool(
        'mockup_edit',
        'Edit an existing HTML mockup by replacing a string, then re-render the live preview and rewrite the file on disk. Behaves like the standard Edit tool: `old_string` must occur exactly once unless `replace_all` is true. Use to iterate on a mockup created earlier with `mockup_write` without re-emitting the entire document. Falls back to ~/.codiby/mockups/<sessionId>/<name>.html when the in-memory copy was lost (e.g. after a bridge restart).',
        {
          name: z.string().min(1).max(80).describe('Name of the mockup to edit (must already exist on disk or in memory).'),
          old_string: z.string().min(1).describe('Exact substring to replace. Must match uniquely unless replace_all is true.'),
          new_string: z.string().describe('Replacement text (may be empty to delete).'),
          replace_all: z.boolean().optional().describe('Replace every occurrence instead of requiring uniqueness.'),
        },
        async (args) => {
          const name = sanitizeMockupName(args.name);
          if (!name) {
            return { content: [{ type: 'text', text: `Invalid mockup name "${args.name}".` }], isError: true };
          }
          const current = await loadMockup(sessionId, name);
          if (current == null) {
            return { content: [{ type: 'text', text: `Mockup "${name}" not found in memory or on disk. Create it with mockup_write first.` }], isError: true };
          }
          if (args.old_string === args.new_string) {
            return { content: [{ type: 'text', text: 'old_string and new_string are identical — nothing to do.' }], isError: true };
          }
          let next: string;
          let count: number;
          if (args.replace_all) {
            const parts = current.split(args.old_string);
            count = parts.length - 1;
            if (count === 0) {
              return { content: [{ type: 'text', text: `old_string not found in mockup "${name}".` }], isError: true };
            }
            next = parts.join(args.new_string);
          } else {
            const idx = current.indexOf(args.old_string);
            if (idx === -1) {
              return { content: [{ type: 'text', text: `old_string not found in mockup "${name}".` }], isError: true };
            }
            const second = current.indexOf(args.old_string, idx + args.old_string.length);
            if (second !== -1) {
              return { content: [{ type: 'text', text: `old_string is not unique in mockup "${name}" (matched at least twice). Pass replace_all: true or include more surrounding context.` }], isError: true };
            }
            next = current.slice(0, idx) + args.new_string + current.slice(idx + args.old_string.length);
            count = 1;
          }
          mockupsFor(sessionId).set(name, next);
          try {
            await persistMockup(sessionId, name, next);
          } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            return { content: [{ type: 'text', text: `Mockup "${name}" updated in memory but failed to persist to disk: ${err}` }], isError: true };
          }
          deps.broadcastToSession(sessionId, {
            type: 'open_mockup',
            sessionId,
            name,
            html: next,
          });
          return { content: [{ type: 'text', text: `Mockup "${name}" updated (${count} replacement${count === 1 ? '' : 's'}) and saved.` }] };
        },
      ),
      tool(
        'mockup_read',
        'Read the current HTML source of a mockup previously created with `mockup_write`. Useful before calling `mockup_edit` so you can see exactly what to target. Looks in memory first, then falls back to ~/.codiby/mockups/<sessionId>/<name>.html.',
        {
          name: z.string().min(1).max(80).describe('Name of the mockup to read.'),
        },
        async (args) => {
          const name = sanitizeMockupName(args.name);
          if (!name) {
            return { content: [{ type: 'text', text: `Invalid mockup name "${args.name}".` }], isError: true };
          }
          const html = await loadMockup(sessionId, name);
          if (html == null) {
            const inMem = [...mockupsFor(sessionId).keys()];
            const onDisk = await listPersistedMockups(sessionId);
            const available = [...new Set([...inMem, ...onDisk])].sort();
            const tail = available.length ? ` Available: ${available.join(', ')}.` : ' No mockups exist in this session yet.';
            return { content: [{ type: 'text', text: `Mockup "${name}" not found.${tail}` }], isError: true };
          }
          return { content: [{ type: 'text', text: html }] };
        },
      ),
      // Plugin-contributed SDK tools — already prefixed with `<pluginId>_`
      // and built with the bridge's installed `tool()`/`z` so they're
      // shape-compatible with the built-ins above.
      ...getPluginSdkToolDefs(),
    ],
  });
}
