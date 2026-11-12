/**
 * The agent memory's full-text index (`agent_memory_fts`, FTS5) and the
 * triggers that keep it in step with `agent_memory`.
 *
 * FTS5 is a compile-time SQLite option. Bun's bundled SQLite has it, but a
 * build linked against a system library may not — and the bridge must still
 * start there: agent/memory/memories.ts falls back to LIKE scans when the
 * index is missing.
 */

import { logError } from '../lib/logger';

/** What it takes to run the statements; `bun:sqlite`'s Database fits. */
export interface ExecHandle {
  exec(sql: string): unknown;
}

export const MEMORY_FTS_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_fts USING fts5(
    content, tags, content='agent_memory', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS agent_memory_ai AFTER INSERT ON agent_memory BEGIN
    INSERT INTO agent_memory_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS agent_memory_ad AFTER DELETE ON agent_memory BEGIN
    INSERT INTO agent_memory_fts(agent_memory_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS agent_memory_au AFTER UPDATE ON agent_memory BEGIN
    INSERT INTO agent_memory_fts(agent_memory_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
    INSERT INTO agent_memory_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
  END;
`;

/**
 * Create the index and its triggers. Returns false (and logs why) when this
 * SQLite can't — the triggers are only created together with the table, so a
 * missing FTS5 never leaves `agent_memory` writes tripping over a trigger
 * that points at nothing.
 */
export function ensureMemorySearchIndex(db: ExecHandle): boolean {
  try {
    db.exec('SAVEPOINT memory_fts');
    try {
      db.exec(MEMORY_FTS_SQL);
      db.exec('RELEASE memory_fts');
      return true;
    } catch (err) {
      try { db.exec('ROLLBACK TO memory_fts'); db.exec('RELEASE memory_fts'); } catch {}
      throw err;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(
      `[database] Agent memory search index unavailable (${msg}). ` +
      (/fts5/i.test(msg) ? 'This SQLite was built without FTS5; ' : '') +
      'memory recall falls back to plain text matching.',
    );
    return false;
  }
}
