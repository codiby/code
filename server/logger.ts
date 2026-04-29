import { appendFileSync } from 'fs';
import { join } from 'path';

export const LOG_FILE = join(import.meta.dir, 'server.log');

export function log(...args: unknown[]) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  console.log(msg);
  try { appendFileSync(LOG_FILE, msg + '\n'); } catch {}
}

export function logError(...args: unknown[]) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ERROR: ${args.map(a => typeof a === 'string' ? a : (a instanceof Error ? a.stack || a.message : JSON.stringify(a))).join(' ')}`;
  console.error(msg);
  try { appendFileSync(LOG_FILE, msg + '\n'); } catch {}
}
