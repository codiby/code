import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LaunchError, applyManagedPreferences, chromiumArgs, launchWithSandboxFallback, parseDevToolsActivePort, type LaunchOptions, type LaunchedChromium } from './launcher';
import type { ChromiumExecutable } from './discovery';

const shell: ChromiumExecutable = { path: '/x/chrome-headless-shell', kind: 'headless-shell', source: 'playwright' };
const full: ChromiumExecutable = { path: '/x/chrome', kind: 'chromium', source: 'playwright' };

describe('chromiumArgs', () => {
  test('carries the required flags and keeps the sandbox by default', () => {
    const args = chromiumArgs({ executable: full, userDataDir: '/p', sandbox: true, platform: 'linux' });
    for (const flag of ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=/p', '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--window-size=1280,900', '--password-store=basic']) {
      expect(args).toContain(flag);
    }
    expect(args).not.toContain('--no-sandbox');
    expect(args.at(-1)).toBe('about:blank');
  });

  test('headless shell uses plain --headless; no-sandbox only when asked', () => {
    const args = chromiumArgs({ executable: shell, userDataDir: '/p', sandbox: false, platform: 'darwin' });
    expect(args[0]).toBe('--headless');
    expect(args).toContain('--no-sandbox');
    expect(args).toContain('--use-mock-keychain');
  });
});

describe('applyManagedPreferences', () => {
  const profiles: string[] = [];
  const profile = () => { const d = mkdtempSync(join(tmpdir(), 'codiby-profile-')); profiles.push(d); return d; };
  const read = (dir: string) => JSON.parse(readFileSync(join(dir, 'Default', 'Preferences'), 'utf-8'));
  afterAll(() => { for (const d of profiles) rmSync(d, { recursive: true, force: true }); });

  test("a new profile starts with Chromium's password manager and autofill off", () => {
    const dir = profile();
    expect(applyManagedPreferences(dir)).toBe(true);
    const prefs = read(dir);
    expect(prefs).toMatchObject({
      credentials_enable_service: false,
      credentials_enable_autosignin: false,
      profile: { password_manager_enabled: false },
      autofill: { profile_enabled: false, credit_card_enabled: false },
    });
    expect(statSync(join(dir, 'Default', 'Preferences')).mode & 0o777).toBe(0o600);
    // Nothing to do the second time.
    expect(applyManagedPreferences(dir)).toBe(false);
  });

  test('an existing profile keeps its other settings; drift is put back', () => {
    const dir = profile();
    mkdirSync(join(dir, 'Default'), { recursive: true });
    writeFileSync(join(dir, 'Default', 'Preferences'), JSON.stringify({
      credentials_enable_service: true,
      profile: { name: 'Person 1', password_manager_enabled: true, exit_type: 'Normal' },
      intl: { accept_languages: 'es-MX,en' },
    }));
    expect(applyManagedPreferences(dir)).toBe(true);
    expect(read(dir)).toMatchObject({
      credentials_enable_service: false,
      profile: { name: 'Person 1', password_manager_enabled: false, exit_type: 'Normal' },
      intl: { accept_languages: 'es-MX,en' },
    });
  });

  test("a file Chromium couldn't parse either is left for Chromium to rebuild", () => {
    const dir = profile();
    mkdirSync(join(dir, 'Default'), { recursive: true });
    writeFileSync(join(dir, 'Default', 'Preferences'), '{"profile": {');
    expect(applyManagedPreferences(dir)).toBe(false);
    expect(readFileSync(join(dir, 'Default', 'Preferences'), 'utf-8')).toBe('{"profile": {');
  });
});

describe('parseDevToolsActivePort', () => {
  test('reads port and browser path', () => {
    expect(parseDevToolsActivePort('53211\n/devtools/browser/abc-123\n')).toEqual({ port: 53211, path: '/devtools/browser/abc-123' });
  });
  test('rejects half-written or foreign files', () => {
    expect(parseDevToolsActivePort('53211\n')).toBeNull();
    expect(parseDevToolsActivePort('x\n/devtools/browser/a')).toBeNull();
    expect(parseDevToolsActivePort('80\n/json')).toBeNull();
  });
});

describe('launchWithSandboxFallback', () => {
  const fake = (sandbox: boolean): LaunchedChromium => ({
    proc: {} as LaunchedChromium['proc'], pid: 1, wsEndpoint: 'ws://x', port: 1, sandbox, exited: new Promise(() => {}), stderrTail: () => '',
  });

  test('retries without the sandbox only for sandbox failures, and reports it', async () => {
    const tried: boolean[] = [];
    const reported: string[] = [];
    const launched = await launchWithSandboxFallback(
      { executable: full, userDataDir: '/p', onSandboxFallback: (e) => reported.push(e.message) },
      async (o: LaunchOptions) => {
        tried.push(o.sandbox);
        if (o.sandbox) throw new LaunchError('No usable sandbox!', 'FATAL: No usable sandbox!', true);
        return fake(false);
      },
    );
    expect(tried).toEqual([true, false]);
    expect(launched.sandbox).toBe(false);
    expect(reported).toEqual(['No usable sandbox!']);
  });

  test('other failures are not retried without the sandbox', async () => {
    const tried: boolean[] = [];
    const err = await launchWithSandboxFallback({ executable: full, userDataDir: '/p' }, async (o) => {
      tried.push(o.sandbox);
      throw new LaunchError('exited (code 1): missing libnss3.so', '', false);
    }).catch(e => e);
    expect(err.message).toContain('libnss3');
    expect(tried).toEqual([true]);
  });

  test('preferNoSandbox skips the doomed first attempt', async () => {
    const tried: boolean[] = [];
    await launchWithSandboxFallback({ executable: full, userDataDir: '/p', preferNoSandbox: true }, async (o) => { tried.push(o.sandbox); return fake(o.sandbox); });
    expect(tried).toEqual([false]);
  });
});
