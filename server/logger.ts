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

/**
 * Last-resort safety net: log any error that escaped a try/catch instead of
 * letting it tear the process down. A single unhandled throw or rejected
 * promise anywhere in the bridge would otherwise kill the sidecar and every
 * live session with it. We deliberately keep the process alive — the goal is
 * that one bad request / provider event never crashes the whole app.
 *
 * Idempotent: safe to call more than once (won't stack duplicate listeners).
 */
let globalErrorHandlersRegistered = false;
export function registerGlobalErrorHandlers(context = 'server') {
  if (globalErrorHandlersRegistered) return;
  globalErrorHandlersRegistered = true;
  process.on('uncaughtException', (err) => {
    logError(`[${context}] Uncaught exception (kept process alive):`, err);
  });
  process.on('unhandledRejection', (reason) => {
    logError(`[${context}] Unhandled promise rejection (kept process alive):`, reason instanceof Error ? reason : String(reason));
  });
}
