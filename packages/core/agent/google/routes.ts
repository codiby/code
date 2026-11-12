/**
 * HTTP routes for the Google connection. All are authenticated by the bridge
 * except the OAuth callback, which Google's redirect reaches without a token
 * and which authenticates itself with the one-time `state`.
 */

import { logError } from '../../lib/logger';
import { HttpError, json, readBody } from '../http';
import { hasAgentDeps, agentDeps } from '../runtime';
import type { AgentRoute } from '../types';
import { suggestPublicBaseUrl } from './detect';
import {
  GoogleAuthError,
  completeAuthorization,
  disconnectGoogle,
  getOAuthClient,
  loadTokens,
  setOAuthClient,
  deleteOAuthClient,
  startAuthorization,
} from './oauth';
import {
  CALENDAR_LEVELS,
  GMAIL_LEVELS,
  normalizePublicBaseUrl,
  updateGoogleSettings,
  type CalendarLevel,
  type GmailLevel,
} from './settings';
import { googleStatus } from './status';

// ---------------------------------------------------------------------------
// Callback page
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * The page Google's redirect lands on. No script, no secrets, and no
 * referrer: the URL that loaded it carried the authorization code.
 */
export function callbackPage(ok: boolean, heading: string, detail: string, status = ok ? 200 : 400): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(heading)} · Codiby</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1012;color:#e4e4e7;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:420px;padding:28px 32px;border:1px solid #27272a;border-radius:12px;background:#17181b;text-align:center}
h1{font-size:17px;margin:0 0 8px;color:${ok ? '#86efac' : '#fcd34d'}}
p{margin:0;color:#a1a1aa;font-size:13px}
</style></head>
<body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}

async function handleCallback(url: URL): Promise<Response> {
  try {
    const { email } = await completeAuthorization({
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      error: url.searchParams.get('error'),
    });
    return callbackPage(true, 'Connected — you can close this tab', `Codiby can now use Google${email ? ` as ${email}` : ''}.`);
  } catch (err) {
    if (err instanceof GoogleAuthError) return callbackPage(false, "Couldn't connect Google", err.message);
    logError(`[google] callback failed: ${err instanceof Error ? err.stack || err.message : err}`);
    return callbackPage(false, "Couldn't connect Google", 'Something went wrong on the Codiby side. Try connecting again.', 500);
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function str(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new HttpError(400, `${key} must be a string`);
  return v;
}

/** Accepts {clientId, clientSecret} or the JSON file Google Cloud offers for download. */
function readClient(body: Record<string, unknown>): { clientId: string; clientSecret: string } {
  const pasted = str(body, 'credentialsJson');
  if (pasted) {
    if (pasted.length > 10_000) throw new HttpError(400, 'That JSON is too large to be an OAuth client file');
    let parsed: Record<string, any>;
    try { parsed = JSON.parse(pasted); } catch { throw new HttpError(400, "That isn't valid JSON — paste the whole client_secret_….json file"); }
    // Desktop clients only allow loopback redirects, so they can't reach the public callback.
    if (parsed?.installed) throw new HttpError(400, 'This is a Desktop client. Create a "Web application" OAuth client instead.');
    const c = parsed?.web ?? parsed;
    if (typeof c?.client_id !== 'string' || typeof c?.client_secret !== 'string') {
      throw new HttpError(400, 'The JSON has no client_id / client_secret');
    }
    return { clientId: c.client_id, clientSecret: c.client_secret };
  }
  const clientId = str(body, 'clientId');
  const clientSecret = str(body, 'clientSecret');
  if (!clientId || !clientSecret) throw new HttpError(400, 'clientId and clientSecret are required');
  return { clientId, clientSecret };
}

function level<T extends string>(body: Record<string, unknown>, key: string, values: readonly T[]): T | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    throw new HttpError(400, `${key} must be one of: ${values.join(', ')}`);
  }
  return v as T;
}

function asHttpError(err: unknown): never {
  if (err instanceof GoogleAuthError) throw new HttpError(400, err.message);
  if (err instanceof HttpError) throw err;
  if (err instanceof Error) throw new HttpError(400, err.message);
  throw err;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const GOOGLE_ROUTES: AgentRoute[] = [
  {
    method: 'GET',
    path: '/agent/google/status',
    handler: () => json(googleStatus()),
  },
  {
    method: 'PUT',
    path: '/agent/google/client',
    handler: async (req) => {
      const { clientId, clientSecret } = readClient(await readBody<Record<string, unknown>>(req));
      const previous = getOAuthClient();
      // Validates first, so a typo never costs the owner a working connection.
      try { setOAuthClient(clientId, clientSecret); } catch (err) { asHttpError(err); }
      // Tokens are bound to the client that minted them: a different client can't refresh them.
      if (previous && previous.client_id !== getOAuthClient()?.client_id && loadTokens()) await disconnectGoogle();
      return json(googleStatus());
    },
  },
  {
    method: 'DELETE',
    path: '/agent/google/client',
    handler: async () => {
      if (loadTokens()) await disconnectGoogle();
      deleteOAuthClient();
      return json(googleStatus());
    },
  },
  {
    method: 'PUT',
    path: '/agent/google/settings',
    handler: async (req) => {
      const body = await readBody<Record<string, unknown>>(req);
      const gmail = level<GmailLevel>(body, 'gmail', GMAIL_LEVELS);
      const calendar = level<CalendarLevel>(body, 'calendar', CALENDAR_LEVELS);
      const rawBase = str(body, 'publicBaseUrl');
      let publicBaseUrl: string | undefined;
      if (rawBase !== undefined) {
        try { publicBaseUrl = normalizePublicBaseUrl(rawBase); } catch (err) { asHttpError(err); }
      }
      updateGoogleSettings(s => ({
        ...s,
        ...(gmail ? { gmail } : {}),
        ...(calendar ? { calendar } : {}),
        ...(publicBaseUrl !== undefined ? { publicBaseUrl } : {}),
      }));
      return json(googleStatus());
    },
  },
  {
    method: 'GET',
    path: '/agent/google/detect-base-url',
    handler: async () => {
      if (!hasAgentDeps()) return json({ url: null, detail: 'The bridge is still starting — try again in a moment.' });
      return json(await suggestPublicBaseUrl(agentDeps().port));
    },
  },
  {
    method: 'GET',
    path: '/agent/google/auth/start',
    // A GET, but it opens a sign-in whose tokens the agent then acts with: a
    // localhost caller (the agent's own Bash or browser) must not be able to
    // connect an account — its own, say — in place of the owner's.
    sensitive: true,
    handler: () => {
      try {
        const { url, expiresAt, redirectUri, scopes } = startAuthorization();
        return json({ url, expiresAt, redirectUri, scopes });
      } catch (err) {
        return asHttpError(err);
      }
    },
  },
  {
    method: 'GET',
    path: '/agent/google/callback',
    public: true,
    handler: (_req, _params, url) => handleCallback(url),
  },
  {
    method: 'POST',
    path: '/agent/google/disconnect',
    handler: async () => {
      const { revoked } = await disconnectGoogle();
      return json({ ok: true, revoked });
    },
  },
];
