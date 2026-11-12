import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MAIN_SESSION_ID } from '../config/config';
import { HeadlessBrowser, _setHeadlessBrowserForTest } from '../browser';
import { fakeDevtools } from '../browser/fake-devtools';
import {
  _setPreviewLookupForTest,
  browserBackendFor,
  cdpRequest,
  chooseBrowserBackend,
  handleBrowserResponse,
  headlessPage,
  setDesktopBrowserProbe,
  untrustedPageNote,
} from './browser-cdp';

describe('chooseBrowserBackend', () => {
  test('the agent always browses headless, on its own computer', () => {
    expect(chooseBrowserBackend({ isAgentSession: true, desktopSubscribed: true, hasHeadlessTab: false })).toBe('headless');
    expect(chooseBrowserBackend({ isAgentSession: true, desktopSubscribed: false, hasHeadlessTab: false })).toBe('headless');
  });

  test('other sessions use the desktop preview when a desktop app serves them, else headless', () => {
    expect(chooseBrowserBackend({ isAgentSession: false, desktopSubscribed: true, hasHeadlessTab: false })).toBe('electron');
    expect(chooseBrowserBackend({ isAgentSession: false, desktopSubscribed: false, hasHeadlessTab: false })).toBe('headless');
  });

  test('a tab already living headless stays there when a desktop app connects', () => {
    expect(chooseBrowserBackend({ isAgentSession: false, desktopSubscribed: true, hasHeadlessTab: true })).toBe('headless');
  });
});

describe('cdpRequest routing', () => {
  const dev = fakeDevtools();
  const dir = mkdtempSync(join(tmpdir(), 'codiby-route-'));
  const browser = new HeadlessBrowser({
    profileDir: join(dir, 'profile'),
    isAgentSession: (id) => id === MAIN_SESSION_ID,
    discover: () => ({ ok: true, executable: { path: '/fake/chrome', kind: 'chromium', source: 'playwright' } }),
    launch: (o) => dev.launch(o),
  });
  const previews = new Map<string, { url: string; cookieJar?: string }>();
  const desktop = new Set<string>();

  beforeAll(() => {
    _setHeadlessBrowserForTest(browser);
    _setPreviewLookupForTest((s, n) => previews.get(`${s}/${n}`) ?? null);
    setDesktopBrowserProbe((s) => desktop.has(s));
  });

  afterAll(async () => {
    setDesktopBrowserProbe(() => false);
    _setPreviewLookupForTest(null);
    _setHeadlessBrowserForTest(null);
    await browser.stop('test over');
    dev.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test('browserBackendFor reads the desktop probe and existing headless tabs', async () => {
    desktop.add('coding-1');
    expect(browserBackendFor('coding-1', 'docs')).toBe('electron');
    expect(browserBackendFor('coding-2', 'docs')).toBe('headless');
    expect(browserBackendFor(MAIN_SESSION_ID, 'docs')).toBe('headless');
    previews.set('coding-1/docs', { url: 'https://docs.example/' });
    await browser.openTab('coding-1', 'docs', { url: 'https://docs.example/' });
    expect(browserBackendFor('coding-1', 'docs')).toBe('headless');
    expect(browserBackendFor('coding-1', 'other')).toBe('electron');
  });

  test('electron-backed requests go to the desktop and resolve from its response', async () => {
    desktop.add('coding-3');
    const sent: any[] = [];
    const p = cdpRequest('coding-3', 'app', 'evaluate', { function: '() => 1' }, (_sid, msg) => sent.push(msg));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'browser_request', sessionId: 'coding-3', name: 'app', action: 'evaluate' });
    handleBrowserResponse({ requestId: sent[0].requestId, result: { value: 1 } });
    expect(await p).toEqual({ value: 1 });
  });

  test('headless-backed requests never touch the desktop, and open the preview lazily', async () => {
    previews.set(`${MAIN_SESSION_ID}/mail`, { url: 'https://mail.example/' });
    const sent: unknown[] = [];
    const r = await cdpRequest(MAIN_SESSION_ID, 'mail', 'evaluate', { function: '() => 1' }, (_s, m) => sent.push(m));
    expect(sent).toEqual([]);
    expect(r).toEqual({ value: 'evaluated on https://mail.example/' });
    expect(browser.hasTab(MAIN_SESSION_ID, 'mail')).toBe(true);
  });

  test('a headless request for a preview that was never opened says so', async () => {
    const err = await cdpRequest(MAIN_SESSION_ID, 'ghost', 'snapshot', {}, () => {}).catch((e: Error) => e) as Error;
    expect(err.message).toContain('Call browser_open with name="ghost" first');
  });

  test('headlessPage picks the only tab, and asks when there are several', async () => {
    previews.set('solo/one', { url: 'https://one.example/' });
    await browser.openTab('solo', 'one', { url: 'https://one.example/' });
    expect((await headlessPage('solo')).name).toBe('one');
    previews.set('solo/two', { url: 'https://two.example/' });
    await browser.openTab('solo', 'two', { url: 'https://two.example/' });
    expect(await headlessPage('solo').catch(e => e.message)).toContain('Several browser tabs are open');
    expect(await headlessPage('nobody').catch(e => e.message)).toContain('No browser tab is open');
  });

  test('page output is labelled untrusted for the agent only', () => {
    expect(untrustedPageNote(MAIN_SESSION_ID)).toContain('Untrusted');
    expect(untrustedPageNote('coding-1')).toBe('');
  });
});
