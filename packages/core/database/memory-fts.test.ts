import { describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ensureMemorySearchIndex } from './memory-fts';

const MEMORY_TABLE = `
  CREATE TABLE agent_memory (
    id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '', source TEXT, pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_used_at INTEGER, deleted_at INTEGER
  );
`;

describe('ensureMemorySearchIndex', () => {
  test('creates the index and the triggers that feed it', () => {
    const db = new Database(':memory:');
    db.exec(MEMORY_TABLE);
    expect(ensureMemorySearchIndex(db)).toBe(true);
    expect(ensureMemorySearchIndex(db)).toBe(true); // idempotent on every boot
    db.query(`INSERT INTO agent_memory (id, kind, content, created_at, updated_at) VALUES ('m1', 'fact', 'Café de olla los domingos', 1, 1)`).run();
    const hits = db.query(`SELECT rowid FROM agent_memory_fts WHERE agent_memory_fts MATCH '"cafe"*'`).all();
    expect(hits).toHaveLength(1);
    db.close();
  });

  test('a SQLite without FTS5 logs a clear error and leaves no half-made index', () => {
    const db = new Database(':memory:');
    db.exec(MEMORY_TABLE);
    // Stand-in for a build without the module: the CREATE VIRTUAL TABLE fails.
    const noFts = {
      exec(sql: string) {
        if (/USING fts5/.test(sql)) throw new Error('no such module: fts5');
        return db.exec(sql);
      },
    };
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(ensureMemorySearchIndex(noFts)).toBe(false);
      const logged = errors.mock.calls.map(c => String(c[0])).join('\n');
      expect(logged).toMatch(/without FTS5/);
      expect(logged).toMatch(/falls back to plain text matching/);
    } finally {
      errors.mockRestore();
    }
    // agent_memory still takes writes: no trigger points at a missing table.
    const triggers = db.query(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all();
    expect(triggers).toEqual([]);
    db.query(`INSERT INTO agent_memory (id, kind, content, created_at, updated_at) VALUES ('m1', 'fact', 'x', 1, 1)`).run();
    db.close();
  });
});
