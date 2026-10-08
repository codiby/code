/**
 * Claude Code sign-in, driven from the app instead of a terminal `/login`.
 *
 * The CLI exposes its OAuth flow over the SDK control channel (the same one
 * the IDE extensions use): `claudeAuthenticate` starts a PKCE flow and hands
 * back two authorize URLs, and the CLI stores the resulting credentials in
 * the keychain / `~/.claude/.credentials.json` exactly as `claude auth login`
 * would. These methods exist on the `Query` object at runtime but are not in
 * the SDK's type declarations, so they are reached through `LoginQuery`.
 *
 *   - `automaticUrl` redirects to `http://localhost:<port>/callback`, a
 *     listener the CLI binds on 127.0.0.1 of *this* machine. It only works
 *     when the browser can reach that port as its own localhost — directly,
 *     or through an SSH `-L <port>:localhost:<port>` the viewer opens. The
 *     port is baked into `redirect_uri`, so the forward must keep it.
 *   - `manualUrl` redirects to platform.claude.com, which shows a
 *     `code#state` string to paste back. It works from any device.
 *
 * One flow at a time per bridge. A rejected code ends the flow on the CLI
 * side, so the caller has to start a new one.
 *
 *   - `GET    /providers/claude/auth`        → `getClaudeAuthStatus()`
 *   - `GET    /providers/claude/login`       → `getClaudeLoginFlow()`
 *   - `POST   /providers/claude/login`       → `startClaudeLogin()`
 *   - `POST   /providers/claude/login/code`  → `submitClaudeLoginCode()`
 *   - `DELETE /providers/claude/login`       → `cancelClaudeLogin()`
 *   - `POST   /providers/claude/logout`      → `claudeLogout()`
 */

import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_BIN } from '../config/config';
import { log, logError } from '../lib/logger';

/** A flow nobody finishes is torn down so its CLI process and port don't linger. */
const FLOW_TTL_MS = 15 * 60 * 1000;
/** How long a finished/failed flow stays readable for the UI's last poll. */
const FINISHED_TTL_MS = 2 * 60 * 1000;

export type ClaudeAuthStatus = {
  loggedIn: boolean;
  /** `claude.ai`, `console`, `api_key`, … as reported by `claude auth status`. */
  authMethod: string | null;
  apiProvider: string | null;
  email: string | null;
  orgName: string | null;
  subscriptionType: string | null;
};

export type ClaudeLoginMethod = 'claudeai' | 'console';

export type ClaudeLoginFlow = {
  id: string;
  method: ClaudeLoginMethod;
  state: 'pending' | 'done' | 'error' | 'cancelled';
  /** Paste-the-code URL. Works from any device. */
  manualUrl: string;
  /** Redirects to the CLI's listener on 127.0.0.1:`callbackPort` of this host. */
  automaticUrl: string;
  /** Port in `automaticUrl`'s redirect_uri. A forward must expose it unchanged. */
  callbackPort: number | null;
  error: string | null;
  /** Post-login status, set once the flow is `done`. */
  status: ClaudeAuthStatus | null;
  startedAt: number;
};

type LoginQuery = Query & {
  claudeAuthenticate(loginWithClaudeAi: boolean): Promise<{ manualUrl: string; automaticUrl: string }>;
  claudeOAuthCallback(authorizationCode: string, state: string): Promise<unknown>;
  claudeOAuthWaitForCompletion(): Promise<unknown>;
};

type Active = {
  flow: ClaudeLoginFlow;
  runtime: LoginQuery;
  timer: ReturnType<typeof setTimeout>;
  /** Resolves once the flow leaves `pending`, whatever the outcome. */
  settled: Promise<void>;
};

let active: Active | null = null;
let starting: Promise<ClaudeLoginFlow> | null = null;

async function runClaude(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([CLAUDE_BIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** Shapes `claude auth status --json`. Exported for tests. */
export function parseAuthStatus(text: string): ClaudeAuthStatus {
  let raw: any = null;
  try { raw = JSON.parse(text); } catch {}
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    loggedIn: raw?.loggedIn === true,
    authMethod: str(raw?.authMethod),
    apiProvider: str(raw?.apiProvider),
    email: str(raw?.email),
    orgName: str(raw?.orgName),
    subscriptionType: str(raw?.subscriptionType),
  };
}

export async function getClaudeAuthStatus(): Promise<ClaudeAuthStatus> {
  try {
    // Exits non-zero when signed out but still prints the JSON.
    const { stdout } = await runClaude(['auth', 'status', '--json'], 15_000);
    return parseAuthStatus(stdout);
  } catch {
    return parseAuthStatus('');
  }
}

/** Port of the localhost redirect in an authorize URL. Exported for tests. */
export function callbackPortOf(authorizeUrl: string): number | null {
  try {
    const redirect = new URL(authorizeUrl).searchParams.get('redirect_uri');
    if (!redirect) return null;
    const port = Number(new URL(redirect).port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Splits what the user pasted from the platform page. It shows `code#state`;
 * people also paste the whole redirect URL. Exported for tests.
 */
export function parseLoginCode(input: string): { code: string; state: string } | null {
  const text = input.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      return code && state ? { code, state } : null;
    } catch {
      return null;
    }
  }
  const hash = text.indexOf('#');
  if (hash <= 0 || hash === text.length - 1) return null;
  return { code: text.slice(0, hash), state: text.slice(hash + 1) };
}

function snapshot(): ClaudeLoginFlow | null {
  return active ? { ...active.flow } : null;
}

function teardown(entry: Active) {
  clearTimeout(entry.timer);
  try { entry.runtime.close(); } catch {}
}

/** Ends the flow and keeps it readable for a short while so the UI sees the outcome. */
function finish(entry: Active, patch: Partial<ClaudeLoginFlow>) {
  if (entry.flow.state !== 'pending') return;
  Object.assign(entry.flow, patch);
  teardown(entry);
  entry.timer = setTimeout(() => {
    if (active === entry) active = null;
  }, FINISHED_TTL_MS);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function getClaudeLoginFlow(): ClaudeLoginFlow | null {
  return snapshot();
}

/** Starts a sign-in flow, replacing any pending one. Concurrent callers share the start. */
export function startClaudeLogin(method: ClaudeLoginMethod = 'claudeai'): Promise<ClaudeLoginFlow> {
  if (starting) return starting;
  starting = (async () => {
    if (active) {
      finish(active, { state: 'cancelled' });
      active = null;
    }

    // Input that never yields: the CLI stays up to serve control requests
    // without ever starting a turn.
    async function* idle(): AsyncGenerator<SDKUserMessage> {
      await new Promise(() => {});
    }
    const runtime = query({
      prompt: idle(),
      options: { cwd: homedir(), pathToClaudeCodeExecutable: CLAUDE_BIN },
    }) as LoginQuery;
    // Nothing to read, but draining keeps the transport from backing up.
    void (async () => { try { for await (const _ of runtime) {} } catch {} })();

    if (typeof runtime.claudeAuthenticate !== 'function') {
      try { runtime.close(); } catch {}
      throw new Error('This Claude Agent SDK does not support in-app sign-in. Run `claude auth login` in a terminal.');
    }

    let urls: { manualUrl: string; automaticUrl: string };
    try {
      urls = await runtime.claudeAuthenticate(method === 'claudeai');
    } catch (err) {
      try { runtime.close(); } catch {}
      throw err;
    }

    const entry: Active = {
      settled: Promise.resolve(),
      flow: {
        id: randomUUID(),
        method,
        state: 'pending',
        manualUrl: urls.manualUrl,
        automaticUrl: urls.automaticUrl,
        callbackPort: callbackPortOf(urls.automaticUrl),
        error: null,
        status: null,
        startedAt: Date.now(),
      },
      runtime,
      timer: setTimeout(() => {
        if (active === entry) finish(entry, { state: 'error', error: 'Sign-in timed out.' });
      }, FLOW_TTL_MS),
    };
    active = entry;
    log(`[claude-auth] login flow ${entry.flow.id} started (${method}, callback port ${entry.flow.callbackPort ?? '?'})`);

    // Resolves for either path — the browser hitting the localhost listener
    // or a pasted code going through `submitClaudeLoginCode`.
    entry.settled = runtime.claudeOAuthWaitForCompletion().then(
      async () => {
        const status = await getClaudeAuthStatus();
        log(`[claude-auth] login flow ${entry.flow.id} completed (loggedIn=${status.loggedIn})`);
        finish(entry, { state: 'done', status });
      },
      (err) => {
        if (entry.flow.state !== 'pending') return;
        logError(`[claude-auth] login flow ${entry.flow.id} failed:`, err);
        finish(entry, { state: 'error', error: errorMessage(err) });
      },
    );

    return { ...entry.flow };
  })().finally(() => { starting = null; });
  return starting;
}

/** Feeds the `code#state` from the platform page into the pending flow. */
export async function submitClaudeLoginCode(input: string): Promise<ClaudeLoginFlow> {
  const entry = active;
  if (!entry || entry.flow.state !== 'pending') throw new Error('No sign-in in progress.');
  const parsed = parseLoginCode(input);
  if (!parsed) throw new Error('Paste the full code shown after signing in (it contains a "#").');
  try {
    await entry.runtime.claudeOAuthCallback(parsed.code, parsed.state);
  } catch (err) {
    // The CLI drops the flow when the token exchange fails. Its wait usually
    // rejects first with a bare HTTP error, which closes the query under this
    // call — so the detail here is noise; say what happened instead.
    logError(`[claude-auth] login flow ${entry.flow.id} code rejected:`, err);
    finish(entry, { state: 'error' });
    entry.flow.error = 'The code was rejected. Start the sign-in again.';
    return { ...entry.flow };
  }
  // Credentials are written by the time the wait resolves; answer with the outcome.
  await Promise.race([entry.settled, new Promise((r) => setTimeout(r, 15_000))]);
  return { ...entry.flow };
}

export function cancelClaudeLogin(): ClaudeLoginFlow | null {
  if (active) finish(active, { state: 'cancelled' });
  return snapshot();
}

export async function claudeLogout(): Promise<{ ok: boolean; output: string; status: ClaudeAuthStatus }> {
  cancelClaudeLogin();
  const { code, stdout, stderr } = await runClaude(['auth', 'logout'], 30_000);
  return { ok: code === 0, output: `${stdout}${stderr}`.trim(), status: await getClaudeAuthStatus() };
}
