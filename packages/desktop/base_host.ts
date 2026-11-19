/**
 * Which host runs this window's bridge, as the Windows installer chose it
 * (packages/installer writes `%LOCALAPPDATA%\codiby-base\config.json`).
 *
 * With a WSL base the bridge lives in a distro and this app is only its
 * window: "local" is the distro, and the app must never fall back to a bridge
 * of its own on Windows — that would silently make Windows the local host.
 * The file is read on every launch rather than relying on
 * CODIBY_BRIDGE_PORT_OVERRIDE, which a process only sees once Explorer has
 * reloaded the user's environment.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WslBase { distro: string; port: number }

/** The parsed config when it names a WSL base, else null. */
export function parseBaseConfig(raw: string): WslBase | null {
  let cfg: unknown;
  try { cfg = JSON.parse(raw); } catch { return null; }
  if (!cfg || typeof cfg !== 'object') return null;
  const { base, distro, port } = cfg as { base?: unknown; distro?: unknown; port?: unknown };
  if (typeof base !== 'string' || base.toUpperCase() !== 'WSL') return null;
  if (typeof distro !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(distro)) return null;
  const n = Number(port);
  return { distro, port: Number.isInteger(n) && n > 0 && n < 65536 ? n : 3112 };
}

export function baseConfigPath(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'codiby-base', 'config.json') : null;
}

/** The WSL base on this machine, or null (not Windows, no installer config, or a Windows base). */
export function readWslBase(): WslBase | null {
  if (process.platform !== 'win32') return null;
  const path = baseConfigPath();
  if (!path) return null;
  try { return parseBaseConfig(readFileSync(path, 'utf8')); } catch { return null; }
}

/** The process that starts the distro's bridge and keeps the distro alive
 *  (same command as packages/core/network/wsl.ts and the installer's bridge.ps1). */
export function wslKeepalive(distro: string): { command: string; args: string[] } {
  return {
    command: 'wsl.exe',
    args: ['-d', distro, '--exec', 'sh', '-c', '$HOME/.codiby/wsl-bridge/start.sh && exec sleep infinity'],
  };
}

/**
 * A Windows path as the distro sees it, for the native file dialogs: the
 * bridge in the distro can't open `C:\…`.
 *   C:\Users\me\a.txt                → /mnt/c/Users/me/a.txt
 *   \\wsl.localhost\Ubuntu\home\me   → /home/me   (also \\wsl$\…)
 * Anything else (another distro, a network share) is returned unchanged.
 */
export function toWslPath(path: string, distro: string): string {
  const drive = path.match(/^([a-zA-Z]):[\\/]?(.*)$/);
  if (drive) return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, '/')}`.replace(/\/+$/, '') || '/';
  const unc = path.match(/^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/i);
  if (unc && unc[1]!.toLowerCase() === distro.toLowerCase()) return `/${(unc[2] ?? '').replace(/\\/g, '/')}`;
  return path;
}
