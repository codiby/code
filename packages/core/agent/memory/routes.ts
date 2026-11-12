/**
 * `/agent/memory/*` and `/agent/people/*` — the Agent view's Memory tab.
 * All authed (the bridge's bearer token); stores validate every field and
 * their MemoryErrors become 4xx responses here.
 */

import { isAgentEnabled } from '../config';
import { HttpError, json, readBody } from '../http';
import { registerRoutes } from '../registry';
import type { AgentRouteHandler } from '../types';
import { MemoryError } from './errors';
import {
  MEMORY_KINDS,
  addMemory,
  clampInt,
  countMemoriesByKind,
  forgetMemory,
  listMemories,
  parseKind,
  searchMemories,
  updateMemory,
} from './memories';
import { createPerson, deletePerson, findPeople, listPeople, updatePerson } from './people';
import { dailyRotationStatus, isRotating, onRotationSettingsChanged, rotateNow } from './rotation';
import { loadMemorySettings, memoryStateStore, patchMemorySettings } from './settings';

const MAX_QUERY = 500;

/** Map store errors to HTTP errors; anything else is a 500 handled by agent/routes.ts. */
function guarded(handler: AgentRouteHandler): AgentRouteHandler {
  return async (req, params, url) => {
    try {
      return await handler(req, params, url);
    } catch (err) {
      if (err instanceof MemoryError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
}

async function objectBody(req: Request): Promise<Record<string, unknown>> {
  const body = await readBody<unknown>(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Request body must be a JSON object');
  return body as Record<string, unknown>;
}

function queryParam(url: URL): string {
  const q = (url.searchParams.get('query') ?? url.searchParams.get('q') ?? '').trim();
  if (q.length > MAX_QUERY) throw new HttpError(400, `query is too long (max ${MAX_QUERY} characters)`);
  return q;
}

function memoryStatus() {
  const state = memoryStateStore.get();
  return {
    settings: loadMemorySettings(),
    state: {
      lastRotatedAt: state.lastRotatedAt,
      lastConsolidation: state.lastConsolidation,
      rotating: isRotating(),
      ...dailyRotationStatus(),
    },
  };
}

registerRoutes([
  // Specific paths before `/agent/memory/:id`, so "settings" is never read as an id.
  {
    method: 'GET',
    path: '/agent/memory/settings',
    handler: () => json(memoryStatus()),
  },
  {
    method: 'PUT',
    path: '/agent/memory/settings',
    handler: guarded(async (req) => {
      const body = await objectBody(req);
      const daily = body.dailyRotation;
      if (daily !== undefined && (!daily || typeof daily !== 'object' || Array.isArray(daily))) {
        throw new HttpError(400, 'dailyRotation must be an object');
      }
      const d = (daily ?? {}) as Record<string, unknown>;
      if (d.enabled !== undefined && typeof d.enabled !== 'boolean') throw new HttpError(400, 'dailyRotation.enabled must be true or false');
      if (d.time !== undefined && (typeof d.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time))) {
        throw new HttpError(400, 'dailyRotation.time must be HH:MM (24-hour)');
      }
      if (body.consolidateOnRotate !== undefined && typeof body.consolidateOnRotate !== 'boolean') {
        throw new HttpError(400, 'consolidateOnRotate must be true or false');
      }
      const before = loadMemorySettings();
      const after = patchMemorySettings({ dailyRotation: { enabled: d.enabled, time: d.time }, consolidateOnRotate: body.consolidateOnRotate });
      onRotationSettingsChanged(before, after);
      return json(memoryStatus());
    }),
  },
  {
    method: 'POST',
    path: '/agent/memory/rotate',
    handler: () => {
      if (!isAgentEnabled()) throw new HttpError(409, 'The agent is off on this host');
      const { started } = rotateNow();
      if (!started) throw new HttpError(409, 'A fresh thread is already being started');
      return json({ ok: true, ...memoryStatus() }, 202);
    },
  },
  {
    method: 'GET',
    path: '/agent/memory',
    handler: guarded((_req, _params, url) => {
      const query = queryParam(url);
      const kindParam = url.searchParams.get('kind');
      const kind = kindParam ? parseKind(kindParam) : undefined;
      const limit = clampInt(url.searchParams.get('limit'), 1, 200, 50);
      const offset = clampInt(url.searchParams.get('offset'), 0, 1_000_000, 0);
      const counts = countMemoriesByKind();
      if (query) {
        const items = searchMemories({ query, kind, limit });
        return json({ items, total: items.length, counts, kinds: MEMORY_KINDS });
      }
      const { items, total } = listMemories({ kind, limit, offset });
      return json({ items, total, counts, kinds: MEMORY_KINDS });
    }),
  },
  {
    method: 'POST',
    path: '/agent/memory',
    handler: guarded(async (req) => {
      const body = await objectBody(req);
      const { item, created } = addMemory({ content: body.content, kind: body.kind, tags: body.tags, pinned: body.pinned, source: 'owner' });
      return json({ item, created }, created ? 201 : 200);
    }),
  },
  {
    method: 'PATCH',
    path: '/agent/memory/:id',
    handler: guarded(async (req, params) => {
      const body = await objectBody(req);
      const item = updateMemory(params.id, { content: body.content, kind: body.kind, tags: body.tags, pinned: body.pinned });
      return json({ item });
    }),
  },
  {
    method: 'DELETE',
    path: '/agent/memory/:id',
    handler: guarded((_req, params) => {
      forgetMemory(params.id);
      return json({ ok: true });
    }),
  },
  {
    method: 'GET',
    path: '/agent/people',
    handler: guarded((_req, _params, url) => {
      const query = queryParam(url);
      return json({ people: query ? findPeople(query, 50) : listPeople() });
    }),
  },
  {
    method: 'POST',
    path: '/agent/people',
    handler: guarded(async (req) => {
      const body = await objectBody(req);
      const person = createPerson({ name: body.name, aliases: body.aliases, relation: body.relation, handles: body.handles, notes: body.notes });
      return json({ person }, 201);
    }),
  },
  {
    method: 'PATCH',
    path: '/agent/people/:id',
    handler: guarded(async (req, params) => {
      const body = await objectBody(req);
      const person = updatePerson(params.id, { name: body.name, aliases: body.aliases, relation: body.relation, handles: body.handles, notes: body.notes }, 'replace');
      return json({ person });
    }),
  },
  {
    method: 'DELETE',
    path: '/agent/people/:id',
    handler: guarded((_req, params) => {
      deletePerson(params.id);
      return json({ ok: true });
    }),
  },
]);
