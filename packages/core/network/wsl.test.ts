import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSTALL_SCRIPT, classifyWslError, isValidDistroName, wslKeepaliveCommand } from './wsl';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

describe('distro names', () => {
  test('accepts what wsl.exe --list prints', () => {
    for (const name of ['Ubuntu', 'Ubuntu-24.04', 'Debian', 'kali-linux', 'my_distro']) expect(isValidDistroName(name)).toBe(true);
  });
  test('rejects anything that could become a wsl.exe option or shell text', () => {
    for (const name of ['', '-d', '--exec', 'a b', 'x;rm', '../x', 42, null]) expect(isValidDistroName(name)).toBe(false);
  });
});

describe('keepalive', () => {
  test('runs start.sh in the chosen distro, then holds it open', () => {
    expect(wslKeepaliveCommand('Ubuntu')).toEqual({
      command: 'wsl.exe',
      args: ['-d', 'Ubuntu', '--exec', 'sh', '-c', '$HOME/.codiby/wsl-bridge/start.sh && exec sleep infinity'],
    });
  });
  test('explains a missing install instead of echoing sh', () => {
    expect(classifyWslError('sh: 1: /home/me/.codiby/wsl-bridge/start.sh: not found\n', 'Ubuntu'))
      .toBe("Codiby isn't installed in Ubuntu — use Install WSL in Settings → Remotes.");
  });
  test('reads the UTF-16 error wsl.exe prints for an unknown distro', () => {
    const utf16 = Buffer.from('There is no distribution with the supplied name.\r\n', 'utf16le').toString('latin1');
    expect(classifyWslError(utf16, 'Nope')).toBe('WSL distro "Nope" not found.');
  });
});

describe('install script', () => {
  /** Run the script under sh with stub tools standing in for curl, wslpath, bun, claude. */
  function install(tools: string[]) {
    const root = mkdtempSync(join(tmpdir(), 'codiby-wsl-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const stub = (path: string, body: string) => {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o755);
    };
    for (const tool of tools) stub(join(bin, tool), 'exit 0');
    // Only the coreutils the script needs, so a host's own curl/unzip can't leak in.
    for (const tool of ['cat', 'chmod', 'cp', 'grep', 'mkdir', 'mv', 'rm', 'sleep']) symlinkSync(Bun.which(tool)!, join(bin, tool));
    stub(join(bin, 'wslpath'), 'echo "$2"');
    stub(join(home, '.bun/bin/bun'), 'exit 0');
    stub(join(home, '.local/bin/claude'), 'exit 0');
    const source = join(root, 'server.js');
    writeFileSync(source, '// bundled bridge');
    const proc = Bun.spawnSync(['/bin/sh', '-s', '--', source, '3112'], {
      stdin: Buffer.from(INSTALL_SCRIPT),
      env: { HOME: home, PATH: bin },
    });
    return { home, stdout: proc.stdout.toString(), code: proc.exitCode };
  }

  test('copies the bridge and writes a start script bound to the chosen port', () => {
    const { home, stdout, code } = install(['curl', 'unzip']);
    expect(code).toBe(0);
    expect(stdout).toContain('STEP:Copying bridge');
    expect(stdout).not.toContain('STEP:Installing Bun');
    const dir = join(home, '.codiby/wsl-bridge');
    expect(readFileSync(join(dir, 'server.js'), 'utf8')).toBe('// bundled bridge');
    const start = readFileSync(join(dir, 'start.sh'), 'utf8');
    expect(statSync(join(dir, 'start.sh')).mode & 0o111).not.toBe(0);
    expect(start).toContain('CLAUDE_UI_PORT=3112 CLAUDE_UI_HOST=127.0.0.1');
    // Expanded inside the distro at start time, not at install time.
    expect(start).toContain('DIR="$HOME/.codiby/wsl-bridge"');
    expect(start).toContain('grep -q server.js "/proc/$(cat "$PID_FILE")/cmdline"');
    expect(start).toContain('--spawned-by=service >>"$DIR/bridge.log"');
  });

  test('stops with the exact fix when a prerequisite is missing', () => {
    const { home, stdout, code } = install(['curl']);
    expect(code).not.toBe(0);
    expect(stdout).toContain('ERROR:Missing: unzip. Install them inside the distro, e.g. sudo apt install -y unzip');
    expect(existsSync(join(home, '.codiby/wsl-bridge/start.sh'))).toBe(false);
  });
});
