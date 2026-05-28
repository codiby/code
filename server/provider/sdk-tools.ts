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

import { log } from '../logger';
import { addMessage } from '../state';
import type { ChatMessage } from '../state';
import { sessions, saveSessions } from '../sessions';
import { getSdkToolDefs as getPluginSdkToolDefs } from '../plugin-host';
import { cdpRequest } from './browser-cdp';
import { trackedProcesses, killTrackedProcess, saveProcessRegistry, appendProcessOutput, addToGraveyard } from '../handlers/processes';
import { spawnPty } from '../pty';
import type { TrackedProcess } from '../types';
import { emitPortlessActionFired, emitPortlessUrlResolved, extractPortlessUrl, getPortlessCliStatus } from '../portless';

/** Resolve a tracked process for the current session by procId OR name. */
function resolveTrackedProcess(
  sessionId: string,
  args: { procId?: string; name?: string },
): { ok: true; tp: TrackedProcess } | { ok: false; error: string } {
  if (!args.procId && !args.name) {
    return { ok: false, error: 'Provide either `procId` or `name`.' };
  }
  if (args.procId) {
    const tp = trackedProcesses.get(args.procId);
    if (!tp || tp.sessionId !== sessionId) {
      return { ok: false, error: `No terminal with procId "${args.procId}" found in this session.` };
    }
    return { ok: true, tp };
  }
  const wanted = (args.name || '').trim().toLowerCase();
  const matches: TrackedProcess[] = [];
  for (const candidate of trackedProcesses.values()) {
    if (candidate.sessionId !== sessionId) continue;
    if ((candidate.label || '').toLowerCase() === wanted) matches.push(candidate);
  }
  if (matches.length === 0) {
    const known = [...trackedProcesses.values()]
      .filter(t => t.sessionId === sessionId && t.label)
      .map(t => `"${t.label}"`);
    const tail = known.length ? ` Known in this session: ${known.join(', ')}.` : ' No labelled terminals exist in this session yet.';
    return { ok: false, error: `No terminal with name "${args.name}" found.${tail}` };
  }
  matches.sort((a, b) => b.startedAt - a.startedAt);
  return { ok: true, tp: matches[0]! };
}

export const IMAGE_MEDIA_TYPES: Record<string, string> = {
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
export function mockupsFor(sessionId: string): Map<string, string> {
  let m = mockupStore.get(sessionId);
  if (!m) { m = new Map(); mockupStore.set(sessionId, m); }
  return m;
}

/**
 * Strip path separators / dot-traversal / control chars so a model-supplied
 * mockup name can't escape the per-session mockup directory. Returns null
 * when the name has nothing usable left.
 */
export function sanitizeMockupName(raw: string): string | null {
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

export async function persistMockup(sessionId: string, name: string, html: string): Promise<void> {
  const file = mockupFilePath(sessionId, name);
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, html, 'utf-8');
}

/** Read mockup html, preferring the in-memory copy and falling back to disk.
 *  On a disk hit the value is rehydrated into memory so subsequent reads are
 *  cheap. Returns null when the mockup doesn't exist anywhere. */
export async function loadMockup(sessionId: string, name: string): Promise<string | null> {
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

export async function listPersistedMockups(sessionId: string): Promise<string[]> {
  try {
    const dir = join(MOCKUPS_ROOT, sessionId);
    const files = await fs.readdir(dir);
    return files.filter(f => f.endsWith('.html')).map(f => f.slice(0, -5));
  } catch {
    return [];
  }
}

// Live browser previews — keyed by session and per-session by a model-supplied
// `name` (e.g. "qa-admin-workflow"). Multiple browsers can co-exist in a
// single session so the agent can drive, say, the admin tab and the public
// landing page in parallel. No disk persistence — URLs are cheap to re-issue.
//
// The store exists so the HTTP `ui_browser_*` and SDK `browser_*` tools
// share the same in-memory snapshot. Action tools (snapshot / click / fill /
// scroll / etc.) look up `(sessionId, name)` to confirm the target preview
// is open before round-tripping a CDP request through the desktop frontend.
export type BrowserPreview = { url: string; title?: string; cookieJar?: string };
const browserStore = new Map<string, Map<string, BrowserPreview>>();

export function getBrowserPreview(sessionId: string, name: string): BrowserPreview | null {
  return browserStore.get(sessionId)?.get(name) ?? null;
}
export function setBrowserPreview(sessionId: string, name: string, preview: BrowserPreview | null): void {
  if (preview) {
    let m = browserStore.get(sessionId);
    if (!m) { m = new Map(); browserStore.set(sessionId, m); }
    m.set(name, preview);
    return;
  }
  const m = browserStore.get(sessionId);
  if (!m) return;
  m.delete(name);
  if (m.size === 0) browserStore.delete(sessionId);
}
export function listBrowserPreviews(sessionId: string): Array<{ name: string; preview: BrowserPreview }> {
  const m = browserStore.get(sessionId);
  if (!m) return [];
  return [...m.entries()].map(([name, preview]) => ({ name, preview }));
}

/** Validate a model-supplied browser name. Kebab/snake-case, 1–40 chars,
 *  must start with letter/digit (so leading dash/underscore can't pollute
 *  the OS-level webview label). No spaces, no slashes — matches what the
 *  Electron `validateLabel` accepts since the underlying label becomes
 *  `browser-<sessionId>-<name>`. */
export function sanitizeBrowserName(raw: string): string | null {
  const name = (raw || '').trim();
  if (!name) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(name)) return null;
  return name;
}

/** Validate a model-supplied cookie-jar name. Same shape as a browser name
 *  (kebab/snake-case, 1–40 chars, must start with letter/digit) so the jar
 *  name passes the Electron-side partition validator. Falsy input maps to
 *  the shared "default" jar — every preview opened without an explicit jar
 *  shares the same cookie scope. */
export const DEFAULT_BROWSER_COOKIE_JAR = 'default';
export function sanitizeCookieJar(raw: string | undefined | null): string | null {
  const name = (raw || '').trim();
  if (!name) return DEFAULT_BROWSER_COOKIE_JAR;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(name)) return null;
  return name;
}

/** Validate a model-supplied URL: must parse, must be http/https. */
export function sanitizeBrowserUrl(raw: string): URL | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

// Shared Zod schema + error-response helpers for the browser_* action tools.
// Every action tool takes a `name` identifying which preview within the
// session to act on; the same validate-then-check preamble repeats 14 times.
const NAME_SCHEMA = z
  .string()
  .min(1)
  .max(40)
  .describe('The same `name` you passed to browser_open for the preview you want to act on (e.g. "qa-admin-workflow"). Letters/digits/dash/underscore only, 1–40 chars, must start with a letter or digit.');
function invalidName(raw: string) {
  return {
    content: [{ type: 'text' as const, text: `Invalid browser name "${raw}". Letters/digits/dash/underscore only, 1–40 chars, must start with a letter or digit.` }],
    isError: true,
  };
}
function notOpen(name: string) {
  return {
    content: [{ type: 'text' as const, text: `No browser preview named "${name}" is open in this session. Call browser_open with name="${name}" first.` }],
    isError: true,
  };
}

export type SdkToolDeps = {
  broadcastToSession: (sessionId: string, msg: object) => void;
  broadcastSessionList: () => void;
  /** Read the current ui-preferences.json blob. Used by the per-session
   *  resolution of `autoFocusBrowserOnAction` (global default + per-project
   *  override on the session's tab group). */
  loadPreferences: () => Record<string, unknown>;
};

/** Resolve the tab group the session belongs to (so portless tools can
 *  look up the project's configured actions). Returns null when the
 *  session isn't in any group. */
function resolveSessionGroup(sessionId: string, deps: SdkToolDeps): { groupId: string; group: any } | null {
  const prefs = deps.loadPreferences();
  const map = (prefs.tabGroupMap as Record<string, string> | undefined) || {};
  const groupId = map[sessionId];
  if (!groupId) return null;
  const groups = (prefs.tabGroups as Record<string, any> | undefined) || {};
  const group = groups[groupId];
  if (!group) return null;
  return { groupId, group };
}

/** Resolve whether action-style browser_* tools should bring the targeted
 *  preview to the front for this session. Per-project override (on the
 *  session's tab group) wins over the global default; if neither is set,
 *  defaults to `true`. */
function resolveAutoFocusBrowser(sessionId: string, deps: SdkToolDeps): boolean {
  const prefs = deps.loadPreferences();
  const map = (prefs.tabGroupMap as Record<string, string> | undefined) || {};
  const groupId = map[sessionId];
  if (groupId) {
    const groups = (prefs.tabGroups as Record<string, { autoFocusBrowserOnAction?: boolean }> | undefined) || {};
    const override = groups[groupId]?.autoFocusBrowserOnAction;
    if (typeof override === 'boolean') return override;
  }
  const global = prefs.autoFocusBrowserOnAction;
  if (typeof global === 'boolean') return global;
  return true;
}

/** Broadcast a `focus_browser` hint so the UI switches the active preview
 *  to the one the agent is about to act on. No-op when the resolved
 *  setting is false. The client ignores the hint if the preview isn't
 *  currently open in the session. */
function maybeFocusBrowser(sessionId: string, name: string, deps: SdkToolDeps): void {
  if (!resolveAutoFocusBrowser(sessionId, deps)) return;
  deps.broadcastToSession(sessionId, { type: 'focus_browser', sessionId, name });
}

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
      tool(
        'browser_open',
        [
          'Open an http(s) URL in a named browser preview tab inside Codiby Code. Each session can host many simultaneously-open previews — choose a stable `name` (kebab/snake-case, e.g. "qa-admin-workflow", "checkout-flow", "docs") and reuse the same `name` for every follow-up tool call against that preview.',
          '',
          'If a preview with this `name` is already open in the session, it just navigates that one to the new URL (state, cookies, scroll position, and authenticated cookies are preserved — only the page changes). Otherwise a new preview is opened.',
          '',
          'Cookie isolation is controlled by `cookieJar`: previews sharing the same jar name share cookies / localStorage / cache, and different jar names are completely isolated. Omitting `cookieJar` puts the preview in the shared "default" jar. Use distinct jars (e.g. "qa-testing", "admin-account") when you need a separate logged-in identity.',
          '',
          'Use when the user is iterating on a real running app: previewing their local dev server, reviewing how a deployed page looks, or driving multiple flows in parallel.',
        ].join('\n'),
        {
          name: z.string().min(1).max(40).describe('Stable identifier for this browser preview within the session. Letters/digits/dash/underscore only, 1–40 chars, must start with a letter or digit. Examples: "qa-admin-workflow", "checkout-flow", "docs". Reuse the same name across browser_* tools to drive the same preview.'),
          url: z.string().min(1).describe('Absolute http:// or https:// URL. localhost URLs are reachable as long as the bridge process can connect to them.'),
          title: z.string().max(120).optional().describe('Short label shown in the panel tab. Defaults to the `name`.'),
          cookieJar: z.string().min(1).max(40).optional().describe('Cookie jar name. Previews sharing the same jar share cookies/storage/cache; different jars are isolated. Letters/digits/dash/underscore only, 1–40 chars, must start with a letter or digit. Defaults to "default" when omitted.'),
        },
        async (args) => {
          const name = sanitizeBrowserName(args.name);
          if (!name) {
            return { content: [{ type: 'text', text: `Invalid browser name "${args.name}". Letters/digits/dash/underscore only, 1–40 chars, must start with a letter or digit. Example: "qa-admin-workflow".` }], isError: true };
          }
          const target = sanitizeBrowserUrl(args.url);
          if (!target) {
            return { content: [{ type: 'text', text: `Invalid URL "${args.url}". Must be an absolute http:// or https:// URL.` }], isError: true };
          }
          const cookieJar = sanitizeCookieJar(args.cookieJar);
          if (!cookieJar) {
            return { content: [{ type: 'text', text: `Invalid cookieJar "${args.cookieJar}". Letters/digits/dash/underscore only, 1–40 chars, must start with a letter or digit. Example: "qa-testing".` }], isError: true };
          }
          const title = (args.title || '').trim() || name;
          setBrowserPreview(sessionId, name, { url: target.toString(), title, cookieJar });
          deps.broadcastToSession(sessionId, {
            type: 'open_browser',
            sessionId,
            name,
            url: target.toString(),
            title,
            cookieJar,
          });
          return { content: [{ type: 'text', text: `Opened browser preview "${name}" (jar "${cookieJar}") → ${target.toString()}.` }] };
        },
      ),
      tool(
        'browser_close',
        'Close a named browser preview tab for the current session. The other previews stay open. No-op if the named preview wasn\'t open.',
        {
          name: z.string().min(1).max(40).describe('The `name` you passed to browser_open. The preview must still be open.'),
        },
        async (args) => {
          const name = sanitizeBrowserName(args.name);
          if (!name) {
            return { content: [{ type: 'text', text: `Invalid browser name "${args.name}".` }], isError: true };
          }
          const had = !!getBrowserPreview(sessionId, name);
          setBrowserPreview(sessionId, name, null);
          deps.broadcastToSession(sessionId, { type: 'close_browser', sessionId, name });
          return { content: [{ type: 'text', text: had ? `Closed browser preview "${name}".` : `No browser preview named "${name}" was open.` }] };
        },
      ),
      // ---------------------------------------------------------------------
      // Playwright-cli-equivalent browser automation tools. Each round-trips:
      //   bridge SDK tool → broadcastToSession('browser_request')
      //   → desktop frontend WS → window.codiby.invoke('cdp_<action>')
      //   → Electron main: webContents.debugger / CDP commands
      //   → frontend respondBrowserRequest → bridge resolves the promise.
      //
      // Every tool takes a `name` identifying which preview within the session
      // to act on (must match what was passed to `browser_open`). `ref`
      // parameters are the `eN` handles returned by the most recent
      // `browser_snapshot(name=…)` against the SAME `name`. Refs stale on the
      // next snapshot or navigation; call snapshot again to refresh.
      // Non-desktop viewers (browser, mobile PWA) don't service these — the
      // call times out with a clear error.
      // ---------------------------------------------------------------------
      // Shared schema fragment + error helpers — every action tool has the
      // same preamble: validate the name, confirm a preview is open under it.
      // Pulled out so descriptions stay terse instead of repeating the same
      // paragraph across 14 tools.
      tool(
        'browser_snapshot',
        [
          'Capture an accessibility snapshot of the named browser preview as an indented YAML tree. Each meaningful element gets a `[ref=eN]` handle that subsequent action tools (browser_click, browser_type, browser_hover, …) use to address it.',
          '',
          'Example output line: `- button "Submit" [ref=e23]`',
          '',
          'Refs are only valid until the next snapshot or page navigation — refresh by calling browser_snapshot again. Always snapshot before clicking/typing/hovering; never assume a ref from a stale read.',
          '',
          'Requires that browser_open(name=…) has already opened a preview with this `name` in the session.',
        ].join('\n'),
        {
          name: NAME_SCHEMA,
        },
        async (args) => {
          const name = sanitizeBrowserName(args.name);
          if (!name) return invalidName(args.name);
          if (!getBrowserPreview(sessionId, name)) return notOpen(name);
          try {
            const r = (await cdpRequest(sessionId, name, 'snapshot', {}, deps.broadcastToSession)) as { url: string; title: string; yaml: string };
            const head = `URL: ${r.url}\nTitle: ${r.title}\n\n`;
            return { content: [{ type: 'text', text: head + (r.yaml || '(empty accessibility tree)') }] };
          } catch (e) {
            return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
          }
        },
      ),
      tool(
        'browser_take_screenshot',
        'Capture a PNG screenshot of a named browser preview\'s viewport. Returns base64-encoded image data.',
        {
          name: NAME_SCHEMA,
        },
        async (args) => {
          const name = sanitizeBrowserName(args.name);
          if (!name) return invalidName(args.name);
          if (!getBrowserPreview(sessionId, name)) return notOpen(name);
          try {
            const r = (await cdpRequest(sessionId, name, 'take_screenshot', {}, deps.broadcastToSession)) as { format: string; data: string };
            return {
              content: [
                { type: 'text', text: `Captured ${r.format} screenshot of "${name}" (${Math.round(r.data.length / 1024)} KB base64).` },
                { type: 'image', data: r.data, mimeType: `image/${r.format}` },
              ],
            };
          } catch (e) {
            return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
          }
        },
      ),
      tool(
        'browser_click',
        'Click an element in a named browser preview, identified by a `ref` from the most recent browser_snapshot(name=…). Scrolls into view first, then calls `.click()` for plain left-clicks (works reliably even when the element is covered by an overlay). For right/middle/double clicks, dispatches synthetic mouse events at the element\'s centre.',
        {
          name: NAME_SCHEMA,
          ref: z.string().min(1).describe('Element ref (`eN`) from the most recent browser_snapshot on the same `name`.'),
          button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button to use. Defaults to left.'),
          doubleClick: z.boolean().optional().describe('When true, dispatches a double-click instead of a single click.'),
        },
        async (args) => {
          const name = sanitizeBrowserName(args.name);
          if (!name) return invalidName(args.name);
          if (!getBrowserPreview(sessionId, name)) return notOpen(name);
          maybeFocusBrowser(sessionId, name, deps);
          try {
            await cdpRequest(sessionId, name, 'click', { ref: args.ref, button: args.button, doubleClick: args.doubleClick }, deps.broadcastToSession);
            const tag = (args.doubleClick ? 'double-' : '') + `${args.button ?? 'left'}-clicked`;
            return { content: [{ type: 'text', text: `${tag} ${args.ref} in "${name}".` }] };
          } catch (e) {
            return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
          }
        },
      ),
      tool(
        'browser_hover',
        'Move the mouse over an element in a named browser preview. Use for menus, tooltips, and any UI that reveals state on hover.',
        {
          name: NAME_SCHEMA,
          ref: z.string().min(1).describe('Element ref (`eN`) from the most recent browser_snapshot on the same `name`.'),
        },
        async (args) => {
          const name = sanitizeBrowserName(args.name);
          if (!name) return invalidName(args.name);
          if (!getBrowserPreview(sessionId, name)) return notOpen(name);
          maybeFocusBrowser(sessionId, name, deps);
          try {
            await cdpRequest(sessionId, name, 'hover', { ref: args.ref }, deps.broadcastToSession);
            return { content: [{ type: 'text', text: `Hovered ${args.ref} in "${name}".` }] };
          } catch (e) {
            return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
          }
        },
      ),
      tool(
        'browser_type',
        [
          'Set the value of an input/textarea/contenteditable in a named browser preview (replaces existing content). Uses the prototype setter so React/Vue controlled inputs see the new value; fires `input` + `change` events.',
          '',
          'Pass `submit: true` to dispatch a synthetic Enter key after typing — useful for search boxes and chat inputs that submit on Enter.',
        ].join('\n'),
        {
          name: NAME_SCHEMA,
          ref: z.string().min(1).describe('Element ref (`eN`) from the most recent browser_snapshot on the same `name`.'),
          text: z.string().describe('Text to type. Empty string clears the field.'),
          submit: z.boolean().optional().describe('When true, press Enter after typing.'),
        },
        async (args) => {
          const name = sanitizeBrowserName(args.name);
          if (!name) return invalidName(args.name);
          if (!getBrowserPreview(sessionId, name)) return notOpen(name);
          maybeFocusBrowser(sessionId, name, deps);
          try {
            await cdpRequest(sessionId, name, 'type', { ref: args.ref, text: args.text, submit: args.submit }, deps.broadcastToSession);
            const tail = args.submit ? ' and pressed Enter' : '';
            return { content: [{ type: 'text', text: `Typed ${JSON.stringify(args.text).slice(0, 80)} into ${args.ref} in "${name}"${tail}.` }] };
          } catch (e) {
            return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
          }
        },
      ),
      tool(
        'browser_press_key',
        'Dispatch a key press to the page in a named browser preview. Accepts named keys (Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space) or single characters. Combine modifiers with `+`, e.g. `Control+a`, `Meta+k`, `Shift+Tab`.',
        {
          name: NAME_SCHEMA,
          key: z.string().min(1).describe('Key name or single character. Examples: "Enter", "Escape", "ArrowDown", "Control+a", "a".'),
        },
        async (args) => {
          const name = sanitizeBrowserName(args.name);
          if (!name) return invalidName(args.name);
          if (!getBrowserPreview(sessionId, name)) return notOpen(name);
          maybeFocusBrowser(sessionId, name, deps);
          try {
            await cdpRequest(sessionId, name, 'press_key', { key: args.key }, deps.broadcastToSession);
            return { content: [{ type: 'text', text: `Pressed ${args.key} in "${name}".` }] };
          } catch (e) {
            return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
          }
        },
      ),
      tool(
        'browser_select_option',
        'Select option(s) on a <select> element in a named browser preview. Matches each entry in `values` against option.value, label, or text. For non-multiple selects, only the first match is selected.',
        {
          name: NAME_SCHEMA,
          ref: z.string().min(1).describe('Element ref (`eN`) of a <select> from the most recent browser_snapshot on the same `name`.'),
          values: z.array(z.string()).min(1).describe('Option values, labels, or visible text to select. Order matters only for multi-selects.'),
        },
        async (args) => {
          const name = sanitizeBrowserName(args.name);
          if (!name) return invalidName(args.name);
          if (!getBrowserPreview(sessionId, name)) return notOpen(name);
          maybeFocusBrowser(sessionId, name, deps);
          try {
            await cdpRequest(sessionId, name, 'select_option', { ref: args.ref, values: args.values }, deps.broadcastToSession);
            return { content: [{ type: 'text', text: `Selected ${JSON.stringify(args.values)} on ${args.ref} in "${name}".` }] };
          } catch (e) {
            return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
          }
        },
      ),
      tool(
        'browser_scroll',
        'Scroll a named browser preview. With `ref`: scroll that element into view (centred). With `x` / `y`: scroll the viewport to those absolute coordinates. Pass exactly one form.',
        {
          name: NAME_SCHEMA,
          ref: z.string().optional().describe('Element ref (`eN`) from the most recent browser_snapshot on the same `name` — scrolls it into view.'),
          x: z.number().optional().describe('Absolute viewport X to scroll to (used when `ref` is omitted).'),
          y: z.number().optional().describe('Absolute viewport Y to scroll to (used when `ref` is omitted).'),
        },
        async (args) => {
          const name = sanitizeBrowserName(args.name);
          if (!name) return invalidName(args.name);
          if (!getBrowserPreview(sessionId, name)) return notOpen(name);
          maybeFocusBrowser(sessionId, name, deps);
          try {
            await cdpRequest(sessionId, name, 'scroll', { ref: args.ref, x: args.x, y: args.y }, deps.broadcastToSession);
            const where = args.ref ? `ref=${args.ref}` : `(${args.x ?? 0}, ${args.y ?? 0})`;
            return { content: [{ type: 'text', text: `Scrolled "${name}" to ${where}.` }] };
          } catch (e) {
            return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
          }
        },
      ),
      tool(
        'browser_navigate',
        'Navigate a named browser preview. With `action: "goto"` and a `url`, loads that URL. With `back` / `forward` / `reload`, drives the history. Same surface as the address-bar controls.',
        {
          name: NAME_SCHEMA,
          action: z.enum(['goto', 'back', 'forward', 'reload']).describe('Navigation action.'),
          url: z.string().optional().describe('Required for action="goto". Must be http:// or https://.'),
        },
        async (args) => {
          const name = sanitizeBrowserName(args.name);
          if (!name) return invalidName(args.name);
          if (!getBrowserPreview(sessionId, name)) return notOpen(name);
          maybeFocusBrowser(sessionId, name, deps);
          try {
            await cdpRequest(sessionId, name, 'navigate', { action: args.action, url: args.url }, deps.broadcastToSession);
            return { content: [{ type: 'text', text: args.action === 'goto' ? `"${name}" navigating to ${args.url}.` : `"${name}" navigation: ${args.action}.` }] };
          } catch (e) {
            return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
          }
        },
      ),
      tool(
        'browser_evaluate',
        [
          'Run a JavaScript function in the page of a named browser preview and return its result.',
          '',
          'Without `ref`: the function runs in global scope. Example function: `() => document.title`.',
          'With `ref`: the function runs with the resolved element as `this` (and as the first argument). Example function: `(el) => el.getBoundingClientRect()`.',
          '',
          'The function string must be a complete arrow function or `function` expression. Async functions are awaited.',
        ].join('\n'),
        {
          name: NAME_SCHEMA,
          function: z.string().min(1).describe('A JavaScript function expression. Examples: `() => document.title`, `(el) => el.textContent`.'),
          ref: z.string().optional().describe('Optional element ref (`eN`) — the function receives the element as `this` and arg[0].'),
        },
        async (args) => {
          const name = sanitizeBrowserName(args.name);
          if (!name) return invalidName(args.name);
          if (!getBrowserPreview(sessionId, name)) return notOpen(name);
          try {
            const r = (await cdpRequest(sessionId, name, 'evaluate', { function: args.function, ref: args.ref }, deps.broadcastToSession)) as { value: unknown };
            return { content: [{ type: 'text', text: JSON.stringify(r.value, null, 2) ?? 'undefined' }] };
          } catch (e) {
            return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
          }
        },
      ),
      tool(
        'browser_wait_for',
        [
          'Wait until a condition is met in a named browser preview. Provide one of:',
          '  • `text` — wait for this string to appear in the visible page text.',
          '  • `textGone` — wait for this string to disappear.',
          '  • `time` — wait this many seconds.',
          '',
          'Polls every 100ms (for text conditions). Times out after `timeoutMs` (default 5000).',
        ].join('\n'),
        {
          name: NAME_SCHEMA,
          text: z.string().optional().describe('Wait until this text appears in document.body.innerText.'),
          textGone: z.string().optional().describe('Wait until this text is no longer in document.body.innerText.'),
          time: z.number().positive().optional().describe('Wait this many seconds, then return.'),
          timeoutMs: z.number().int().positive().max(60_000).optional().describe('Hard timeout for text waits. Default 5000ms.'),
        },
        async (args) => {
          const name = sanitizeBrowserName(args.name);
          if (!name) return invalidName(args.name);
          if (!getBrowserPreview(sessionId, name)) return notOpen(name);
          try {
            await cdpRequest(sessionId, name, 'wait_for', { text: args.text, textGone: args.textGone, time: args.time, timeoutMs: args.timeoutMs }, deps.broadcastToSession, (args.timeoutMs ?? 5000) + 2000);
            return { content: [{ type: 'text', text: `Wait condition met in "${name}".` }] };
          } catch (e) {
            return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
          }
        },
      ),
      tool(
        'browser_console_messages',
        'Return the last N console messages (log/info/warn/error/debug + uncaught exceptions) captured by a named browser preview. Buffer holds up to 200; defaults to the last 50.',
        {
          name: NAME_SCHEMA,
          tail: z.number().int().positive().max(200).optional().describe('Number of most-recent entries to return. Defaults to 50.'),
        },
        async (args) => {
          const name = sanitizeBrowserName(args.name);
          if (!name) return invalidName(args.name);
          if (!getBrowserPreview(sessionId, name)) return notOpen(name);
          try {
            const r = await cdpRequest(sessionId, name, 'console_messages', { tail: args.tail ?? 50 }, deps.broadcastToSession);
            return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
          } catch (e) {
            return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
          }
        },
      ),
      tool(
        'browser_network_requests',
        'Return the last N HTTP requests observed by a named browser preview (method, URL, status, mime type, timing, error). Buffer holds up to 200; defaults to the last 50.',
        {
          name: NAME_SCHEMA,
          tail: z.number().int().positive().max(200).optional().describe('Number of most-recent entries to return. Defaults to 50.'),
        },
        async (args) => {
          const name = sanitizeBrowserName(args.name);
          if (!name) return invalidName(args.name);
          if (!getBrowserPreview(sessionId, name)) return notOpen(name);
          try {
            const r = await cdpRequest(sessionId, name, 'network_requests', { tail: args.tail ?? 50 }, deps.broadcastToSession);
            return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
          } catch (e) {
            return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
          }
        },
      ),
      tool(
        'browser_handle_dialog',
        [
          'Accept or dismiss a JavaScript dialog (alert/confirm/prompt/beforeunload) in a named browser preview. Call this after an action that triggered a dialog — Electron pauses the page until the dialog is handled.',
          '',
          'Pass `accept: true` to click OK; `accept: false` to click Cancel. For prompts, `promptText` becomes the value.',
        ].join('\n'),
        {
          name: NAME_SCHEMA,
          accept: z.boolean().describe('true → click OK / accept the dialog. false → click Cancel.'),
          promptText: z.string().optional().describe('Text for prompt() dialogs. Ignored for alert / confirm.'),
        },
        async (args) => {
          const name = sanitizeBrowserName(args.name);
          if (!name) return invalidName(args.name);
          if (!getBrowserPreview(sessionId, name)) return notOpen(name);
          maybeFocusBrowser(sessionId, name, deps);
          try {
            const r = (await cdpRequest(sessionId, name, 'handle_dialog', { accept: args.accept, promptText: args.promptText }, deps.broadcastToSession)) as { ok: true; handled: { type: string; message: string } | null };
            const text = r.handled
              ? `${args.accept ? 'Accepted' : 'Dismissed'} ${r.handled.type} in "${name}": ${r.handled.message}`
              : 'No dialog was pending.';
            return { content: [{ type: 'text', text }] };
          } catch (e) {
            return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
          }
        },
      ),
      tool(
        'spawn_terminal',
        [
          'Spawn a long-running shell command in the background and surface it in the in-app Processes panel so the user can watch it live. The process keeps running across model turns; output buffers in memory and on disk and can be read back any time with `read_terminal_output`.',
          '',
          'WHEN TO USE — anything the USER will want to keep an eye on:',
          '- App / API / dev servers ("bun run dev", "npm start", "rails s", "uvicorn …")',
          '- File watchers and incremental builds ("tsc --watch", "vitest --watch", "esbuild --watch")',
          '- Log tailing and monitoring ("tail -f app.log", "kubectl logs -f …", "watch -n 1 …", "htop -b")',
          '- Background workers, queue consumers, ngrok / tunnels, port-forwards',
          '- Anything you would normally leave running in a separate terminal tab',
          '',
          'WHEN NOT TO USE:',
          '- Short one-shot commands whose result you need before answering ("ls", "git status", "cat", "rg foo") — use the Bash tool instead. Bash blocks until completion and returns the output; this tool returns immediately and never blocks.',
          '- Anything destructive that you have not been explicitly asked to run.',
          '',
          'The command runs through the user\'s login shell with their profile sourced (~/.zprofile, ~/.zshrc), so PATH, aliases, asdf/nvm shims, etc. all work. The process is detached into its own group so killing it cleans up the whole tree. Returns a `procId` you can pass to `read_terminal_output`, or you can look the process up by `name` later. The terminal also appears in the Processes section of the file-explorer panel so the user can see and kill it from the UI.',
        ].join('\n'),
        {
          cwd: z.string().min(1).describe('Absolute working directory where the command runs (e.g. "/Users/me/proj"). Must exist and be readable by the user.'),
          name: z.string().min(1).max(60).describe('Short human-readable label for this terminal — what shows up in the Processes panel and what `read_terminal_output` matches against. Pick something specific so the user can tell several terminals apart at a glance, e.g. "API Server", "Vite Dev", "tail app.log", "ngrok tunnel".'),
          command: z.string().min(1).describe('Shell command line to run. Anything a normal interactive zsh would accept — pipes, env vars, multi-step `&&` chains, etc. Do NOT background it yourself with trailing `&`; this tool already runs it as a tracked background process.'),
        },
        async (args) => {
          if (!sessions.get(sessionId)) {
            return { content: [{ type: 'text', text: `Session ${sessionId} not found.` }], isError: true };
          }
          const label = args.name.trim();
          if (!label) {
            return { content: [{ type: 'text', text: 'name cannot be empty or whitespace.' }], isError: true };
          }
          try {
            const stat = await fs.stat(args.cwd);
            if (!stat.isDirectory()) {
              return { content: [{ type: 'text', text: `cwd "${args.cwd}" is not a directory.` }], isError: true };
            }
          } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            return { content: [{ type: 'text', text: `cwd "${args.cwd}" is not accessible: ${err}` }], isError: true };
          }

          // Spawn a PTY-backed shell so the running command gets a real TTY
          // (curses output, color, line discipline) and so the same xterm
          // bubble used by `/terminal` can re-attach to it. Default size is
          // re-negotiated by the bubble's xterm via `terminal_resize` once
          // it mounts.
          const procId = randomUUID();
          const cols = 120;
          const rows = 30;
          const pty = spawnPty({ cwd: args.cwd, cols, rows, sessionId });
          if (!pty) {
            return { content: [{ type: 'text', text: 'Failed to spawn PTY (Bun.Terminal requires Bun >= 1.3.5).' }], isError: true };
          }

          const tp: TrackedProcess = {
            id: procId,
            pid: pty.pid,
            command: args.command,
            cwd: args.cwd,
            sessionId,
            startedAt: Date.now(),
            proc: null,
            viewers: new Set(),
            outputBuffer: [],
            exitCode: null,
            kind: 'pty',
            cols,
            rows,
            pty,
            label,
          };
          trackedProcesses.set(procId, tp);
          saveProcessRegistry();

          // Inject the user's command on the PTY's first byte. We pre-type
          // here (instead of relying on the bubble's `terminalCommand`
          // auto-send) because the bubble suppresses auto-send whenever it
          // detects a re-attach — and our pre-spawned PTY makes every
          // `execShell` from the bubble look like a re-attach. Waiting for
          // first byte means the shell has finished sourcing its rc files
          // and is ready to read input.
          let didTypeCommand = false;
          pty.onData((text: string) => {
            tp.outputBuffer.push(text);
            if (tp.outputBuffer.length > 1000) tp.outputBuffer.splice(0, tp.outputBuffer.length - 500);
            appendProcessOutput(procId, text);
            deps.broadcastToSession(sessionId, { type: 'terminal_data', sessionId, procId, text });
            if (!didTypeCommand) {
              didTypeCommand = true;
              try { pty.write(args.command + '\r'); } catch {}
            }
          });
          pty.onExit((code: number) => {
            if (tp.exitCode !== null) return;
            tp.exitCode = code;
            log(`[spawn_terminal] "${label}" procId=${procId.slice(0, 8)} exited code=${code}`);
            deps.broadcastToSession(sessionId, { type: 'terminal_exit', sessionId, procId, code });
            addToGraveyard(procId);
            setTimeout(() => { trackedProcesses.delete(procId); saveProcessRegistry(); }, 30_000);
          });

          // Push the chat message AFTER the PTY is in `trackedProcesses` so
          // when the InteractiveTerminalBubble mounts and fires `exec_shell`,
          // the bridge re-attaches to this PTY (replays buffer, resizes)
          // instead of spawning a duplicate. The bubble auto-types
          // `terminalCommand + \r` once the PTY produces its first byte —
          // that's how the command actually starts running.
          const termMsg: ChatMessage = {
            id: procId,
            role: 'system',
            content: '',
            timestamp: Date.now(),
            isInteractiveTerminal: true,
            procId,
            terminalCommand: args.command,
            terminalCwd: args.cwd,
          };
          if (addMessage(sessionId, termMsg)) {
            deps.broadcastToSession(sessionId, { type: 'message', sessionId, message: termMsg });
          }

          log(`[spawn_terminal] "${label}" procId=${procId.slice(0, 8)} pid=${pty.pid} session=${sessionId.slice(0, 8)} cmd=${args.command.slice(0, 80)}`);

          const summary = [
            `Spawned terminal "${label}" (procId=${procId}, pid=${pty.pid}).`,
            `cwd: ${args.cwd}`,
            `command: ${args.command}`,
            'A live xterm shell is mounted in the chat (same UX as the /terminal slash command); the process also appears in the Processes panel. Read output with read_terminal_output, send keystrokes with send_terminal_input, stop it with kill_terminal — all by procId or by name.',
          ].join('\n');
          return { content: [{ type: 'text', text: summary }] };
        },
      ),
      tool(
        'read_terminal_output',
        [
          'Read the current accumulated output of a terminal previously spawned with `spawn_terminal` (or any other tracked background process in this session). Use this to peek at a dev server\'s logs, see what a watcher just emitted, verify a worker is healthy, or grab the last error from a crash.',
          '',
          'Returns a snapshot of stdout+stderr captured so far, plus the live status (running, or exited with code N). To "watch in real time", call this tool again after taking the action you expect to produce new output — each call returns the freshest buffer.',
          '',
          'Identify the target terminal by `procId` (returned from spawn_terminal) OR by `name` (the label passed to spawn_terminal — matched case-insensitively within the current session). Pass exactly one.',
        ].join('\n'),
        {
          procId: z.string().optional().describe('procId returned by spawn_terminal. Provide this OR `name`.'),
          name: z.string().optional().describe('Label originally passed to spawn_terminal (e.g. "API Server"). Matched case-insensitively against terminals in the current session. Provide this OR `procId`.'),
          tail_lines: z.number().int().positive().max(5000).optional().describe('Return only the last N lines of output. Omit to return the full buffered output. Useful for long-running servers where the early startup logs are no longer interesting.'),
        },
        async (args) => {
          const resolved = resolveTrackedProcess(sessionId, args);
          if (!resolved.ok) {
            return { content: [{ type: 'text', text: resolved.error }], isError: true };
          }
          const tp = resolved.tp;

          let output = tp.outputBuffer.join('');
          if (args.tail_lines && args.tail_lines > 0) {
            const lines = output.split('\n');
            if (lines.length > args.tail_lines) {
              output = lines.slice(lines.length - args.tail_lines).join('\n');
            }
          }

          const status = tp.exitCode === null
            ? 'running'
            : `exited (code ${tp.exitCode})`;
          const ageSec = Math.max(0, Math.round((Date.now() - tp.startedAt) / 1000));
          const header = [
            `=== "${tp.label || '(no name)'}" (procId=${tp.id}, pid=${tp.pid}) ===`,
            `status: ${status} · uptime ${ageSec}s · cwd ${tp.cwd}`,
            `command: ${tp.command}`,
            '--- output ---',
          ].join('\n');
          const body = output.length === 0 ? '(no output yet)' : output;
          return { content: [{ type: 'text', text: `${header}\n${body}` }] };
        },
      ),
      tool(
        'kill_terminal',
        [
          'Stop a background terminal previously spawned with `spawn_terminal`. Sends SIGTERM (then SIGKILL after 500ms) to the entire process group, so child processes (e.g. workers forked from a dev server) are reaped along with the parent. Removes the terminal from the Processes panel.',
          '',
          'Identify the target by `procId` (returned from spawn_terminal) OR by `name` (its label). Pass exactly one. Use this when the user asks you to stop/restart a server, when you want to free a port before relaunching with different args, or when a terminal is no longer useful.',
        ].join('\n'),
        {
          procId: z.string().optional().describe('procId returned by spawn_terminal. Provide this OR `name`.'),
          name: z.string().optional().describe('Label originally passed to spawn_terminal (case-insensitive). Provide this OR `procId`.'),
        },
        async (args) => {
          const resolved = resolveTrackedProcess(sessionId, args);
          if (!resolved.ok) {
            return { content: [{ type: 'text', text: resolved.error }], isError: true };
          }
          const tp = resolved.tp;
          if (tp.exitCode !== null) {
            return { content: [{ type: 'text', text: `Terminal "${tp.label || tp.id}" already exited (code ${tp.exitCode}).` }] };
          }
          const ok = killTrackedProcess(tp.id);
          if (!ok) {
            return { content: [{ type: 'text', text: `Terminal "${tp.label || tp.id}" was no longer tracked.` }], isError: true };
          }
          deps.broadcastToSession(sessionId, { type: 'terminal_exit', sessionId, procId: tp.id, code: -1 });
          log(`[kill_terminal] killed "${tp.label || ''}" procId=${tp.id.slice(0, 8)} pid=${tp.pid} session=${sessionId.slice(0, 8)}`);
          return { content: [{ type: 'text', text: `Killed terminal "${tp.label || '(no name)'}" (procId=${tp.id}, pid=${tp.pid}). The whole process group was signalled (SIGTERM → SIGKILL).` }] };
        },
      ),
      tool(
        'send_terminal_input',
        [
          'Write input to the stdin of a terminal previously spawned with `spawn_terminal` — i.e. type more "commands" into a still-running process. Use for anything that reads stdin: REPLs (`node`, `python -i`, `psql`), interactive prompts ("Are you sure? [y/N]"), CLI debuggers, or programs that take queries on stdin.',
          '',
          'A trailing newline is appended by default so the child process receives a complete line; pass `append_newline: false` for partial input or for tools that want a literal byte sequence (Ctrl-C is "\\x03", Ctrl-D is "\\x04", etc.).',
          '',
          'Identify the target by `procId` OR by `name` (label). Pass exactly one. Note: the spawned shell does NOT have a controlling TTY, so programs that strictly require a TTY (e.g. `vim`, password prompts, `sudo`) will not work — for those, prefer the user-driven interactive `/terminal` shell.',
        ].join('\n'),
        {
          procId: z.string().optional().describe('procId returned by spawn_terminal. Provide this OR `name`.'),
          name: z.string().optional().describe('Label originally passed to spawn_terminal (case-insensitive). Provide this OR `procId`.'),
          input: z.string().describe('Bytes to write to the child\'s stdin. May be empty (e.g. just to send a newline keypress).'),
          append_newline: z.boolean().optional().describe('When true (default), a trailing "\\n" is appended so the child receives a complete line. Set to false to send raw bytes without modification.'),
        },
        async (args) => {
          const resolved = resolveTrackedProcess(sessionId, args);
          if (!resolved.ok) {
            return { content: [{ type: 'text', text: resolved.error }], isError: true };
          }
          const tp = resolved.tp;
          if (tp.exitCode !== null) {
            return { content: [{ type: 'text', text: `Terminal "${tp.label || tp.id}" has already exited (code ${tp.exitCode}); cannot send input.` }], isError: true };
          }
          const payload = args.append_newline === false ? args.input : args.input + '\n';
          let written = false;
          if (tp.kind === 'pty' && tp.pty) {
            try { tp.pty.write(payload); written = true; } catch {}
          } else if (tp.proc?.stdin && !tp.proc.stdin.destroyed) {
            try { written = tp.proc.stdin.write(payload); } catch {}
          } else {
            return { content: [{ type: 'text', text: `Terminal "${tp.label || tp.id}" has no writable stdin (process was spawned without a stdin pipe, or the stream is already closed).` }], isError: true };
          }
          if (!written) {
            return { content: [{ type: 'text', text: `stdin write to "${tp.label || tp.id}" returned false (backpressure or closed stream); the bytes were buffered but may not have flushed.` }], isError: true };
          }
          const preview = args.input.length > 80 ? args.input.slice(0, 77) + '…' : args.input;
          return { content: [{ type: 'text', text: `Wrote ${payload.length} byte${payload.length === 1 ? '' : 's'} to stdin of "${tp.label || '(no name)'}" (procId=${tp.id}). Input: ${JSON.stringify(preview)}` }] };
        },
      ),
      tool(
        'actions_list',
        [
          'List every named server action configured for the current project — what the user defined in Project Settings → Actions. Returns ALL configured actions (not only the ones currently running), with their command, whether they\'re wrapped through Portless, the resolved URL when Portless is on, and live state (running/idle) in this session.',
          '',
          'Call this whenever you need to know what dev servers / scripts the user has set up. It\'s the discovery tool for `actions_run`.',
        ].join('\n'),
        {},
        async () => {
          const ctx = resolveSessionGroup(sessionId, deps);
          if (!ctx) {
            return { content: [{ type: 'text', text: 'This session is not associated with a project. Open Project Settings → Actions and add this session to a project to configure actions.' }] };
          }
          const cfg = (ctx.group.portless || {}) as { actions?: { id: string; name: string; command: string; hostname?: string; portless?: boolean }[]; tld?: string };
          const actions = cfg.actions || [];
          if (actions.length === 0) {
            return { content: [{ type: 'text', text: `Project "${ctx.group.name}" has no actions configured yet. Add some in Project Settings → Actions.` }] };
          }
          const labelToProc = new Map<string, TrackedProcess>();
          for (const tp of trackedProcesses.values()) {
            if (tp.sessionId === sessionId && tp.label && tp.exitCode === null) {
              labelToProc.set(tp.label.toLowerCase(), tp);
            }
          }
          const lines = actions.map(a => {
            const tp = labelToProc.get(`action · ${a.name}`.toLowerCase());
            const status = tp ? `running (pid ${tp.pid})` : 'idle';
            const usePortless = a.portless !== false;
            if (usePortless) {
              const tld = cfg.tld || 'localhost';
              const slug = a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
              const host = a.hostname && a.hostname.includes('.') ? a.hostname : `${slug}.${tld}`;
              return `- ${a.name} · ${a.command} · portless → https://${host} [${status}]`;
            }
            return `- ${a.name} · ${a.command} · raw command [${status}]`;
          });
          return { content: [{ type: 'text', text: `Actions for "${ctx.group.name}":\n${lines.join('\n')}` }] };
        },
      ),
      tool(
        'actions_run',
        [
          'Start a named server action in the current project. Spawns the action\'s command inside a live terminal bubble in the chat — the full command line is visible so the user can see exactly what was launched, and the process also shows up in the Processes panel.',
          '',
          'Per-action wrapping: if the action has Portless enabled, the command is prefixed with `portless <slug> --` and the resulting dev server is reachable at a stable hostname (e.g. `https://api.localhost`) instead of a random port — a toast also pops with the URL. If Portless is off for that action, the raw command is run as-is.',
          '',
          'Use this when the user asks to "start the api", "boot the web server", "run dev", etc. — and an action with that name is configured in Project Settings → Actions. Call `actions_list` first if you\'re unsure of the available names.',
          '',
          'Idempotent: starting an already-running action returns the existing terminal\'s procId without spawning a duplicate.',
        ].join('\n'),
        {
          name: z.string().min(1).describe('The action name as configured in Project Settings → Actions. Matched case-insensitively. Use `actions_list` to discover available names.'),
        },
        async (args) => {
          if (!sessions.get(sessionId)) {
            return { content: [{ type: 'text', text: `Session ${sessionId} not found.` }], isError: true };
          }
          const ctx = resolveSessionGroup(sessionId, deps);
          if (!ctx) {
            return { content: [{ type: 'text', text: 'This session is not associated with a project — cannot resolve which actions to run.' }], isError: true };
          }
          if (!ctx.group.cwd) {
            return { content: [{ type: 'text', text: `Project "${ctx.group.name}" has no working directory set; cannot spawn the action.` }], isError: true };
          }
          const cfg = (ctx.group.portless || {}) as { actions?: { id: string; name: string; command: string; hostname?: string; portless?: boolean }[]; tld?: 'localhost' | 'test'; tls?: boolean };
          const actions = cfg.actions || [];
          const match = actions.find(a => a.name === args.name) || actions.find(a => a.name.toLowerCase() === args.name.toLowerCase());
          if (!match) {
            const known = actions.map(a => a.name).join(', ') || '(none configured)';
            return { content: [{ type: 'text', text: `No action named "${args.name}" in project "${ctx.group.name}". Known: ${known}.` }], isError: true };
          }

          const usePortless = match.portless !== false;
          const tld = cfg.tld || 'localhost';
          const slug = match.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
          const hostname = match.hostname && match.hostname.includes('.') ? match.hostname : `${slug}.${tld}`;
          const url = `https://${hostname}`;
          const label = `Action · ${match.name}`;

          if (usePortless) {
            const cli = getPortlessCliStatus();
            if (!cli.available) {
              return { content: [{ type: 'text', text: `Action "${match.name}" is configured to use Portless, but the portless CLI is not installed. Ask the user to run \`npm install -g portless\` and restart taskr, or disable Portless for this action.` }], isError: true };
            }
          }

          // Don't double-spawn — if a tracked terminal with this label is
          // already live in the session, reuse it.
          for (const tp of trackedProcesses.values()) {
            if (tp.sessionId === sessionId && tp.label === label && tp.exitCode === null) {
              const where = usePortless ? ` URL: ${url}` : '';
              return { content: [{ type: 'text', text: `"${match.name}" is already running (procId=${tp.id}, pid=${tp.pid}).${where}` }] };
            }
          }

          // Build the command the user sees in the chat. With Portless on,
          // wrap the raw command so it serves at the stable hostname.
          const visibleCommand = usePortless
            ? `portless ${slug} -- sh -c '${match.command.replace(/'/g, `'\\''`)}'`
            : match.command;

          const procId = randomUUID();
          const cols = 120;
          const rows = 30;
          const pty = spawnPty({ cwd: ctx.group.cwd, cols, rows, sessionId });
          if (!pty) {
            return { content: [{ type: 'text', text: 'Failed to spawn PTY (Bun.Terminal requires Bun >= 1.3.5).' }], isError: true };
          }

          const tp: TrackedProcess = {
            id: procId,
            pid: pty.pid,
            command: visibleCommand,
            cwd: ctx.group.cwd,
            sessionId,
            startedAt: Date.now(),
            proc: null,
            viewers: new Set(),
            outputBuffer: [],
            exitCode: null,
            kind: 'pty',
            cols,
            rows,
            pty,
            label,
          };
          trackedProcesses.set(procId, tp);
          saveProcessRegistry();

          let didTypeCommand = false;
          let resolvedUrl: string | null = null;
          pty.onData((text: string) => {
            tp.outputBuffer.push(text);
            if (tp.outputBuffer.length > 1000) tp.outputBuffer.splice(0, tp.outputBuffer.length - 500);
            appendProcessOutput(procId, text);
            deps.broadcastToSession(sessionId, { type: 'terminal_data', sessionId, procId, text });
            if (!didTypeCommand) {
              didTypeCommand = true;
              try { pty.write(visibleCommand + '\r'); } catch {}
            }
            if (usePortless && !resolvedUrl) {
              const found = extractPortlessUrl(text);
              if (found) {
                resolvedUrl = found;
                emitPortlessUrlResolved({
                  key: `${ctx.groupId}:${match.id}`,
                  groupId: ctx.groupId,
                  actionId: match.id,
                  url: found,
                });
              }
            }
          });
          pty.onExit((code: number) => {
            if (tp.exitCode !== null) return;
            tp.exitCode = code;
            log(`[actions_run] "${label}" procId=${procId.slice(0, 8)} exited code=${code}`);
            deps.broadcastToSession(sessionId, { type: 'terminal_exit', sessionId, procId, code });
            addToGraveyard(procId);
            setTimeout(() => { trackedProcesses.delete(procId); saveProcessRegistry(); }, 30_000);
          });

          // Interactive terminal bubble in the chat. `terminalName`
          // promotes the action's configured name to the bubble title and
          // the shells-dock pill so the user sees "api" / "web-renter"
          // rather than the cwd or the full portless wrapper.
          const termMsg: ChatMessage = {
            id: procId,
            role: 'system',
            content: '',
            timestamp: Date.now(),
            isInteractiveTerminal: true,
            procId,
            terminalCommand: visibleCommand,
            terminalCwd: ctx.group.cwd,
            terminalName: match.name,
          };
          if (addMessage(sessionId, termMsg)) {
            deps.broadcastToSession(sessionId, { type: 'message', sessionId, message: termMsg });
          }

          // Toast only when there's a stable URL to surface — otherwise the
          // visible terminal bubble is sufficient feedback.
          if (usePortless) {
            emitPortlessActionFired(
              {
                key: `${ctx.groupId}:${match.id}`,
                groupId: ctx.groupId,
                actionId: match.id,
                name: match.name,
                command: visibleCommand,
                hostname,
                url,
                cwd: ctx.group.cwd,
                pid: pty.pid,
                state: 'starting',
                startedAt: Date.now(),
                exitedAt: null,
                exitCode: null,
                lastError: null,
                logTail: [],
              },
              'agent',
              sessionId,
            );
          }

          log(`[actions_run] "${label}" procId=${procId.slice(0, 8)} pid=${pty.pid} session=${sessionId.slice(0, 8)} portless=${usePortless} cmd=${visibleCommand.slice(0, 80)}`);

          const summary = usePortless
            ? [
                `Started "${match.name}" → ${url}`,
                `command: ${visibleCommand}`,
                `cwd: ${ctx.group.cwd}`,
                'A live terminal is mounted in the chat and the process appears in the Processes panel. Read output with read_terminal_output, send keystrokes with send_terminal_input, stop it with actions_stop or kill_terminal.',
              ].join('\n')
            : [
                `Started "${match.name}" (raw command, no Portless wrapper).`,
                `command: ${visibleCommand}`,
                `cwd: ${ctx.group.cwd}`,
                'A live terminal is mounted in the chat and the process appears in the Processes panel.',
              ].join('\n');
          return { content: [{ type: 'text', text: summary }] };
        },
      ),
      tool(
        'actions_stop',
        [
          'Stop a project action previously started in this session. Looks up the action\'s tracked terminal by label and signals the entire process group (SIGTERM → SIGKILL after 500ms).',
          '',
          'With no `name`, every action started in this session is stopped.',
        ].join('\n'),
        {
          name: z.string().optional().describe('Action name to stop (matched case-insensitively). Omit to stop every running action started in this session.'),
        },
        async (args) => {
          const targets: TrackedProcess[] = [];
          const wanted = args.name?.trim().toLowerCase();
          for (const tp of trackedProcesses.values()) {
            if (tp.sessionId !== sessionId) continue;
            if (!tp.label || !tp.label.startsWith('Action · ')) continue;
            if (tp.exitCode !== null) continue;
            if (wanted) {
              const actionName = tp.label.slice('Action · '.length).toLowerCase();
              if (actionName !== wanted) continue;
            }
            targets.push(tp);
          }
          if (targets.length === 0) {
            return { content: [{ type: 'text', text: wanted ? `No action named "${args.name}" is running in this session.` : 'No actions running in this session.' }] };
          }
          let stopped = 0;
          for (const tp of targets) {
            if (killTrackedProcess(tp.id)) stopped++;
            deps.broadcastToSession(sessionId, { type: 'terminal_exit', sessionId, procId: tp.id, code: -1 });
          }
          const names = targets.map(t => t.label!.slice('Action · '.length)).join(', ');
          return { content: [{ type: 'text', text: `Stopped ${stopped} action${stopped === 1 ? '' : 's'}: ${names}.` }] };
        },
      ),
      // Plugin-contributed SDK tools — already prefixed with `<pluginId>_`
      // and built with the bridge's installed `tool()`/`z` so they're
      // shape-compatible with the built-ins above.
      ...getPluginSdkToolDefs(),
    ],
  });
}
