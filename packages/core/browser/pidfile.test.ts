import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { reapStaleChromium, writePidFile } from './pidfile';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'codiby-pid-'));
  return { dir, file: join(dir, 'chromium.pid'), profile: join(dir, 'profile'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('reapStaleChromium', () => {
  test('kills a leftover Chromium that still runs on our profile', async () => {
    const t = setup();
    writePidFile(t.file, { pid: 4242, userDataDir: t.profile, startedAt: 1 });
    let alive = true;
    const signals: string[] = [];
    const pid = await reapStaleChromium(t.file, t.profile, {
      isAlive: () => alive,
      commandLine: () => `/x/chrome --headless --user-data-dir=${t.profile} about:blank`,
      kill: (_pid, sig) => { signals.push(sig); alive = false; },
      sleep: async () => {},
    });
    expect(pid).toBe(4242);
    expect(signals).toEqual(['SIGTERM']);
    expect(existsSync(t.file)).toBe(false);
    t.done();
  });

  test('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const t = setup();
    writePidFile(t.file, { pid: 4243, userDataDir: t.profile, startedAt: 1 });
    let alive = true;
    const signals: string[] = [];
    await reapStaleChromium(t.file, t.profile, {
      isAlive: () => alive,
      commandLine: () => `chrome --user-data-dir=${t.profile}`,
      kill: (_pid, sig) => { signals.push(sig); if (sig === 'SIGKILL') alive = false; },
      sleep: async () => {},
    });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    t.done();
  });

  test('leaves a recycled pid alone', async () => {
    const t = setup();
    writePidFile(t.file, { pid: 4244, userDataDir: t.profile, startedAt: 1 });
    const signals: string[] = [];
    const pid = await reapStaleChromium(t.file, t.profile, {
      isAlive: () => true,
      commandLine: () => '/usr/bin/postgres -D /var/lib/pg',
      kill: (_pid, sig) => { signals.push(sig); },
      sleep: async () => {},
    });
    expect(pid).toBeNull();
    expect(signals).toEqual([]);
    t.done();
  });

  test('no file, a dead pid or a record for another profile → nothing to do', async () => {
    const t = setup();
    expect(await reapStaleChromium(t.file, t.profile)).toBeNull();
    writePidFile(t.file, { pid: 4245, userDataDir: '/elsewhere', startedAt: 1 });
    expect(await reapStaleChromium(t.file, t.profile, { isAlive: () => true, commandLine: () => '--user-data-dir=/elsewhere' })).toBeNull();
    writePidFile(t.file, { pid: 4246, userDataDir: t.profile, startedAt: 1 });
    expect(await reapStaleChromium(t.file, t.profile, { isAlive: () => false })).toBeNull();
    t.done();
  });
});
