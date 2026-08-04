/**
 * Requirement runner — the only thing in the system allowed to decide whether
 * a requirement passes.
 *
 * Command checks run through `bash -lc` in the session's cwd; exit 0 passes.
 * Visual checks take a fresh screenshot of a live browser preview (when the
 * requirement asks for one) and hand it to the judge together with the
 * reference image the agent attached.
 *
 * Runs sequentially on purpose: requirement commands are usually test suites
 * and dev servers, and racing them over the same ports is a great way to
 * produce flaky verdicts.
 */

import { promises as fs } from 'fs';
import { dirname, extname, join } from 'path';
import { CODIBY_DIR } from '../config/config';
import { log } from '../lib/logger';
import { cdpRequest } from '../provider/browser-cdp';
import { sessions } from '../session/sessions';
import { requirementsConfig } from './config';
import { judgeVisual, type JudgeImage } from './judge';
import { listRequirements, markRunning, recordRunResult, snapshotFor } from './repository';
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_OUTPUT_CHARS } from './types';
import type { RequirementRecord } from '../database/schema';

export const REQUIREMENTS_DIR = join(CODIBY_DIR, 'requirements');

type RunnerDeps = {
  broadcastToSession: (sessionId: string, msg: object) => void;
  sendBrowserRequest: (sessionId: string, msg: object) => void;
  /** Names of browser previews currently open in the session. */
  listBrowserPreviews: (sessionId: string) => string[];
};

let deps: RunnerDeps | null = null;

export function configureRequirementsRunner(next: RunnerDeps): void {
  deps = next;
}

/** Sessions with a run in flight — a second trigger is ignored, not queued. */
const running = new Set<string>();

export function broadcastRequirements(sessionId: string): void {
  deps?.broadcastToSession(sessionId, {
    type: 'requirements',
    sessionId,
    ...snapshotFor(sessionId),
  });
}

// ---------------------------------------------------------------------------
// Image storage
// ---------------------------------------------------------------------------

const BASE64_PREFIX = /^data:image\/[a-z+]+;base64,/i;

/**
 * Persist a reference image under `~/.codiby/requirements/<sessionId>/`.
 * Accepts an absolute path (copied, so a screenshot cleanup can't orphan the
 * requirement) or a raw/data-url base64 payload.
 */
export async function storeRequirementImage(
  sessionId: string,
  key: string,
  image: string,
): Promise<string> {
  const dir = join(REQUIREMENTS_DIR, sessionId);
  await fs.mkdir(dir, { recursive: true });

  if (image.startsWith('/')) {
    const ext = extname(image) || '.png';
    const dest = join(dir, `${key}${ext}`);
    await fs.copyFile(image, dest);
    return dest;
  }

  const raw = image.replace(BASE64_PREFIX, '');
  const dest = join(dir, `${key}.png`);
  await fs.writeFile(dest, Buffer.from(raw, 'base64'));
  return dest;
}

async function captureScreenshot(
  sessionId: string,
  requirementId: string,
  preview: string,
  url: string | null,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!deps) return { ok: false, error: 'Requirements runner is not configured.' };
  try {
    if (url) {
      await cdpRequest(sessionId, preview, 'navigate', { url }, deps.sendBrowserRequest);
    }
    const shot = await cdpRequest(sessionId, preview, 'take_screenshot', {}, deps.sendBrowserRequest) as {
      format?: string;
      data: string;
    };
    const dir = join(REQUIREMENTS_DIR, sessionId, 'runs');
    await fs.mkdir(dir, { recursive: true });
    const ext = (shot.format || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
    const dest = join(dir, `${requirementId}-${Date.now()}.${ext}`);
    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.writeFile(dest, Buffer.from(shot.data, 'base64'));
    return { ok: true, path: dest };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

type CheckOutcome = {
  status: 'passing' | 'failing';
  exitCode?: number | null;
  output?: string | null;
  verdict?: string | null;
  imagePath?: string | null;
};

async function runCommandCheck(requirement: RequirementRecord, cwd: string): Promise<CheckOutcome> {
  const command = requirement.command?.trim();
  if (!command) {
    return { status: 'failing', verdict: 'Requirement has no command to run.' };
  }
  const timeoutMs = requirement.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  const proc = Bun.spawn(['bash', '-lc', command], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '1' },
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch {}
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  const output = `${stdout}${stderr}`.slice(-MAX_OUTPUT_CHARS);
  if (timedOut) {
    return {
      status: 'failing',
      exitCode: null,
      output,
      verdict: `Timed out after ${Math.round(timeoutMs / 1000)}s.`,
    };
  }
  return {
    status: exitCode === 0 ? 'passing' : 'failing',
    exitCode,
    output,
    verdict: null,
  };
}

async function runVisualCheck(requirement: RequirementRecord, sessionId: string, cwd: string): Promise<CheckOutcome> {
  const prompt = requirement.judgePrompt?.trim();
  if (!prompt) return { status: 'failing', verdict: 'Requirement has no judge prompt.' };

  const config = requirementsConfig(sessionId);
  const images: JudgeImage[] = [];
  let capturedPath: string | null = null;

  const wantsCapture = config.autoCapture && (requirement.captureBrowser || requirement.captureUrl);
  if (wantsCapture) {
    const open = deps?.listBrowserPreviews(sessionId) ?? [];
    const preview = requirement.captureBrowser ?? open[0];
    if (!preview || !open.includes(preview)) {
      return {
        status: 'failing',
        verdict: requirement.captureBrowser
          ? `Browser preview "${requirement.captureBrowser}" is not open — call browser_open(name="${requirement.captureBrowser}") before running this check.`
          : 'No browser preview is open in this session — call browser_open first so the check has something to capture.',
      };
    }
    const shot = await captureScreenshot(sessionId, requirement.id, preview, requirement.captureUrl);
    if (!shot.ok) return { status: 'failing', verdict: `Could not capture the preview: ${shot.error}` };
    capturedPath = shot.path;
  }

  if (requirement.imagePath) {
    images.push({
      path: requirement.imagePath,
      label: capturedPath ? 'reference design attached to the requirement' : 'state to grade',
    });
  }
  if (capturedPath) {
    images.push({ path: capturedPath, label: 'current state, captured just now' });
  }

  if (images.length === 0) {
    return { status: 'failing', verdict: 'Requirement has no image to grade.' };
  }

  const verdict = await judgeVisual({ prompt, images, model: config.judgeModel, cwd });
  return {
    status: verdict.pass ? 'passing' : 'failing',
    verdict: verdict.reason,
    imagePath: capturedPath,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export type RunSummary = {
  ran: number;
  results: { id: string; title: string; status: 'passing' | 'failing'; detail: string }[];
  progress: ReturnType<typeof snapshotFor>['progress'];
  skipped: string[];
};

/**
 * Run the session's requirements. `ids` narrows the set; omitted runs every
 * requirement that has a check attached. Waived and tampered ones are never
 * executed — a waived requirement is closed, and a tampered one cannot be
 * trusted to describe what it claims.
 */
export async function runRequirements(sessionId: string, ids?: string[]): Promise<RunSummary> {
  const session = sessions.get(sessionId);
  const cwd = session?.cwd || process.cwd();

  const all = listRequirements(sessionId);
  const wanted = ids?.length ? all.filter(r => ids.includes(r.id)) : all;
  const runnable = wanted.filter(r => r.state === 'draft' || r.state === 'locked');
  const skipped = wanted.filter(r => !runnable.includes(r)).map(r => `${r.title} (${r.state})`);

  const results: RunSummary['results'] = [];

  if (running.has(sessionId)) {
    return { ran: 0, results, progress: snapshotFor(sessionId).progress, skipped: ['a run is already in flight'] };
  }
  running.add(sessionId);
  try {
    for (const requirement of runnable) {
      markRunning(sessionId, requirement.id);
      broadcastRequirements(sessionId);

      let outcome: CheckOutcome;
      try {
        outcome = requirement.kind === 'command'
          ? await runCommandCheck(requirement, cwd)
          : await runVisualCheck(requirement, sessionId, cwd);
      } catch (error) {
        outcome = {
          status: 'failing',
          verdict: `Check crashed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      const saved = recordRunResult(sessionId, requirement.id, outcome);
      results.push({
        id: requirement.id,
        title: requirement.title,
        status: saved?.status === 'passing' ? 'passing' : 'failing',
        detail: describeOutcome(requirement, outcome),
      });
      broadcastRequirements(sessionId);
    }
  } finally {
    running.delete(sessionId);
  }

  log(`[requirements:${sessionId.slice(0, 8)}] ran ${results.length} check(s)`);
  return { ran: results.length, results, progress: snapshotFor(sessionId).progress, skipped };
}

function describeOutcome(requirement: RequirementRecord, outcome: CheckOutcome): string {
  if (requirement.kind === 'command') {
    const head = `${requirement.command} (exit ${outcome.exitCode ?? '—'})`;
    if (outcome.status === 'passing') return head;
    const tail = (outcome.verdict || outcome.output || '').trim();
    return tail ? `${head}\n${indent(tail.slice(-600))}` : head;
  }
  return `visual: ${outcome.verdict ?? 'no verdict'}`;
}

function indent(text: string): string {
  return text.split('\n').map(line => `    ${line}`).join('\n');
}

/** Compact, agent-facing rendering of a run. Always shows the real totals. */
export function formatRunSummary(summary: RunSummary): string {
  const { progress } = summary;
  const lines: string[] = [
    `${progress.total} requirement(s) · ${progress.passing} passing · ${progress.failing} failing`
    + (progress.draft ? ` · ${progress.draft} awaiting approval` : '')
    + (progress.waived ? ` · ${progress.waived} waived` : '')
    + (progress.tampered ? ` · ${progress.tampered} TAMPERED` : ''),
    '',
  ];
  for (const result of summary.results) {
    lines.push(`${result.status === 'passing' ? '✓' : '✗'} [${result.id}] ${result.title} — ${result.detail}`);
  }
  if (summary.skipped.length) {
    lines.push('', `Skipped: ${summary.skipped.join(', ')}`);
  }
  if (progress.pendingProposals) {
    lines.push('', `${progress.pendingProposals} change proposal(s) awaiting the user's decision.`);
  }
  if (progress.draft) {
    lines.push('', `${progress.draft} requirement(s) are still drafts and do not count until the user approves them.`);
  }
  return lines.join('\n');
}
