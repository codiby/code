// Windows terminal shell choice. macOS/Linux keep using `$SHELL`; on Windows
// there is no equivalent the user set on purpose (`%ComSpec%` is always
// cmd.exe), so the pick lives in ui-preferences.json as `windowsShell`.

import { existsSync } from 'fs';
import { join } from 'path';
import { loadPreferences } from '../session/storage';

export type WindowsShellId = 'auto' | 'pwsh' | 'powershell' | 'cmd' | 'git-bash' | 'wsl';

export interface WindowsShellOption {
  id: WindowsShellId;
  label: string;
  /** Resolved executable, or null when it isn't installed on this host. */
  path: string | null;
}

const WINDOWS_SHELL_IDS: readonly WindowsShellId[] = ['auto', 'pwsh', 'powershell', 'cmd', 'git-bash', 'wsl'];

export function isWindowsShellId(v: unknown): v is WindowsShellId {
  return typeof v === 'string' && (WINDOWS_SHELL_IDS as readonly string[]).includes(v);
}

function systemRoot(): string {
  return process.env.SystemRoot || process.env.windir || 'C:\\Windows';
}

function firstExisting(paths: (string | undefined)[]): string | null {
  for (const p of paths) if (p && existsSync(p)) return p;
  return null;
}

function gitBashPath(): string | null {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')];
  const fromRoots = firstExisting(roots.map(r => r && join(r, 'Git', 'bin', 'bash.exe')));
  if (fromRoots) return fromRoots;
  // `git.exe` lives in <Git>\cmd; bash.exe sits next door in <Git>\bin.
  const git = Bun.which('git');
  if (git && /[\\/]cmd[\\/]git\.exe$/i.test(git)) {
    return firstExisting([join(git, '..', '..', 'bin', 'bash.exe')]);
  }
  return null;
}

function resolvePath(id: Exclude<WindowsShellId, 'auto'>): string | null {
  const sys32 = join(systemRoot(), 'System32');
  switch (id) {
    case 'pwsh': return Bun.which('pwsh') || firstExisting([process.env.ProgramFiles && join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe')]);
    case 'powershell': return firstExisting([join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')]) || Bun.which('powershell');
    case 'cmd': return firstExisting([process.env.ComSpec, join(sys32, 'cmd.exe')]);
    case 'git-bash': return gitBashPath();
    case 'wsl': return firstExisting([join(sys32, 'wsl.exe')]);
  }
}

/** Every shell the settings picker offers, with what this host has installed. */
export function listWindowsShells(): WindowsShellOption[] {
  return [
    { id: 'auto', label: 'Default (%ComSpec%)', path: resolvePath('cmd') },
    { id: 'pwsh', label: 'PowerShell 7', path: resolvePath('pwsh') },
    { id: 'powershell', label: 'Windows PowerShell', path: resolvePath('powershell') },
    { id: 'cmd', label: 'Command Prompt', path: resolvePath('cmd') },
    { id: 'git-bash', label: 'Git Bash', path: resolvePath('git-bash') },
    { id: 'wsl', label: 'WSL', path: resolvePath('wsl') },
  ];
}

/** argv for the terminal shell on Windows, honoring the `windowsShell` pref.
 *  Falls back to the old `%ComSpec%` behavior when the pick isn't installed. */
export function windowsShellCommand(): string[] {
  const pref = loadPreferences().windowsShell;
  const id: WindowsShellId = isWindowsShellId(pref) ? pref : 'auto';
  const path = id === 'auto' ? null : resolvePath(id);
  if (!path) return [process.env.ComSpec || 'powershell.exe'];
  switch (id) {
    case 'pwsh':
    case 'powershell': return [path, '-NoLogo'];
    // Login shell so ~/.bash_profile runs, matching the `-l` used on macOS/Linux.
    case 'git-bash': return [path, '--login', '-i'];
    default: return [path];
  }
}
