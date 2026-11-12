/**
 * Small persistence helpers for the agent's JSON files under
 * `~/.codiby/agent/`. Writes are atomic (temp file + rename) so a crash or a
 * concurrent read never sees half a file — the bridge reads these on every
 * turn, and a truncated config would silently disable a channel.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { CODIBY_DIR } from '../config/config';

/** `~/.codiby/agent` — or the test sandbox's equivalent. */
export function agentDataDir(...parts: string[]): string {
  return join(CODIBY_DIR, 'agent', ...parts);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

/** Atomic write. `mode` (e.g. 0o600) applies to the final file. */
export function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), mode !== undefined ? { mode } : undefined);
  renameSync(tmp, file);
  if (mode !== undefined) {
    try { chmodSync(file, mode); } catch {}
  }
}

/**
 * A cached, normalised JSON document. `normalize` must accept anything
 * (missing file, old shape, hand-edited garbage) and return a valid value.
 */
export function createJsonStore<T>(opts: {
  file: string;
  normalize: (raw: unknown) => T;
  mode?: number;
}) {
  let cache: T | null = null;
  return {
    get(): T {
      if (cache === null) cache = opts.normalize(readJson<unknown>(opts.file, null));
      return cache;
    },
    set(next: T): T {
      const value = opts.normalize(next);
      writeJsonAtomic(opts.file, value, opts.mode);
      cache = value;
      return value;
    },
    update(fn: (current: T) => T): T {
      return this.set(fn(this.get()));
    },
    /** Drop the cache (tests, or after an external edit). */
    reload(): T {
      cache = null;
      return this.get();
    },
  };
}
