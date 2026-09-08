import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { CODIBY_DIR } from '../config/config';
import * as schema from './schema';

// Opening the handle here means the first module to import this file fixes the
// path for the whole process. Under `bun test` that first import is whichever
// suite happens to run first, so a test file cannot reliably point itself at a
// sandbox — scripts/test-preload.ts does it before any of them load. Failing
// loudly here beats a suite quietly writing its fixtures into the real data.
if (process.env.NODE_ENV === 'test' && !process.env.CODIBY_DATABASE_FILE) {
  throw new Error(
    'Refusing to open the real database under `bun test`: CODIBY_DATABASE_FILE is unset. ' +
    'Run tests from the repo root so bunfig.toml loads scripts/test-preload.ts.',
  );
}

export const DATABASE_FILE = process.env.CODIBY_DATABASE_FILE || join(CODIBY_DIR, 'database.sqlite');
mkdirSync(CODIBY_DIR, { recursive: true });

const sqlite = new Database(DATABASE_FILE, { create: true, readwrite: true });
sqlite.exec('PRAGMA journal_mode = WAL;');
sqlite.exec('PRAGMA foreign_keys = ON;');
sqlite.exec('PRAGMA busy_timeout = 5000;');
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT,
    trigger_type TEXT NOT NULL DEFAULT 'cron',
    cron_expression TEXT, timezone TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, prompt TEXT NOT NULL, cwd TEXT NOT NULL,
    provider TEXT NOT NULL, model TEXT, permission_mode TEXT NOT NULL, effort TEXT,
    concurrency_policy TEXT NOT NULL DEFAULT 'skip', max_runtime_ms INTEGER,
    next_run_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS automations_enabled_next_run_idx
    ON automations (enabled, next_run_at);
  CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY NOT NULL, automation_id TEXT NOT NULL,
    automation_name TEXT NOT NULL, session_id TEXT, trigger TEXT NOT NULL,
    scheduled_for INTEGER, status TEXT NOT NULL, started_at INTEGER,
    finished_at INTEGER, duration_ms INTEGER, result_text TEXT, error TEXT,
    stop_reason TEXT, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS automation_runs_automation_created_idx
    ON automation_runs (automation_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS automation_runs_session_idx ON automation_runs (session_id);
  CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_scheduled_once_idx
    ON automation_runs (automation_id, scheduled_for) WHERE scheduled_for IS NOT NULL;
  CREATE TABLE IF NOT EXISTS session_targets (
    session_id TEXT PRIMARY KEY NOT NULL, target TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_requirements (
    id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL,
    position INTEGER NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL,
    command TEXT, timeout_ms INTEGER,
    judge_prompt TEXT, image_path TEXT, capture_browser TEXT, capture_url TEXT,
    state TEXT NOT NULL DEFAULT 'draft', status TEXT NOT NULL DEFAULT 'pending',
    waiver_reason TEXT,
    last_exit_code INTEGER, last_output TEXT, last_verdict TEXT,
    last_image_path TEXT, last_run_at INTEGER,
    prev_hash TEXT, signature TEXT NOT NULL, result_signature TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_requirements_session_idx
    ON session_requirements (session_id, position);
  CREATE TABLE IF NOT EXISTS requirement_proposals (
    id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL, action TEXT NOT NULL, payload TEXT,
    reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL, resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS requirement_proposals_session_idx
    ON requirement_proposals (session_id, status);
  CREATE TABLE IF NOT EXISTS requirement_events (
    id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL,
    requirement_id TEXT, event TEXT NOT NULL, actor TEXT NOT NULL,
    detail TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS requirement_events_session_idx
    ON requirement_events (session_id, created_at DESC);
`);

// ---------------------------------------------------------------------------
// Additive migrations for databases created before a column existed. The
// CREATE TABLE statements above only apply to fresh databases, so anything that
// changed shape after shipping has to be patched here — guarded so it is safe
// to run on every boot.
// ---------------------------------------------------------------------------

type ColumnInfo = { name: string; notnull: number };

function columnsOf(table: string): ColumnInfo[] {
  return sqlite.query(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

{
  const columns = columnsOf('automations');

  // Webhook-triggered automations — added alongside the cron-only original.
  if (!columns.some(c => c.name === 'trigger_type')) {
    sqlite.exec(`ALTER TABLE automations ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'cron'`);
  }

  // `cron_expression` started out NOT NULL; webhook automations have no cron, so
  // the constraint has to go. SQLite cannot drop NOT NULL in place, so rebuild
  // the table — the only way to relax the column without losing rows.
  if (columns.some(c => c.name === 'cron_expression' && c.notnull === 1)) {
    sqlite.exec('PRAGMA foreign_keys = OFF;');
    sqlite.transaction(() => {
      sqlite.exec(`
        CREATE TABLE automations_migrated (
          id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT,
          trigger_type TEXT NOT NULL DEFAULT 'cron',
          cron_expression TEXT, timezone TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1, prompt TEXT NOT NULL, cwd TEXT NOT NULL,
          provider TEXT NOT NULL, model TEXT, permission_mode TEXT NOT NULL, effort TEXT,
          concurrency_policy TEXT NOT NULL DEFAULT 'skip', max_runtime_ms INTEGER,
          next_run_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          deleted_at INTEGER
        );
        INSERT INTO automations_migrated
          SELECT id, name, description, trigger_type, cron_expression, timezone,
                 enabled, prompt, cwd, provider, model, permission_mode, effort,
                 concurrency_policy, max_runtime_ms, next_run_at, created_at,
                 updated_at, deleted_at
          FROM automations;
        DROP TABLE automations;
        ALTER TABLE automations_migrated RENAME TO automations;
        CREATE INDEX IF NOT EXISTS automations_enabled_next_run_idx
          ON automations (enabled, next_run_at);
      `);
    })();
    sqlite.exec('PRAGMA foreign_keys = ON;');
  }
}

export const database = drizzle(sqlite, { schema });
export function closeDatabase(): void { sqlite.close(); }
