/**
 * Drop the bundled `codiby` CLI into `~/.local/bin/` so users can spawn a
 * new session from a terminal with `codiby [path]`.
 *
 * Best-effort: any failure is swallowed (no $HOME, read-only fs, etc.)
 * since the desktop app itself works without the CLI. No-op on Windows.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

function resolveScriptPath(): string | null {
  // Packaged: bundled into extraResources/scripts/codiby
  if (app.isPackaged) {
    return join(process.resourcesPath, 'scripts', 'codiby');
  }
  // Dev: read directly from the repo
  const projectRoot = join(__dirname, '..');
  const p = join(projectRoot, 'scripts', 'codiby');
  return existsSync(p) ? p : null;
}

export function installCliScript(): void {
  if (platform() === 'win32') return;

  const home = process.env.HOME || homedir();
  if (!home) return;

  const srcPath = resolveScriptPath();
  if (!srcPath) return;

  let script: string;
  try {
    script = readFileSync(srcPath, 'utf8');
  } catch {
    return;
  }

  const binDir = join(home, '.local', 'bin');
  const dst = join(binDir, 'codiby');

  // Skip the write if on-disk copy matches; refresh otherwise so app
  // upgrades automatically update the CLI.
  try {
    const existing = readFileSync(dst, 'utf8');
    if (existing === script) return;
  } catch {}

  try { mkdirSync(binDir, { recursive: true }); } catch { return; }
  try { writeFileSync(dst, script, 'utf8'); } catch { return; }
  try { chmodSync(dst, 0o755); } catch {}
}
