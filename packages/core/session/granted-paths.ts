/**
 * Read grants for files the user attached to a message.
 *
 * Dropping a file into the composer puts a `[name · size](codiby-file:/abs/path)`
 * badge in the outgoing text (large pastes use `codiby-snippet:`). Those paths
 * usually live outside the session cwd, so a Read would raise an approval card
 * for a file the user just handed over. Sending the message is the consent:
 * every linked path is granted to the session, and the bridge auto-approves
 * read-only tools that target exactly that file — or anything under an
 * attached folder, whose link ends in `/`.
 */
import { resolve, sep } from 'path';
import type { Session } from '../types';

// Attached files wrap the path in `<…>` so spaces and parentheses survive.
const LINK_RE = /\]\(codiby-(?:file|snippet):(?:<([^>]+)>|([^)]+))\)/g;
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead']);

/** Grant every attachment linked from `text`. Returns the granted paths. */
export function grantAttachedPaths(session: Session, text: string): string[] {
  const granted: string[] = [];
  for (const match of text.matchAll(LINK_RE)) {
    const raw = (match[1] ?? match[2]!).trim();
    if (!raw.startsWith('/')) continue;
    // `resolve` collapses `..`, so a folder grant can't be walked out of.
    const path = resolve(raw) + (raw.endsWith('/') ? sep : '');
    (session.grantedReadPaths ||= new Set()).add(path);
    granted.push(path);
  }
  return granted;
}

/** True when `toolName` is read-only and its target was attached by the user. */
export function isGrantedRead(session: Session, toolName: string, input: Record<string, unknown>): boolean {
  const grants = session.grantedReadPaths;
  if (!grants?.size || !READ_TOOLS.has(toolName)) return false;
  const target = input.file_path ?? input.notebook_path ?? input.path;
  if (typeof target !== 'string' || !target.startsWith('/')) return false;
  const path = resolve(target);
  for (const grant of grants) {
    if (grant.endsWith(sep) ? (path + sep).startsWith(grant) : path === grant) return true;
  }
  return false;
}
