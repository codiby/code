/**
 * HTTP entry point for `/agent/*`. index.ts calls `handleAgentRoute` before
 * its own bearer-token check, passing how the request is authenticated;
 * routes marked `public` authenticate themselves (webhook secrets, OAuth
 * state), every other route requires the bridge's normal auth, and
 * `sensitive` ones (owner changes, secrets — every mutation by default) also
 * want the bearer token or the bridge's own UI, not just any localhost caller.
 */

import { and, desc, eq } from 'drizzle-orm';
import { database } from '../database';
import { agentMessages } from '../database/schema';
import { logError } from '../lib/logger';
import { OWNER_READ_VERIFICATION_ERROR, OWNER_VERIFICATION_ERROR } from '../network/local-trust';
import { getSessionState } from '../session/state';
import { agentHostLabel, isAgentEnabled, loadAgentConfig, patchAgentConfig } from './config';
import { HttpError, errorJson, json, readBody } from './http';
import { listChannels } from './outbox';
import { emitAgentConfigChanged, matchRoute, registerRoutes, syncAgentLifecycle } from './registry';
import { applyAgentConfigToSession, getAgentSession, ensureAgentSession, syncAgentSessionName, AGENT_SESSION_ID } from './session';
import type { AgentRequestAuth, AgentRoute } from './types';

/**
 * Paths that are sensitive whichever area registers them and whatever they
 * say: the vault's secrets (even their names map out what the owner has
 * logged into) and a channel's secret.
 */
const ALWAYS_SENSITIVE = [/^\/agent\/secrets(?:\/|$)/, /^\/agent\/channels\/:[^/]+\/secret$/];

/**
 * Reads that hand out the owner's personal data — conversations, the people
 * directory, memories, which channels reach the owner, the activity log and
 * pending approvals. The desktop UI (same-origin page) and token holders keep
 * reading them; an unverified local caller does not.
 */
const SENSITIVE_READS = [
  /^\/agent\/messages$/,
  /^\/agent\/people(?:\/|$)/,
  /^\/agent\/memory(?:\/|$)/,
  /^\/agent\/channels$/,
  /^\/agent\/activity$/,
  /^\/agent\/approvals$/,
];

/** Explicit flag, else every non-public mutation (see AgentRoute.sensitive). */
export function isSensitiveRoute(route: AgentRoute): boolean {
  if (route.public) return false;
  if (ALWAYS_SENSITIVE.some(re => re.test(route.path))) return true;
  if (route.method === 'GET' && SENSITIVE_READS.some(re => re.test(route.path))) return true;
  return route.sensitive ?? route.method !== 'GET';
}

/**
 * `auth` is what index.ts established. A plain boolean (in-process callers and
 * tests) means fully trusted or not at all.
 */
export async function handleAgentRoute(req: Request, url: URL, auth: boolean | AgentRequestAuth): Promise<Response | null> {
  if (url.pathname !== '/agent' && !url.pathname.startsWith('/agent/')) return null;
  const { authenticated, ownerVerified } = typeof auth === 'boolean' ? { authenticated: auth, ownerVerified: auth } : auth;
  const match = matchRoute(req.method, url.pathname);
  if (!match) return errorJson('Not found', 404);
  if ('methodNotAllowed' in match) return errorJson('Method not allowed', 405);
  if (!match.route.public && !authenticated) return new Response('Unauthorized', { status: 401 });
  // The agent session's own Bash is a localhost caller too: `curl -X PUT
  // localhost:3111/agent/config` must not be how a prompt injection adds an
  // owner, reveals a webhook token or approves its own request.
  if (isSensitiveRoute(match.route) && !ownerVerified) {
    return errorJson(req.method === 'GET' ? OWNER_READ_VERIFICATION_ERROR : OWNER_VERIFICATION_ERROR, 403);
  }
  try {
    return await match.route.handler(req, match.params, url);
  } catch (err) {
    if (err instanceof HttpError) return errorJson(err.message, err.status);
    logError(`[agent] ${req.method} ${url.pathname} failed: ${err instanceof Error ? err.stack || err.message : err}`);
    // Public routes answer anyone on the internet: keep internals (paths,
    // upstream responses) for the log and the owner's own UI.
    return errorJson(authenticated && err instanceof Error ? err.message : 'Internal error', 500);
  }
}

function channelSummaries() {
  return listChannels().map(ch => ({
    id: ch.id,
    type: ch.type,
    name: ch.name,
    capabilities: ch.capabilities,
    status: ch.status(),
    ownerPaired: !!ch.ownerAddress(),
  }));
}

registerRoutes([
  {
    method: 'GET',
    path: '/agent/status',
    handler: () => {
      const cfg = loadAgentConfig();
      const session = getAgentSession();
      const state = session ? getSessionState(AGENT_SESSION_ID) : null;
      return json({
        enabled: cfg.enabled,
        host: agentHostLabel(),
        persona: cfg.persona,
        session: session ? {
          id: session.id,
          name: session.name,
          runtimeStatus: session.runtimeStatus,
          permissionMode: session.permissionMode,
          isStreaming: !!state?.isStreaming,
          pendingApproval: state?.permRequest ? { requestId: state.permRequest.requestId, toolName: state.permRequest.toolName } : null,
          messageCount: state?.messages.length ?? 0,
        } : null,
        channels: channelSummaries(),
      });
    },
  },
  {
    method: 'GET',
    path: '/agent/config',
    // Who the agent obeys: the owner's Telegram chats, WhatsApp numbers and
    // emails. The app reads it as a same-origin page (Sec-Fetch-Site) or with
    // the token; the agent's own `curl localhost` does not.
    sensitive: true,
    handler: () => json(loadAgentConfig()),
  },
  {
    method: 'PUT',
    path: '/agent/config',
    // Who the agent obeys (owner ids) lives here.
    sensitive: true,
    handler: async (req) => {
      const body = await readBody<Record<string, unknown>>(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be a JSON object');
      const before = loadAgentConfig();
      const allowed = ['enabled', 'persona', 'owner', 'workspaceDir', 'quietHours', 'preferredChannel', 'provider', 'model'];
      const patch: Record<string, unknown> = {};
      for (const k of allowed) if (k in body) patch[k] = body[k];
      const next = patchAgentConfig(patch);
      syncAgentSessionName();
      applyAgentConfigToSession(before, next);
      // Queued behind any start or stop still running; it re-reads `enabled`
      // when its turn comes, so a quick on/off leaves the areas off.
      if (before.enabled !== next.enabled) await syncAgentLifecycle(isAgentEnabled, ensureAgentSession);
      emitAgentConfigChanged(next, before);
      return json(next);
    },
  },
  {
    method: 'GET',
    path: '/agent/messages',
    handler: (_req, _params, url) => {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const direction = url.searchParams.get('direction');
      const trusted = url.searchParams.get('trusted');
      const conds = [];
      if (direction === 'in' || direction === 'out') conds.push(eq(agentMessages.direction, direction));
      if (trusted === 'true' || trusted === 'false') conds.push(eq(agentMessages.trusted, trusted === 'true'));
      const rows = database.select().from(agentMessages)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(agentMessages.createdAt))
        .limit(limit)
        .all();
      return json({ messages: rows });
    },
  },
  {
    method: 'POST',
    path: '/agent/messages/:id/handled',
    handler: (_req, params) => {
      database.update(agentMessages).set({ handledAt: Date.now(), updatedAt: Date.now() }).where(eq(agentMessages.id, params.id!)).run();
      return json({ ok: true });
    },
  },
]);
