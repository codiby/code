/**
 * Drives a real Chromium end to end. Skipped when this host has none
 * (see discovery.ts for where it looks).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fillSecret } from '../agent/browser/fill-secret';
import { discoverChromium } from './discovery';
import { HeadlessBrowser } from './manager';

const found = discoverChromium();
const AGENT = 'main-session';

const BUTTON_PAGE = 'data:text/html,' + encodeURIComponent(`<!doctype html>
<title>Fixture</title>
<h1 id="out">idle</h1>
<button onclick="document.getElementById('out').textContent = 'clicked ' + (++window.n || (window.n = 1))">Press me</button>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'submitted:' + this.q.value">
  <input name="q" aria-label="Query">
</form>`);

const LOGIN_PAGE = `<!doctype html><title>Sign in</title>
<form><input id="user" type="email" aria-label="Email"><input id="pass" type="password" aria-label="Password"></form>`;

describe.skipIf(!found.ok)('headless Chromium (real)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codiby-chromium-'));
  const browser = new HeadlessBrowser({ profileDir: join(dir, 'profile'), isAgentSession: (id) => id === AGENT });
  const site = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(LOGIN_PAGE, { headers: { 'Content-Type': 'text/html' } }) });

  afterAll(async () => {
    await browser.stop('test over');
    site.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (sessionId: string, name: string, action: Parameters<HeadlessBrowser['run']>[2], args: Record<string, unknown> = {}) =>
    browser.run(sessionId, name, action, args, { timeoutMs: 15_000 });

  test('snapshot, click by ref, read back via evaluate', async () => {
    const opened = await browser.openTab('coding-1', 'fixture', { url: BUTTON_PAGE });
    expect(opened.navigationError).toBeUndefined();
    const snap = await run('coding-1', 'fixture', 'snapshot') as { url: string; title: string; yaml: string };
    expect(snap.title).toBe('Fixture');
    const ref = /- button "Press me" \[ref=(e\d+)\]/.exec(snap.yaml)?.[1];
    expect(ref).toBeTruthy();

    expect(await run('coding-1', 'fixture', 'click', { ref })).toEqual({ ok: true });
    expect(await run('coding-1', 'fixture', 'evaluate', { function: "() => document.getElementById('out').textContent" })).toEqual({ value: 'clicked 1' });

    // Synthetic mouse events at the element's centre work too.
    await run('coding-1', 'fixture', 'click', { ref, doubleClick: true });
    const after = await run('coding-1', 'fixture', 'evaluate', { function: "() => document.getElementById('out').textContent" }) as { value: string };
    expect(after.value).toMatch(/^clicked [23]$/);
  }, 60_000);

  test('typing with submit presses a real Enter that submits the form', async () => {
    const snap = await run('coding-1', 'fixture', 'snapshot') as { yaml: string };
    const ref = /- textbox "Query" \[ref=(e\d+)\]/.exec(snap.yaml)?.[1];
    expect(ref).toBeTruthy();
    await run('coding-1', 'fixture', 'type', { ref, text: 'cats', submit: true });
    await run('coding-1', 'fixture', 'wait_for', { text: 'submitted:cats', timeoutMs: 5_000 });
  }, 30_000);

  test('live view returns a JPEG of the tab', async () => {
    const shot = await browser.liveScreenshot('coding-1', 'fixture');
    expect(shot).not.toBeNull();
    expect(shot![0]).toBe(0xff);
    expect(shot![1]).toBe(0xd8);
    const status = await browser.status();
    expect(status.running).toBe(true);
    expect(status.tabs.find(t => t.name === 'fixture')).toMatchObject({ live: true, title: 'Fixture' });
  }, 30_000);

  test('browser_fill_secret types a saved login only on its own site', async () => {
    const url = `http://localhost:${site.port}/login`;
    await browser.openTab(AGENT, 'login', { url });
    const snap = await run(AGENT, 'login', 'snapshot') as { yaml: string };
    const passRef = /- textbox "Password" \[ref=(e\d+)\]/.exec(snap.yaml)?.[1];
    expect(passRef).toBeTruthy();
    const deps = {
      getLogin: (name: string) => name === 'site:localhost' ? { username: 'owner@example.com', password: 'correct horse battery' } : null,
      page: async (sessionId: string, name?: string) => ({ page: await browser.page(sessionId, name ?? 'login'), name: name ?? 'login' }),
    };
    const ctx = { sessionId: AGENT, sessionName: 'Agent' };

    const r = await fillSecret({ secret: 'site:localhost', field: 'password', ref: passRef, name: 'login' }, ctx, deps);
    expect((r.content[0] as { text: string }).text).toBe('Filled the password for localhost');
    expect(JSON.stringify(r)).not.toContain('correct horse');
    const u = await fillSecret({ secret: 'site:localhost', field: 'username', selector: '#user', name: 'login' }, ctx, deps);
    expect(u.isError).toBeUndefined();
    const values = await run(AGENT, 'login', 'evaluate', { function: "() => [document.getElementById('user').value, document.getElementById('pass').value]" });
    expect(values).toEqual({ value: ['owner@example.com', 'correct horse battery'] });

    // The same login on a page that is not localhost is refused.
    await browser.openTab(AGENT, 'elsewhere', { url: 'data:text/html,' + encodeURIComponent('<input type=password aria-label=Password>') });
    const other = await fillSecret({ secret: 'site:localhost', field: 'password', selector: 'input', name: 'elsewhere' }, ctx, deps);
    expect(other.isError).toBe(true);
    const leaked = await run(AGENT, 'elsewhere', 'evaluate', { function: "() => document.querySelector('input').value" });
    expect(leaked).toEqual({ value: '' });
  }, 60_000);

  test('a stopped browser reopens its tabs where they were', async () => {
    await browser.stop('test');
    expect(browser.isRunning).toBe(false);
    const r = await run('coding-1', 'fixture', 'evaluate', { function: '() => document.title' });
    expect(r).toEqual({ value: 'Fixture' });
  }, 60_000);
});
