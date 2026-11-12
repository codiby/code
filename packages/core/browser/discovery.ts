/**
 * Finds a Chromium build the bridge can drive headlessly.
 *
 * Order (first hit wins):
 *   1. `CODIBY_CHROMIUM_PATH` — an explicit choice is never second-guessed: if
 *      it points at nothing usable we report that instead of silently picking
 *      another browser.
 *   2. Playwright's headless shell, newest revision first. It is the smallest
 *      build and is what `npx playwright install` leaves on most servers.
 *   3. Playwright's full Chromium / Chrome for Testing, newest first.
 *   4. A system Google Chrome or Chromium.
 *
 * All filesystem access goes through `DiscoveryFs` so tests can describe a
 * layout instead of needing real binaries.
 */

import { accessSync, constants, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export type ChromiumKind = 'headless-shell' | 'chromium' | 'chrome';

export interface ChromiumExecutable {
  path: string;
  kind: ChromiumKind;
  source: 'env' | 'playwright' | 'system';
  /** Playwright revision (the `-1243` suffix), when known. */
  revision?: number;
}

export interface DiscoveryFs {
  /** Entry names of a directory; empty when it does not exist. */
  readdir(dir: string): string[];
  isExecutable(file: string): boolean;
}

export interface DiscoveryContext {
  env: Record<string, string | undefined>;
  home: string;
  platform: NodeJS.Platform;
  fs: DiscoveryFs;
}

export type DiscoveryResult =
  | { ok: true; executable: ChromiumExecutable }
  | { ok: false; error: string };

export const nodeDiscoveryFs: DiscoveryFs = {
  readdir(dir) {
    try { return readdirSync(dir); } catch { return []; }
  },
  isExecutable(file) {
    try {
      if (!statSync(file).isFile()) return false;
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

export function defaultDiscoveryContext(): DiscoveryContext {
  return { env: process.env, home: homedir(), platform: process.platform, fs: nodeDiscoveryFs };
}

function playwrightRoots(ctx: DiscoveryContext): string[] {
  const roots: string[] = [];
  const custom = ctx.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  // "0" means "inside node_modules", which a bridge has no business scanning.
  if (custom && custom !== '0') roots.push(custom);
  roots.push(join(ctx.home, '.cache', 'ms-playwright'));
  if (ctx.platform === 'darwin') roots.push(join(ctx.home, 'Library', 'Caches', 'ms-playwright'));
  return [...new Set(roots)];
}

/** `chromium-1243` → 1243 for the given prefix, else null. */
function revisionOf(entry: string, prefix: string): number | null {
  if (!entry.startsWith(prefix)) return null;
  const rev = Number(entry.slice(prefix.length));
  return Number.isInteger(rev) && rev > 0 ? rev : null;
}

function revisionDirs(ctx: DiscoveryContext, prefix: string): { dir: string; revision: number }[] {
  const found: { dir: string; revision: number }[] = [];
  for (const root of playwrightRoots(ctx)) {
    for (const entry of ctx.fs.readdir(root)) {
      const revision = revisionOf(entry, prefix);
      if (revision !== null) found.push({ dir: join(root, entry), revision });
    }
  }
  return found.sort((a, b) => b.revision - a.revision);
}

/** Playwright nests each build in a platform folder: chrome-linux64, chrome-mac-arm64, chrome-headless-shell-linux64… */
function platformFolders(ctx: DiscoveryContext, dir: string): string[] {
  return ctx.fs.readdir(dir).filter(e => e.startsWith('chrome-')).sort().map(e => join(dir, e));
}

const HEADLESS_SHELL_BINARIES = ['chrome-headless-shell', 'headless_shell'];
const CHROMIUM_BINARIES = [
  'chrome',
  join('Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  join('Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
];

function playwrightBuilds(ctx: DiscoveryContext, prefix: string, binaries: string[], kind: ChromiumKind): ChromiumExecutable[] {
  const out: ChromiumExecutable[] = [];
  for (const { dir, revision } of revisionDirs(ctx, prefix)) {
    for (const folder of platformFolders(ctx, dir)) {
      for (const bin of binaries) {
        const path = join(folder, bin);
        if (ctx.fs.isExecutable(path)) out.push({ path, kind, source: 'playwright', revision });
      }
    }
  }
  return out;
}

function systemBrowsers(ctx: DiscoveryContext): ChromiumExecutable[] {
  const paths: string[] = [];
  if (ctx.platform === 'darwin') {
    for (const base of ['/Applications', join(ctx.home, 'Applications')]) {
      paths.push(
        join(base, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
        join(base, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      );
    }
  } else if (ctx.platform === 'linux') {
    paths.push(
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    );
  }
  return paths
    .filter(p => ctx.fs.isExecutable(p))
    .map(path => ({ path, kind: /chromium/i.test(path) ? 'chromium' as const : 'chrome' as const, source: 'system' as const }));
}

function kindFromPath(path: string): ChromiumKind {
  if (/headless[_-]shell/i.test(path)) return 'headless-shell';
  if (/chromium/i.test(path)) return 'chromium';
  return 'chrome';
}

/** Every usable build, best first. */
export function chromiumCandidates(ctx: DiscoveryContext = defaultDiscoveryContext()): ChromiumExecutable[] {
  return [
    ...playwrightBuilds(ctx, 'chromium_headless_shell-', HEADLESS_SHELL_BINARIES, 'headless-shell'),
    ...playwrightBuilds(ctx, 'chromium-', CHROMIUM_BINARIES, 'chromium'),
    ...systemBrowsers(ctx),
  ];
}

export function chromiumNotFoundMessage(platform: NodeJS.Platform = process.platform): string {
  const where = platform === 'darwin'
    ? '~/Library/Caches/ms-playwright, ~/.cache/ms-playwright or /Applications'
    : '~/.cache/ms-playwright or /usr/bin';
  return [
    `No Chromium found on this host (looked in ${where}).`,
    'Install one with `bunx playwright install chromium-headless-shell` (or `chromium`),',
    'or point CODIBY_CHROMIUM_PATH at a Chrome/Chromium binary, then try again.',
  ].join(' ');
}

export function discoverChromium(ctx: DiscoveryContext = defaultDiscoveryContext()): DiscoveryResult {
  const explicit = ctx.env.CODIBY_CHROMIUM_PATH?.trim();
  if (explicit) {
    if (!ctx.fs.isExecutable(explicit)) {
      return { ok: false, error: `CODIBY_CHROMIUM_PATH is set to "${explicit}", which is not an executable file.` };
    }
    return { ok: true, executable: { path: explicit, kind: kindFromPath(explicit), source: 'env' } };
  }
  const [best] = chromiumCandidates(ctx);
  return best ? { ok: true, executable: best } : { ok: false, error: chromiumNotFoundMessage(ctx.platform) };
}
