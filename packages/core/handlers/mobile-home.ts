/**
 * Everything the Android Home needs, in one compact response.
 *
 * The phone used to call `/sessions` (~390 KB: every field of every session,
 * archived included) and `/preferences` (~90 KB: group cwd/env/settings the
 * phone never reads) on every refresh, uncompressed, over the Funnel. This
 * trims both to the fields the phone parses, gzips the result, and tags it
 * with an ETag so a refresh where nothing changed is an empty 304.
 */

import { corsHeaders } from '../config/config';

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {};
}

export function buildMobileHome(sessionList: unknown[], prefs: Json) {
  const sessions = sessionList.map(raw => {
    const s = asRecord(raw);
    return {
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      updated_at: s.updated_at,
      status: s.status,
      runtime_status: s.runtime_status,
      provider: s.provider,
    };
  });

  const tabGroups: Record<string, Json> = {};
  for (const [id, raw] of Object.entries(asRecord(prefs.tabGroups))) {
    const g = asRecord(raw);
    tabGroups[id] = { name: g.name, color: g.color, parentId: g.parentId };
  }

  return {
    sessions,
    preferences: {
      tabGroups,
      tabGroupMap: asRecord(prefs.tabGroupMap),
      pinnedSessionIds: Array.isArray(prefs.pinnedSessionIds) ? prefs.pinnedSessionIds : [],
      // Absent stays absent: the phone reads `null` as "never saved" and
      // migrates its local pins once.
      ...(Array.isArray(prefs.pinnedGroupIds) ? { pinnedGroupIds: prefs.pinnedGroupIds } : {}),
    },
  };
}

export function handleMobileHome(req: Request, sessionList: unknown[], prefs: Json): Response {
  const body = JSON.stringify(buildMobileHome(sessionList, prefs));
  const etag = `"${Bun.hash(body).toString(36)}"`;

  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ...corsHeaders, ETag: etag } });
  }

  const headers: Record<string, string> = {
    ...corsHeaders,
    'Content-Type': 'application/json',
    ETag: etag,
    'Cache-Control': 'no-cache',
  };
  if ((req.headers.get('accept-encoding') ?? '').includes('gzip')) {
    headers['Content-Encoding'] = 'gzip';
    return new Response(Bun.gzipSync(body), { headers });
  }
  return new Response(body, { headers });
}
