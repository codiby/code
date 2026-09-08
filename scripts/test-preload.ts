// `bun test` runs every file in one process, and packages/core/database opens
// its sqlite handle at import time. The first module to reach it fixes the path
// for the whole run, so a test file that sets CODIBY_DATABASE_FILE at its own
// top level loses the race to any earlier file that transitively imports the
// database — and the suite then writes its fixtures into the user's real
// ~/.codiby database.
//
// A preload runs before any test file is loaded, so it is the only place that
// can win that race. database/index.ts refuses to open the real file under
// NODE_ENV=test to keep this from silently regressing.

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const sandbox = mkdtempSync(join(tmpdir(), 'codiby-test-'));

process.env.CODIBY_DATABASE_FILE = join(sandbox, 'database.sqlite');

// The sqlite handle stays open for as long as the process lives, so cleanup
// waits for exit rather than for any one suite to finish.
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }));
