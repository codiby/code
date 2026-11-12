import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fakeDevtools } from './fake-devtools';
import { BrowserUnavailableError, HeadlessBrowser, NoHeadlessTabError } from './manager';

const AGENT = 'main-session';

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) { try { await fn(); } catch {} }
  cleanups = [];
});

function setup(opts: { idleMs?: number; idleCheckMs?: number; discoverFails?: boolean } = {}) {
  const dev = fakeDevtools();
  const dir = mkdtempSync(join(tmpdir(), 'codiby-browser-'));
  const browser = new HeadlessBrowser({
    profileDir: join(dir, 'profile'),
    isAgentSession: (id) => id === AGENT,
    discover: () => opts.discoverFails
      ? { ok: false, error: 'No Chromium found on this host.' }
      : { ok: true, executable: { path: '/fake/chrome-headless-shell', kind: 'headless-shell', source: 'playwright', revision: 1 } },
    launch: (o) => dev.launch(o),
    idleMs: opts.idleMs,
    idleCheckMs: opts.idleCheckMs,
  });
  cleanups.push(async () => { await browser.stop('test over'); dev.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { dev, browser };
}

const createTargets = (dev: ReturnType<typeof fakeDevtools>) => dev.received.filter(m => m.method === 'Target.createTarget');

describe('HeadlessBrowser', () => {
  test('starts lazily, and only once for concurrent first requests', async () => {
    const { dev, browser } = setup();
    expect(browser.isRunning).toBe(false);
    expect(dev.launches).toHaveLength(0);
    await Promise.all([
      browser.openTab(AGENT, 'mail', { url: 'https://mail.example.com/' }),
      browser.openTab('s1', 'docs', { url: 'https://docs.example.com/' }),
    ]);
    expect(dev.launches).toHaveLength(1);
    expect(browser.isRunning).toBe(true);
    const status = await browser.status();
    expect(status.running).toBe(true);
    expect(status.executable).toBe('/fake/chrome-headless-shell');
    // The agent's tab sorts first.
    expect(status.tabs.map(t => [t.sessionId, t.name, t.url, t.live])).toEqual([
      [AGENT, 'mail', 'https://mail.example.com/', true],
      ['s1', 'docs', 'https://docs.example.com/', true],
    ]);
    expect(status.tabs[0]!.title).toBe('Title of https://mail.example.com/');
  });

  test('the agent browses in the persistent default context; other sessions get isolated jars', async () => {
    const { dev, browser } = setup();
    await browser.openTab(AGENT, 'a', { url: 'https://a.example/' });
    await browser.openTab('s1', 'b', { url: 'https://b.example/' });
    await browser.openTab('s2', 'c', { url: 'https://c.example/' });
    await browser.openTab('s2', 'd', { url: 'https://d.example/', cookieJar: 'qa' });
    await browser.openTab(AGENT, 'e', { url: 'https://e.example/', cookieJar: 'qa' });
    const contexts = createTargets(dev).map(m => m.params.browserContextId ?? null);
    expect(contexts[0]).toBeNull();
    // s1 and s2 share the non-agent "default" jar…
    expect(contexts[1]).not.toBeNull();
    expect(contexts[2]).toBe(contexts[1]);
    // …while named jars, and the agent's named jars, are separate again.
    expect(new Set([contexts[1], contexts[3], contexts[4]]).size).toBe(3);
    expect(createTargets(dev).every(m => m.params.newWindow === true)).toBe(true);
  });

  test('re-opening a name navigates the same tab; a new jar replaces it', async () => {
    const { dev, browser } = setup();
    await browser.openTab('s1', 'x', { url: 'https://one.example/' });
    await browser.openTab('s1', 'x', { url: 'https://two.example/' });
    expect(createTargets(dev)).toHaveLength(1);
    expect(browser.listTabs('s1')[0]!.url).toBe('https://two.example/');
    await browser.openTab('s1', 'x', { url: 'https://two.example/', cookieJar: 'other' });
    expect(createTargets(dev)).toHaveLength(2);
    expect(dev.methods()).toContain('Target.closeTarget');
  });

  test('actions run on the tab, and unknown tabs need a fallback', async () => {
    const { browser } = setup();
    expect(await browser.run('s1', 'nope', 'evaluate', { function: '() => 1' }, { timeoutMs: 1000 }).catch(e => e)).toBeInstanceOf(NoHeadlessTabError);
    const r = await browser.run('s1', 'late', 'evaluate', { function: '() => 1' }, { timeoutMs: 1000, fallback: { url: 'https://late.example/' } });
    expect(r).toEqual({ value: 'evaluated on https://late.example/' });
  });

  test('idles out, then revives dormant tabs at their last URL', async () => {
    const { dev, browser } = setup({ idleMs: 60, idleCheckMs: 20 });
    await browser.openTab(AGENT, 'site', { url: 'https://first.example/' });
    await browser.openTab(AGENT, 'site', { url: 'https://second.example/' });
    await Bun.sleep(200);
    expect(browser.isRunning).toBe(false);
    expect(dev.methods()).toContain('Browser.close');
    const dormant = await browser.status();
    expect(dormant.running).toBe(false);
    expect(dormant.tabs).toEqual([expect.objectContaining({ name: 'site', live: false, url: 'https://second.example/' })]);
    expect(await browser.liveScreenshot(AGENT, 'site')).toBeNull();

    const before = dev.received.length;
    const r = await browser.run(AGENT, 'site', 'evaluate', { function: '() => location.href' }, { timeoutMs: 1000 });
    expect(dev.launches).toHaveLength(2);
    expect(r).toEqual({ value: 'evaluated on https://second.example/' });
    const navs = dev.received.slice(before).filter(m => m.method === 'Page.navigate').map(m => m.params.url);
    expect(navs).toEqual(['https://second.example/']);
  });

  test('a crash is survived: the next request relaunches and reopens the tab', async () => {
    const { dev, browser } = setup();
    await browser.openTab('s1', 'x', { url: 'https://x.example/' });
    dev.crash();
    await Bun.sleep(30);
    expect(browser.isRunning).toBe(false);
    expect((await browser.status()).error).toMatch(/Chromium (exited|lost)/);
    await browser.run('s1', 'x', 'evaluate', { function: '() => 1' }, { timeoutMs: 1000 });
    expect(dev.launches).toHaveLength(2);
    expect(browser.isRunning).toBe(true);
  });

  test('refuses to restart a browser that keeps crashing', async () => {
    const { dev, browser } = setup();
    for (let i = 0; i < 3; i++) {
      await browser.openTab('s1', 'x', { url: 'https://x.example/' });
      dev.crash();
      await Bun.sleep(20);
    }
    const err = await browser.openTab('s1', 'x', { url: 'https://x.example/' }).catch(e => e);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect(err.message).toContain('crashed 3 times');
  });

  test('live screenshots are cached for a second and never start the browser', async () => {
    const { dev, browser } = setup();
    expect(await browser.liveScreenshot(AGENT, 'x')).toBeNull();
    expect(dev.launches).toHaveLength(0);
    await browser.openTab(AGENT, 'x', { url: 'https://x.example/' });
    const [a, b] = await Promise.all([browser.liveScreenshot(AGENT, 'x'), browser.liveScreenshot(AGENT, 'x')]);
    const c = await browser.liveScreenshot(AGENT, 'x');
    expect(a!.toString()).toBe(b!.toString());
    expect(c!.toString()).toBe(a!.toString());
    const shots = dev.received.filter(m => m.method === 'Page.captureScreenshot');
    expect(shots).toHaveLength(1);
    expect(shots[0]!.params).toMatchObject({ format: 'jpeg', quality: 60 });
  });

  test('tabs whose preview was closed elsewhere are dropped', async () => {
    const { dev, browser } = setup();
    const open = new Set(['keep']);
    browser.setPreviewLookup((_s, name) => open.has(name));
    open.add('gone');
    await browser.openTab('s1', 'keep', { url: 'https://k.example/' });
    await browser.openTab('s1', 'gone', { url: 'https://g.example/' });
    open.delete('gone');
    const status = await browser.status();
    expect(status.tabs.map(t => t.name)).toEqual(['keep']);
    expect(dev.received.filter(m => m.method === 'Target.closeTarget')).toHaveLength(1);
  });

  test('no Chromium → a clear error, and status says so without launching', async () => {
    const { dev, browser } = setup({ discoverFails: true });
    const err = await browser.openTab('s1', 'x', { url: 'https://x.example/' }).catch(e => e);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect(err.message).toBe('No Chromium found on this host.');
    const status = await browser.status();
    expect(status).toMatchObject({ running: false, available: false, executable: null, error: 'No Chromium found on this host.', tabs: [] });
    expect(dev.launches).toHaveLength(0);
  });

  test('only http(s) and inline pages can be opened', async () => {
    const { browser } = setup();
    expect(await browser.openTab('s1', 'x', { url: 'file:///etc/passwd' }).catch(e => e.message)).toBe('Only http/https URLs are supported');
    expect(await browser.openTab('s1', 'x', { url: 'chrome://settings' }).catch(e => e.message)).toBe('Only http/https URLs are supported');
  });

  test('stop closes Chromium gracefully and keeps tabs for later', async () => {
    const { dev, browser } = setup();
    await browser.openTab(AGENT, 'x', { url: 'https://x.example/' });
    expect(await browser.stop('test')).toBe(true);
    expect(dev.methods()).toContain('Browser.close');
    expect(dev.killed).toEqual([]);
    expect(browser.listTabs()).toEqual([expect.objectContaining({ name: 'x', live: false })]);
    expect(await browser.stop('again')).toBe(false);
    expect(await browser.closeTab(AGENT, 'x')).toBe(true);
    expect(browser.listTabs()).toEqual([]);
  });
});
