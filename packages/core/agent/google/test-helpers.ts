/**
 * Test-only fake Google: a scripted `fetch` that records every request, plus
 * helpers to put the area into a known state (client, settings, tokens).
 * Never imported by production code.
 */

import { _resetOAuthForTest, deleteOAuthClient, setOAuthClient } from './oauth';
import { _setGoogleDepsForTest, type CommandResult } from './deps';
import { updateGoogleSettings, type CalendarLevel, type GmailLevel } from './settings';
import { deleteSecret, setSecretJson } from '../vault';

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  json(): any;
  form(): URLSearchParams;
}

type Reply = Response | { status?: number; json?: unknown } | Promise<Response | { status?: number; json?: unknown }>;
type Route = { method: string; match: (url: URL) => boolean; reply: (req: RecordedRequest) => Reply };

export const CLIENT_ID = '1234567890-abcdefghijklmnop.apps.googleusercontent.com';
export const CLIENT_SECRET = 'GOCSPX-test-secret-value';

export function createFakeGoogle() {
  const routes: Route[] = [];
  const requests: RecordedRequest[] = [];
  let now = Date.UTC(2026, 10, 12, 15, 0, 0);
  const notifications: string[] = [];
  const commands: string[][] = [];
  let commandOutput: CommandResult = { exitCode: 0, stdout: '', stderr: '' };

  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    new Headers(init.headers as HeadersInit | undefined).forEach((v, k) => { headers[k] = v; });
    const body = typeof init.body === 'string' ? init.body : '';
    const req: RecordedRequest = {
      method: (init.method ?? 'GET').toUpperCase(),
      url,
      headers,
      body,
      json: () => JSON.parse(body),
      form: () => new URLSearchParams(body),
    };
    requests.push(req);
    const route = [...routes].reverse().find(r => r.method === req.method && r.match(url));
    if (!route) return Response.json({ error: { code: 404, message: `fake google: no route for ${req.method} ${url.pathname}` } }, { status: 404 });
    const out = await route.reply(req);
    if (out instanceof Response) return out;
    if (out.json === undefined) return new Response(null, { status: out.status ?? 204 });
    return Response.json(out.json, { status: out.status ?? 200 });
  };

  const api = {
    requests,
    notifications,
    commands,
    get now() { return now; },
    advance(ms: number) { now += ms; },
    /** Later routes win, so a test can override a default. */
    on(method: string, match: string | RegExp | ((url: URL) => boolean), reply: Route['reply']) {
      const fn = typeof match === 'function'
        ? match
        : typeof match === 'string'
          ? (u: URL) => `${u.origin}${u.pathname}` === match
          : (u: URL) => match.test(`${u.origin}${u.pathname}`);
      routes.push({ method, match: fn, reply });
      return api;
    },
    find(method: string, pathPart: string | RegExp): RecordedRequest[] {
      return requests.filter(r => r.method === method && (typeof pathPart === 'string' ? r.url.pathname.includes(pathPart) : pathPart.test(r.url.pathname)));
    },
    setCommandOutput(out: Partial<CommandResult>) { commandOutput = { exitCode: 0, stdout: '', stderr: '', ...out }; },
    install(opts: { tailscaleBin?: string | null } = {}) {
      _setGoogleDepsForTest({
        fetch,
        now: () => now,
        async run(argv) { commands.push(argv); return commandOutput; },
        tailscaleBin: () => (opts.tailscaleBin === undefined ? '/usr/bin/tailscale' : opts.tailscaleBin),
        async notifyOwner(text) { notifications.push(text); },
      });
      return api;
    },
  };
  return api;
}

/** Fresh area state: no client, no tokens, default settings, no pending authorizations. */
export function resetGoogleState(): void {
  _setGoogleDepsForTest(null);
  _resetOAuthForTest();
  deleteOAuthClient();
  deleteSecret('google:tokens');
  updateGoogleSettings(() => ({ publicBaseUrl: '', gmail: 'read', calendar: 'read', lastError: null }));
}

export function configureClient(opts: { publicBaseUrl?: string; gmail?: GmailLevel; calendar?: CalendarLevel } = {}): void {
  setOAuthClient(CLIENT_ID, CLIENT_SECRET);
  updateGoogleSettings(s => ({
    ...s,
    publicBaseUrl: opts.publicBaseUrl ?? 'https://agent.example.ts.net',
    gmail: opts.gmail ?? s.gmail,
    calendar: opts.calendar ?? s.calendar,
  }));
}

/** Store tokens as if the owner had connected with the given scopes. */
export function connectWith(scopes: string[], opts: { expiresInMs?: number; now: number; email?: string } ): void {
  setSecretJson('google:tokens', {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expiry_date: opts.now + (opts.expiresInMs ?? 3_600_000),
    scope: ['openid', 'email', ...scopes].join(' '),
    email: opts.email ?? 'owner@example.com',
  });
}

/** Text of a tool result. */
export function resultText(r: { content: unknown[] }): string {
  return (r.content as { type: string; text?: string }[]).map(c => c.text ?? '').join('\n');
}

/** Decode a Gmail `raw` (base64url RFC 2822). */
export function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}
