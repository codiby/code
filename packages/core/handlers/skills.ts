/**
 * Skills CRUD across multiple agent conventions.
 *
 * A "skill" is a markdown document (optionally with YAML frontmatter carrying
 * `name`, `description`, `allowed-tools`) that different coding agents load from
 * their own directories. We surface all of them behind a single `/skills`
 * resource so the UI treats them uniformly — the originating agent is just a
 * `source` field on each returned object, never part of the route.
 *
 * Three sources, two scopes (user = home dir, project = a repo root):
 *
 *   source    | user                          | project
 *   ----------|-------------------------------|--------------------------
 *   claude    | ~/.claude/skills              | <root>/.claude/skills
 *   opencode  | ~/.config/opencode/skill(s)   | <root>/.opencode/skill(s)
 *   agent     | ~/.agent/skills               | <root>/.agent/skills
 *
 * Each skill lives either as a directory containing `SKILL.md` (the portable
 * form) or as a single `<name>.md` file. Reads accept both; creates default to
 * the directory form.
 *
 * A skill is addressed by an opaque `id` — base64url of its descriptor
 * (scope + source + name + format + file path). The client never builds an id;
 * it echoes back whatever the list endpoint returned, so update/delete need no
 * scope/source/root query params.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import { corsHeaders } from '../config/config';

export type SkillScope = 'user' | 'project';
export type SkillSource = 'claude' | 'opencode' | 'agent';
export type SkillFormat = 'dir' | 'file';

const SOURCES: SkillSource[] = ['claude', 'opencode', 'agent'];
const SKILL_MARKER = 'SKILL.md';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface SkillDescriptor {
  scope: SkillScope;
  source: SkillSource;
  name: string;
  format: SkillFormat;
  /** Absolute path to the markdown file (the `SKILL.md` for dir form). */
  file: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders });
}
function err(message: string, status: number): Response {
  return json({ error: message }, status);
}

/**
 * Candidate directories for a source+scope, in write-preference order. Reads
 * scan all of them; writes target the first one that already exists (else the
 * first). opencode is listed twice (`skill`/`skills`) because its directory
 * name has varied across versions.
 */
function candidateDirs(source: SkillSource, scope: SkillScope, root?: string): string[] {
  const home = homedir();
  if (scope === 'user') {
    switch (source) {
      case 'claude': return [join(home, '.claude', 'skills')];
      case 'opencode': return [
        join(home, '.config', 'opencode', 'skill'),
        join(home, '.config', 'opencode', 'skills'),
        join(home, '.opencode', 'skill'),
        join(home, '.opencode', 'skills'),
      ];
      case 'agent': return [join(home, '.agent', 'skills')];
    }
  }
  // project
  const r = root!;
  switch (source) {
    case 'claude': return [join(r, '.claude', 'skills')];
    case 'opencode': return [join(r, '.opencode', 'skill'), join(r, '.opencode', 'skills')];
    case 'agent': return [join(r, '.agent', 'skills')];
  }
}

function primaryWriteDir(source: SkillSource, scope: SkillScope, root?: string): string {
  const dirs = candidateDirs(source, scope, root);
  return dirs.find(existsSync) ?? dirs[0];
}

// ── id encode/decode ────────────────────────────────────────────────────────

function encodeId(d: SkillDescriptor): string {
  return Buffer.from(JSON.stringify(d), 'utf-8').toString('base64url');
}
function decodeId(id: string): SkillDescriptor | null {
  try {
    const d = JSON.parse(Buffer.from(id, 'base64url').toString('utf-8'));
    if (d && typeof d.file === 'string' && typeof d.name === 'string') return d as SkillDescriptor;
  } catch {}
  return null;
}

// ── frontmatter ──────────────────────────────────────────────────────────────

interface Frontmatter { name?: string; description?: string; allowedTools?: string[]; }

/** Split a raw markdown doc into its YAML frontmatter fields and the body. */
function parseFrontmatter(raw: string): { data: Frontmatter; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: raw };
  const body = raw.slice(m[0].length);
  const data: Frontmatter = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2].trim();
    if (key === 'name') data.name = unquote(val);
    else if (key === 'description') data.description = unquote(val);
    else if (key === 'allowed-tools' || key === 'allowedtools') data.allowedTools = parseList(val);
  }
  return { data, body };
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
function parseList(val: string): string[] {
  let s = val.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  return s.split(',').map(x => unquote(x.trim())).filter(Boolean);
}

/** Rebuild a raw doc from frontmatter fields + body. */
function serialize(fm: Frontmatter, body: string): string {
  const lines: string[] = ['---'];
  if (fm.name) lines.push(`name: ${fm.name}`);
  if (fm.description != null) lines.push(`description: ${fm.description}`);
  if (fm.allowedTools && fm.allowedTools.length) lines.push(`allowed-tools: ${fm.allowedTools.join(', ')}`);
  lines.push('---', '');
  return lines.join('\n') + (body.startsWith('\n') ? body.slice(1) : body);
}

// ── discovery ────────────────────────────────────────────────────────────────

/** Turn one directory entry into a descriptor, or null if it isn't a skill. */
function entryToDescriptor(dir: string, entryName: string, scope: SkillScope, source: SkillSource): SkillDescriptor | null {
  const full = join(dir, entryName);
  let st;
  try { st = statSync(full); } catch { return null; }
  if (st.isDirectory()) {
    const marker = join(full, SKILL_MARKER);
    if (!existsSync(marker)) return null;
    return { scope, source, name: entryName, format: 'dir', file: marker };
  }
  if (st.isFile() && entryName.toLowerCase().endsWith('.md') && entryName !== SKILL_MARKER) {
    return { scope, source, name: entryName.replace(/\.md$/i, ''), format: 'file', file: full };
  }
  return null;
}

function discover(scope: SkillScope, root?: string): SkillDescriptor[] {
  const out: SkillDescriptor[] = [];
  const seen = new Set<string>();
  for (const source of SOURCES) {
    for (const dir of candidateDirs(source, scope, root)) {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { continue; }
      for (const name of entries) {
        const d = entryToDescriptor(dir, name, scope, source);
        if (d && !seen.has(d.file)) { seen.add(d.file); out.push(d); }
      }
    }
  }
  return out;
}

/** Public shape returned to clients. `content`/`body` only on detail reads. */
function toSummary(d: SkillDescriptor, fm: Frontmatter) {
  return {
    id: encodeId(d),
    name: fm.name || d.name,
    source: d.source,
    scope: d.scope,
    format: d.format,
    description: fm.description ?? '',
    allowedTools: fm.allowedTools ?? [],
    path: d.file,
  };
}

function readDescriptor(d: SkillDescriptor) {
  const raw = readFileSync(d.file, 'utf-8');
  const { data, body } = parseFrontmatter(raw);
  return { ...toSummary(d, data), content: raw, body };
}

// ── handlers ─────────────────────────────────────────────────────────────────

/** GET /skills?scope=user | scope=project&root=<path> */
export function handleListSkills(scope: string | null, root: string | null): Response {
  if (scope !== 'user' && scope !== 'project') return err("scope must be 'user' or 'project'", 400);
  if (scope === 'project') {
    if (!root) return err('root required for project scope', 400);
    if (!existsSync(root)) return err('root does not exist', 404);
  }
  const items = discover(scope, root ?? undefined).map(d => {
    try {
      const { data } = parseFrontmatter(readFileSync(d.file, 'utf-8'));
      return toSummary(d, data);
    } catch {
      return toSummary(d, {});
    }
  });
  items.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
  return json(items);
}

/** GET /skills/:id */
export function handleGetSkill(id: string): Response {
  const d = decodeId(id);
  if (!d) return err('invalid skill id', 400);
  if (!existsSync(d.file)) return err('skill not found', 404);
  try {
    return json(readDescriptor(d));
  } catch (e: any) {
    return err(e.message, 500);
  }
}

interface CreateBody {
  name?: string;
  description?: string;
  content?: string;
  body?: string;
  source?: SkillSource;
  allowedTools?: string[];
  format?: SkillFormat;
}

/** POST /skills?scope=…&root=… */
export function handleCreateSkill(scope: string | null, root: string | null, body: CreateBody): Response {
  if (scope !== 'user' && scope !== 'project') return err("scope must be 'user' or 'project'", 400);
  if (scope === 'project' && !root) return err('root required for project scope', 400);

  const name = (body.name || '').trim();
  if (!NAME_RE.test(name)) return err('invalid name (allowed: letters, digits, . _ -)', 400);

  const source: SkillSource = body.source && SOURCES.includes(body.source) ? body.source : 'agent';
  const format: SkillFormat = body.format === 'file' ? 'file' : 'dir';

  const baseDir = primaryWriteDir(source, scope, root ?? undefined);
  const file = format === 'dir' ? join(baseDir, name, SKILL_MARKER) : join(baseDir, `${name}.md`);
  if (existsSync(file)) return err('skill already exists', 409);

  // A caller can pass either full `content` (written verbatim) or structured
  // fields (name/description/allowedTools + `body`) we assemble into one.
  const raw = body.content != null
    ? body.content
    : serialize(
        { name, description: body.description ?? '', allowedTools: body.allowedTools },
        body.body ?? `\n# ${name}\n`,
      );

  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, raw, 'utf-8');
  } catch (e: any) {
    return err(e.message, 500);
  }

  const d: SkillDescriptor = { scope, source, name, format, file };
  return json(readDescriptor(d), 201);
}

interface UpdateBody {
  name?: string;
  description?: string;
  content?: string;
  body?: string;
  allowedTools?: string[];
}

/** PUT /skills/:id */
export function handleUpdateSkill(id: string, patch: UpdateBody): Response {
  const d = decodeId(id);
  if (!d) return err('invalid skill id', 400);
  if (!existsSync(d.file)) return err('skill not found', 404);

  try {
    let raw: string;
    if (patch.content != null) {
      // Full-document replace.
      raw = patch.content;
    } else {
      // Field-level patch: keep existing frontmatter/body, override what's given.
      const cur = parseFrontmatter(readFileSync(d.file, 'utf-8'));
      const fm: Frontmatter = {
        name: patch.name ?? cur.data.name ?? d.name,
        description: patch.description ?? cur.data.description ?? '',
        allowedTools: patch.allowedTools ?? cur.data.allowedTools,
      };
      raw = serialize(fm, patch.body ?? cur.body);
    }
    writeFileSync(d.file, raw, 'utf-8');
    return json(readDescriptor(d));
  } catch (e: any) {
    return err(e.message, 500);
  }
}

/** DELETE /skills/:id */
export function handleDeleteSkill(id: string): Response {
  const d = decodeId(id);
  if (!d) return err('invalid skill id', 400);
  // Dir-form skills own their whole folder; remove it. File-form removes the .md.
  const target = d.format === 'dir' ? dirname(d.file) : d.file;
  if (!existsSync(target)) return err('skill not found', 404);
  // Guard: never delete a bare skills root, only a named child of it.
  if (basename(target) === '') return err('refusing to delete skills root', 400);
  try {
    rmSync(target, { recursive: true, force: true });
    return json({ ok: true });
  } catch (e: any) {
    return err(e.message, 500);
  }
}
