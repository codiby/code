import { describe, expect, test } from 'bun:test';
import { chromiumCandidates, chromiumNotFoundMessage, discoverChromium, type DiscoveryContext } from './discovery';

/** Describe a filesystem as a list of executable files; directories are implied. */
function fakeFs(executables: string[]): DiscoveryContext['fs'] {
  const files = new Set(executables);
  return {
    readdir(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const f of files) {
        if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split('/')[0]!);
      }
      return [...names];
    },
    isExecutable: (file) => files.has(file),
  };
}

function ctx(platform: NodeJS.Platform, executables: string[], env: Record<string, string> = {}): DiscoveryContext {
  return { env, home: '/home/me', platform, fs: fakeFs(executables) };
}

const PW = '/home/me/.cache/ms-playwright';

describe('discoverChromium', () => {
  test('prefers the newest Playwright headless shell, both binary spellings', () => {
    const c = ctx('linux', [
      `${PW}/chromium_headless_shell-1169/chrome-linux/headless_shell`,
      `${PW}/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell`,
      `${PW}/chromium-1243/chrome-linux64/chrome`,
      '/usr/bin/google-chrome',
    ]);
    const r = discoverChromium(c);
    expect(r).toEqual({
      ok: true,
      executable: { path: `${PW}/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell`, kind: 'headless-shell', source: 'playwright', revision: 1208 },
    });
    // Everything is still listed, best first.
    expect(chromiumCandidates(c).map(e => [e.kind, e.revision ?? null])).toEqual([
      ['headless-shell', 1208],
      ['headless-shell', 1169],
      ['chromium', 1243],
      ['chrome', null],
    ]);
  });

  test('falls back to Playwright Chromium, then the system browser', () => {
    expect(discoverChromium(ctx('linux', [`${PW}/chromium-1243/chrome-linux64/chrome`, `${PW}/chromium-1169/chrome-linux/chrome`]))).toMatchObject({
      ok: true, executable: { path: `${PW}/chromium-1243/chrome-linux64/chrome`, kind: 'chromium', revision: 1243 },
    });
    expect(discoverChromium(ctx('linux', ['/usr/bin/chromium-browser']))).toMatchObject({
      ok: true, executable: { path: '/usr/bin/chromium-browser', kind: 'chromium', source: 'system' },
    });
  });

  test('skips revision folders that are not complete installs', () => {
    const r = discoverChromium(ctx('linux', [`${PW}/chromium-1169/chrome-linux/chrome`, `${PW}/chromium-1300/chrome-linux64/README`]));
    expect(r).toMatchObject({ ok: true, executable: { revision: 1169 } });
  });

  test('macOS: Playwright caches in ~/Library/Caches and app-bundle binaries', () => {
    const mac = '/home/me/Library/Caches/ms-playwright';
    expect(discoverChromium(ctx('darwin', [
      `${mac}/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    ]))).toMatchObject({ ok: true, executable: { kind: 'chromium', revision: 1254 } });
    expect(discoverChromium(ctx('darwin', [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]))).toMatchObject({ ok: true, executable: { kind: 'chrome', source: 'system' } });
    expect(discoverChromium(ctx('darwin', [
      '/home/me/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]))).toMatchObject({ ok: true, executable: { kind: 'chromium', source: 'system' } });
  });

  test('PLAYWRIGHT_BROWSERS_PATH is searched too', () => {
    const r = discoverChromium(ctx('linux', ['/opt/pw/chromium_headless_shell-1300/chrome-headless-shell-linux64/chrome-headless-shell'], { PLAYWRIGHT_BROWSERS_PATH: '/opt/pw' }));
    expect(r).toMatchObject({ ok: true, executable: { revision: 1300 } });
  });

  test('CODIBY_CHROMIUM_PATH wins, and a bad one is reported instead of silently replaced', () => {
    const files = [`${PW}/chromium-1243/chrome-linux64/chrome`, '/opt/chrome/headless_shell'];
    expect(discoverChromium(ctx('linux', files, { CODIBY_CHROMIUM_PATH: '/opt/chrome/headless_shell' }))).toEqual({
      ok: true, executable: { path: '/opt/chrome/headless_shell', kind: 'headless-shell', source: 'env' },
    });
    const bad = discoverChromium(ctx('linux', files, { CODIBY_CHROMIUM_PATH: '/nope/chrome' }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toContain('/nope/chrome');
  });

  test('nothing installed → an actionable error', () => {
    const r = discoverChromium(ctx('linux', []));
    expect(r).toEqual({ ok: false, error: chromiumNotFoundMessage('linux') });
    expect(chromiumNotFoundMessage('linux')).toContain('playwright install');
    expect(chromiumNotFoundMessage('linux')).toContain('CODIBY_CHROMIUM_PATH');
  });
});
