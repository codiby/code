/**
 * GitHub-releases autoupdater (macOS).
 *
 * Flow:
 *   1. Poll the GitHub "latest release" API on boot + every few hours.
 *   2. If the release tag is a higher semver than `app.getVersion()`, push an
 *      `update-event { type: 'available' }` to the renderer, which shows a
 *      banner.
 *   3. When the user accepts, download the matching `.dmg` to a temp dir
 *      (streaming progress events), then hand it to the privileged installer
 *      script via `osascript … with administrator privileges` — that is the
 *      native "sudo" prompt. The script quits the running app, swaps the
 *      bundle in /Applications, and relaunches it as the console user.
 *
 * Everything privileged lives in `scripts/electron-install-update.sh`, bundled
 * into the app via `extraResources`.
 */
import { app, ipcMain, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'codiby/code';
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const FIRST_CHECK_DELAY_MS = 8_000; // let the boot settle first

export type ReleaseInfo = {
  version: string; // tag without a leading 'v'
  notes: string;
  assetUrl: string;
  assetName: string;
};

/** Strict-enough semver compare: returns true when `a` > `b` (major.minor.patch). */
function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/** Pick the right `.dmg` for this Mac's architecture, falling back to any dmg. */
function pickDmgAsset(assets: Array<{ name: string; browser_download_url: string }>): { name: string; browser_download_url: string } | null {
  const dmgs = assets.filter((a) => a.name.toLowerCase().endsWith('.dmg'));
  if (dmgs.length === 0) return null;
  const wantArm = process.arch === 'arm64';
  const archMatch = dmgs.find((a) =>
    wantArm ? /arm64/i.test(a.name) : /(x64|intel|x86_64)/i.test(a.name),
  );
  return archMatch ?? dmgs[0];
}

export async function checkForUpdate(): Promise<ReleaseInfo | null> {
  let res: Response;
  try {
    res = await fetch(LATEST_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'codiby-code-updater',
      },
    });
  } catch {
    return null; // offline / DNS — silent
  }
  if (!res.ok) return null;

  const rel = (await res.json()) as {
    tag_name?: string;
    draft?: boolean;
    prerelease?: boolean;
    body?: string;
    assets?: Array<{ name: string; browser_download_url: string }>;
  };
  if (!rel.tag_name || rel.draft || rel.prerelease) return null;

  const latest = rel.tag_name.replace(/^v/, '');
  if (!semverGt(latest, app.getVersion())) return null;

  const asset = pickDmgAsset(rel.assets ?? []);
  if (!asset) return null;

  return {
    version: latest,
    notes: rel.body ?? '',
    assetUrl: asset.browser_download_url,
    assetName: asset.name,
  };
}

function send(win: BrowserWindow | null, payload: { type: string; info?: ReleaseInfo; progress?: number; message?: string }): void {
  if (win && !win.isDestroyed()) win.webContents.send('update-event', payload);
}

async function downloadAsset(info: ReleaseInfo, win: BrowserWindow | null): Promise<string> {
  const dest = join(tmpdir(), `codiby-update-${info.version}-${info.assetName}`);
  const res = await fetch(info.assetUrl, { headers: { 'User-Agent': 'codiby-code-updater' } });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  let lastPct = -1;

  const file = createWriteStream(dest);
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.length;
      await new Promise<void>((resolve, reject) =>
        file.write(Buffer.from(value), (err) => (err ? reject(err) : resolve())),
      );
      if (total) {
        const pct = Math.floor((received / total) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          send(win, { type: 'progress', progress: received / total });
        }
      }
    }
  } finally {
    await new Promise<void>((resolve) => file.end(resolve));
  }
  return dest;
}

/**
 * Launch the privileged installer. `osascript … with administrator privileges`
 * shows the native authentication dialog and runs the script as root, so the
 * bundle swap works even when /Applications/Codiby Code.app is root-owned. The
 * script itself quits the running app, copies the new bundle, and relaunches.
 */
function runPrivilegedInstall(dmgPath: string): void {
  const script = join(process.resourcesPath, 'scripts', 'electron-install-update.sh');
  // Single-quote each path for the shell; neither path contains single quotes.
  const shellCmd = `/bin/bash '${script}' '${dmgPath}'`;
  // Escape double quotes for the surrounding AppleScript string literal.
  const appleScript = `do shell script "${shellCmd.replace(/"/g, '\\"')}" with administrator privileges`;
  const child = spawn('osascript', ['-e', appleScript], { detached: true, stdio: 'ignore' });
  child.unref();
}

export function registerUpdaterIpc(getWindow: () => BrowserWindow | null): void {
  // Manual "check now" from the UI.
  ipcMain.handle('app:update_check', async () => {
    return await checkForUpdate();
  });

  // Download + kick off the privileged install. The installer handles quitting
  // and relaunching the app, so we don't quit here — the auth dialog appears
  // over the still-running app.
  ipcMain.handle('app:update_download_and_install', async (_e, { info }: { info: ReleaseInfo }) => {
    const win = getWindow();
    if (process.platform !== 'darwin') {
      send(win, { type: 'error', message: 'Auto-update is only supported on macOS in this build.' });
      return { ok: false };
    }
    try {
      const dmgPath = await downloadAsset(info, win);
      runPrivilegedInstall(dmgPath);
      send(win, { type: 'installing' });
      return { ok: true };
    } catch (err) {
      send(win, { type: 'error', message: err instanceof Error ? err.message : String(err) });
      return { ok: false };
    }
  });
}

let started = false;

export function startUpdateChecks(getWindow: () => BrowserWindow | null): void {
  if (started || !app.isPackaged || process.platform !== 'darwin') return;
  started = true;

  const run = async () => {
    const info = await checkForUpdate().catch(() => null);
    if (info) send(getWindow(), { type: 'available', info });
  };

  setTimeout(run, FIRST_CHECK_DELAY_MS);
  setInterval(run, CHECK_INTERVAL_MS);
}
