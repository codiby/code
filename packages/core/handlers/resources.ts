/**
 * Per-session resources: everything a session accumulates that isn't chat —
 * pasted photos, generated mockups, code snippets, uploaded files.
 *
 * On disk, each session owns a folder bucketed by kind so it stays browsable:
 *
 *   ~/.codiby/sessions/<sessionId>/
 *     ├── images/      <resourceId>-<name>.png
 *     ├── mockups/     <resourceId>-<name>.html
 *     ├── snippets/    …
 *     ├── files/       …
 *     ├── other/       …
 *     └── index.json   manifest: metadata for every resource, source of truth
 *
 * Resources are addressed by an opaque `id` (UUID). The blob is served raw at
 * `…/:id/raw`; all metadata (name, kind, mime, size, timestamps) lives in the
 * manifest so the on-disk filename never has to be parsed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { CODIBY_DIR, corsHeaders } from '../config/config';

export type ResourceKind = 'image' | 'mockup' | 'snippet' | 'file' | 'other';

interface ResourceMeta {
  id: string;
  sessionId: string;
  name: string;
  kind: string;
  mime: string;
  ext: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  /** Path relative to the session dir, e.g. `images/<id>-photo.png`. */
  rel: string;
}

const SESSIONS_ROOT = join(CODIBY_DIR, 'sessions');
// A session id is our own UUID; never let a caller escape the sessions root.
const ID_RE = /^[A-Za-z0-9._-]+$/;

/** Map a (freeform) kind to its bucket folder. Unknown kinds land in `other`. */
function kindFolder(kind: string): string {
  switch (kind) {
    case 'image': return 'images';
    case 'mockup': return 'mockups';
    case 'snippet': return 'snippets';
    case 'file': return 'files';
    default: return 'other';
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders });
}
function err(message: string, status: number): Response {
  return json({ error: message }, status);
}

function safeId(id: string): boolean {
  return ID_RE.test(id) && id !== '.' && id !== '..';
}

function sessionDir(sessionId: string): string {
  return join(SESSIONS_ROOT, sessionId);
}
function manifestPath(sessionId: string): string {
  return join(sessionDir(sessionId), 'index.json');
}

function readManifest(sessionId: string): ResourceMeta[] {
  try {
    const raw = JSON.parse(readFileSync(manifestPath(sessionId), 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
function writeManifest(sessionId: string, items: ResourceMeta[]): void {
  mkdirSync(sessionDir(sessionId), { recursive: true });
  writeFileSync(manifestPath(sessionId), JSON.stringify(items, null, 2));
}

/** Public shape — the on-disk `rel` becomes an absolute `path` + a serve `url`. */
function toPublic(m: ResourceMeta) {
  return {
    id: m.id,
    sessionId: m.sessionId,
    name: m.name,
    kind: m.kind,
    mime: m.mime,
    ext: m.ext,
    size: m.size,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    path: join(sessionDir(m.sessionId), m.rel),
    url: `/sessions/${m.sessionId}/resources/${m.id}/raw`,
  };
}

/** Turn an arbitrary display name into a filesystem-safe slug (keeps an ext). */
function slugify(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'resource';
}
function extractExt(name: string, mime: string): string {
  const m = name.match(/\.([A-Za-z0-9]{1,12})$/);
  if (m) return m[1].toLowerCase();
  return MIME_EXT[mime] || '';
}
const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'text/html': 'html', 'text/plain': 'txt',
  'application/json': 'json', 'text/markdown': 'md',
};
const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', html: 'text/html', htm: 'text/html',
  txt: 'text/plain', json: 'application/json', md: 'text/markdown', css: 'text/css',
  js: 'text/javascript', ts: 'text/plain',
};

export function mimeForExt(ext: string): string {
  return EXT_MIME[ext.toLowerCase()] || 'application/octet-stream';
}

// ── handlers ─────────────────────────────────────────────────────────────────

/** GET /sessions/:id/resources[?kind=…] */
export function handleListResources(sessionId: string, kindFilter: string | null): Response {
  if (!safeId(sessionId)) return err('invalid session id', 400);
  let items = readManifest(sessionId);
  if (kindFilter) items = items.filter(m => m.kind === kindFilter);
  items.sort((a, b) => b.createdAt - a.createdAt);
  return json(items.map(toPublic));
}

/** GET /sessions/:id/resources/:rid */
export function handleGetResource(sessionId: string, rid: string): Response {
  if (!safeId(sessionId)) return err('invalid session id', 400);
  const m = readManifest(sessionId).find(r => r.id === rid);
  if (!m) return err('resource not found', 404);
  return json(toPublic(m));
}

/** GET /sessions/:id/resources/:rid/raw — serve the blob bytes. */
export function handleGetResourceRaw(sessionId: string, rid: string): Response {
  if (!safeId(sessionId)) return err('invalid session id', 400);
  const m = readManifest(sessionId).find(r => r.id === rid);
  if (!m) return err('resource not found', 404);
  const abs = join(sessionDir(sessionId), m.rel);
  try {
    const bytes = readFileSync(abs);
    return new Response(bytes, { headers: { ...corsHeaders, 'content-type': m.mime || 'application/octet-stream' } });
  } catch {
    return err('resource file missing', 404);
  }
}

interface CreateInput {
  name?: string;
  kind?: string;
  mime?: string;
  /** base64-encoded bytes (photos, screenshots). */
  data?: string;
  /** raw text (mockups, snippets). */
  content?: string;
  /** already-decoded bytes (multipart upload path). */
  bytes?: Uint8Array;
}

interface SaveOpts {
  /** Replace an existing resource of the same kind + name instead of adding a
   *  duplicate. Used for producers that overwrite in place (e.g. mockups). */
  dedupeByName?: boolean;
}

/**
 * Core writer shared by the HTTP handler and in-process producers (pasted
 * images, generated mockups). Decodes `bytes | data | content`, writes the
 * blob into its kind bucket, and updates the manifest. Throws on bad input or
 * a filesystem failure; callers that need an HTTP surface use `createResource`.
 */
export function saveResource(sessionId: string, input: CreateInput, opts: SaveOpts = {}): ResourceMeta {
  if (!safeId(sessionId)) throw new Error('invalid session id');

  let bytes: Uint8Array;
  if (input.bytes) {
    bytes = input.bytes;
  } else if (typeof input.data === 'string') {
    try { bytes = Uint8Array.from(Buffer.from(input.data, 'base64')); }
    catch { throw new Error('invalid base64 data'); }
  } else if (typeof input.content === 'string') {
    bytes = Buffer.from(input.content, 'utf-8');
  } else {
    throw new Error('one of data | content | file is required');
  }

  const kind = (input.kind || 'file').trim() || 'file';
  const displayName = (input.name || `${kind}-${Date.now()}`).trim();
  const ext = extractExt(displayName, input.mime || '');
  const mime = input.mime || mimeForExt(ext);

  const items = readManifest(sessionId);

  // Overwrite-in-place path: reuse the existing id/rel so the blob and its
  // manifest entry are updated rather than accumulating stale copies.
  const existing = opts.dedupeByName ? items.find(r => r.kind === kind && r.name === displayName) : undefined;
  const id = existing?.id ?? randomUUID();
  const folder = kindFolder(kind);
  const slug = slugify(displayName);
  const rel = existing?.rel ?? join(folder, `${id}-${slug}`);
  const abs = join(sessionDir(sessionId), rel);

  mkdirSync(join(sessionDir(sessionId), folder), { recursive: true });
  writeFileSync(abs, bytes);

  const now = Date.now();
  const meta: ResourceMeta = {
    id, sessionId, name: displayName, kind, mime, ext,
    size: bytes.byteLength,
    createdAt: existing?.createdAt ?? now, updatedAt: now, rel,
  };
  if (existing) {
    items[items.indexOf(existing)] = meta;
  } else {
    items.push(meta);
  }
  writeManifest(sessionId, items);
  return meta;
}

/**
 * HTTP wrapper over `saveResource` — turns thrown errors into JSON responses.
 */
export function createResource(sessionId: string, input: CreateInput): Response {
  try {
    return json(toPublic(saveResource(sessionId, input)), 201);
  } catch (e: any) {
    const bad = /required|invalid/i.test(e?.message || '');
    return err(e?.message || 'failed to create resource', bad ? 400 : 500);
  }
}

/** PATCH /sessions/:id/resources/:rid — rename or re-tag (metadata only). */
export function handleUpdateResource(sessionId: string, rid: string, patch: { name?: string; kind?: string }): Response {
  if (!safeId(sessionId)) return err('invalid session id', 400);
  const items = readManifest(sessionId);
  const m = items.find(r => r.id === rid);
  if (!m) return err('resource not found', 404);
  if (typeof patch.name === 'string' && patch.name.trim()) m.name = patch.name.trim();
  if (typeof patch.kind === 'string' && patch.kind.trim()) m.kind = patch.kind.trim();
  m.updatedAt = Date.now();
  writeManifest(sessionId, items);
  return json(toPublic(m));
}

/** DELETE /sessions/:id/resources/:rid */
export function handleDeleteResource(sessionId: string, rid: string): Response {
  if (!safeId(sessionId)) return err('invalid session id', 400);
  const items = readManifest(sessionId);
  const idx = items.findIndex(r => r.id === rid);
  if (idx < 0) return err('resource not found', 404);
  const [m] = items.splice(idx, 1);
  try { rmSync(join(sessionDir(sessionId), m.rel), { force: true }); } catch {}
  writeManifest(sessionId, items);
  return json({ ok: true });
}

/** Remove a session's entire resource folder — called when the session is deleted. */
export function purgeSessionResources(sessionId: string): void {
  if (!safeId(sessionId)) return;
  const dir = sessionDir(sessionId);
  if (existsSync(dir)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
