/**
 * Claude Code CLI version check + self-update.
 *
 * The SDK drives whatever `claude` binary is installed on this machine
 * (`CLAUDE_BIN`), so the model list, tools and fixes a user gets depend on
 * that binary's version — not on the app's. This module compares the
 * installed version against the npm dist-tag for the user's update channel
 * and runs `claude update` on request.
 *
 *   - `GET  /providers/claude/version` → `getClaudeVersionStatus()`
 *   - `POST /providers/claude/update`  → `runClaudeUpdate()`
 *
 * The registry lookup is cached for an hour; the local `--version` probe is
 * cheap and always fresh so a finished update is reflected immediately.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { CLAUDE_BIN } from '../config/config';

const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags';
const REGISTRY_TTL_MS = 60 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

export type ClaudeVersionStatus = {
  installed: string | null;
  latest: string | null;
  channel: string;
  updateAvailable: boolean;
};

let registryCache: { at: number; tags: Record<string, string> } | null = null;
let updating: Promise<ClaudeUpdateResult> | null = null;

/** `autoUpdatesChannel` from ~/.claude/settings.json — the same channel `claude update` follows. */
function readChannel(): string {
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf-8'));
    if (typeof settings?.autoUpdatesChannel === 'string' && settings.autoUpdatesChannel) {
      return settings.autoUpdatesChannel;
    }
  } catch {}
  return 'latest';
}

export function parseVersion(text: string): string | null {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m[0] : null;
}

/** Negative when a < b, positive when a > b. Compares major.minor.patch only. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function run(args: string[], timeoutMs: number): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn([CLAUDE_BIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, output: `${stdout}${stderr}`.trim() };
  } finally {
    clearTimeout(timer);
  }
}

async function installedVersion(): Promise<string | null> {
  try {
    const { code, output } = await run(['--version'], 15_000);
    return code === 0 ? parseVersion(output) : null;
  } catch {
    return null;
  }
}

async function distTags(): Promise<Record<string, string> | null> {
  if (registryCache && Date.now() - registryCache.at < REGISTRY_TTL_MS) return registryCache.tags;
  try {
    const resp = await fetch(DIST_TAGS_URL, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return registryCache?.tags ?? null;
    const tags = (await resp.json()) as Record<string, string>;
    registryCache = { at: Date.now(), tags };
    return tags;
  } catch {
    return registryCache?.tags ?? null;
  }
}

export async function getClaudeVersionStatus(): Promise<ClaudeVersionStatus> {
  const channel = readChannel();
  const [installed, tags] = await Promise.all([installedVersion(), distTags()]);
  const latest = tags?.[channel] ?? tags?.latest ?? null;
  return {
    installed,
    latest,
    channel,
    updateAvailable: !!installed && !!latest && compareVersions(installed, latest) < 0,
  };
}

export type ClaudeUpdateResult = {
  ok: boolean;
  output: string;
  status: ClaudeVersionStatus;
};

/** Runs `claude update`. Concurrent callers share the same run. */
export function runClaudeUpdate(): Promise<ClaudeUpdateResult> {
  if (updating) return updating;
  updating = (async () => {
    let code = 1;
    let output = '';
    try {
      ({ code, output } = await run(['update'], UPDATE_TIMEOUT_MS));
    } catch (err) {
      output = err instanceof Error ? err.message : String(err);
    }
    const status = await getClaudeVersionStatus();
    return { ok: code === 0 && !status.updateAvailable, output, status };
  })().finally(() => { updating = null; });
  return updating;
}
