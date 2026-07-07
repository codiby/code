import { appendFileSync } from 'fs';
import { join } from 'path';

export const LOG_FILE = join(import.meta.dir, 'server.log');
export const CRASH_FILE = join(import.meta.dir, 'crash.log');

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
 * Synchronously dump everything we can about a fatal native signal (SIGILL,
 * SIGSEGV, ...) to a dedicated crash.log. SIGILL on this stack is almost always
 * Bun itself panicking — Bun prints its native trace + a bun.report URL to
 * stderr, which run.sh now tees into logs/bridge.log. This handler adds the
 * JS-side context (stack, memory, versions) at the moment of the signal so the
 * two logs together pinpoint the crash.
 */
function dumpFatalSignal(signal: string) {
  const ts = new Date().toISOString();
  let stack = '(no stack)';
  try { stack = new Error('crash-stack-capture').stack || stack; } catch {}
  let mem = '(unavailable)';
  try {
    const m = process.memoryUsage();
    mem = `rss=${(m.rss / 1048576).toFixed(1)}MB heapUsed=${(m.heapUsed / 1048576).toFixed(1)}MB heapTotal=${(m.heapTotal / 1048576).toFixed(1)}MB`;
  } catch {}
  const dump = [
    '',
    '============================================================',
    `[${ts}] FATAL NATIVE SIGNAL: ${signal}`,
    `pid=${process.pid} bun=${process.versions?.bun ?? '?'} node=${process.versions?.node ?? '?'} platform=${process.platform}`,
    `memory: ${mem}`,
    `uptime: ${process.uptime().toFixed(1)}s`,
    'JS stack at signal delivery (may be incomplete for hard CPU traps):',
    stack,
    'NOTE: SIGILL/SIGABRT from Bun is usually a Bun panic — check logs/bridge.log',
    '      and logs/build.log for the native trace + bun.report URL.',
    '============================================================',
    '',
  ].join('\n');
  try { appendFileSync(CRASH_FILE, dump); } catch {}
  try { appendFileSync(LOG_FILE, dump); } catch {}
  try { console.error(dump); } catch {}
}

/**
 * Last-resort safety net: log any error that escaped a try/catch instead of
 * letting it tear the process down. A single unhandled throw or rejected
 * promise anywhere in the bridge would otherwise kill the sidecar and every
 * live session with it. We deliberately keep the process alive — the goal is
 * that one bad request / provider event never crashes the whole app.
 *
 * We also install best-effort handlers for fatal native signals. These can't
 * always run for a hard CPU trap, but when the signal is deliverable to JS they
 * capture a crash dump before re-raising the default action (which still lets
 * Bun emit its native trace and the process die).
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

  const FATAL_SIGNALS = ['SIGILL', 'SIGSEGV', 'SIGBUS', 'SIGFPE', 'SIGABRT'] as const;
  for (const sig of FATAL_SIGNALS) {
    try {
      process.on(sig as NodeJS.Signals, () => {
        dumpFatalSignal(sig);
        // Re-raise the default disposition so the process still dies (and Bun
        // can emit its native trace) instead of returning to the faulting
        // instruction and looping.
        try { process.removeAllListeners(sig as NodeJS.Signals); } catch {}
        try { process.kill(process.pid, sig as NodeJS.Signals); } catch { process.exit(1); }
      });
    } catch {
      // Some signals aren't catchable on every platform/runtime — ignore.
    }
  }

  // Record clean/exit codes too, so a silent exit is still attributable.
  process.on('exit', (code) => {
    if (code !== 0) {
      try { appendFileSync(CRASH_FILE, `[${new Date().toISOString()}] [${context}] process exit code=${code}\n`); } catch {}
    }
  });
}
