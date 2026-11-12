import { describe, expect, test } from 'bun:test';
import { PageSession } from '../../browser';
import { matchRoute, listPromptSections } from '../registry';
import { executeAgentTool, listAgentToolsFor } from '../tools';
import { normalizeSiteDomain, siteSecretName } from '../google/secrets';
import { checkLoginOrigin, fillSecret, hostMatchesDomain, loginCandidates, parseSecretDomain, type FillSecretDeps } from './fill-secret';
import { renderBrowserPrompt } from './prompt';
import './index';

const PASSWORD = 'hunter2-Sup3r$ecret';
const USERNAME = 'owner@example.com';

interface FakeField { tag: string; type: string; origin: string; disabled?: boolean; readOnly?: boolean; focusable?: boolean; maxLength?: number }

const WORLD = 7;

/**
 * A page with one field; records whatever was typed into it. Element
 * handles only exist in the isolated world the tool creates, and the fill
 * itself is the in-document `codibyFill` call (the value is its argument).
 */
function fakeLoginPage(opts: { url: string; field: FakeField; navigateBeforeFill?: boolean }) {
  const sent: { method: string; params: any }[] = [];
  let value = '';
  const respond = (method: string, params: any): unknown => {
    switch (method) {
        case 'Page.getFrameTree': return { frameTree: { frame: { id: 'main-frame', url: opts.url } } };
        case 'Page.createIsolatedWorld': return params.frameId === 'main-frame' ? { executionContextId: WORLD } : {};
        case 'DOM.resolveNode': return params.executionContextId === WORLD ? { object: { objectId: 'field-1' } } : { object: { objectId: 'main-world-field' } };
        case 'Runtime.evaluate':
          if (params.contextId !== WORLD) return { result: { objectId: 'main-world-field' } };
          return params.expression.includes('#missing') ? { result: { type: 'object', subtype: 'null' } } : { result: { objectId: 'field-1' } };
        case 'Runtime.callFunctionOn': {
          if (params.objectId !== 'field-1') throw new Error('handle from the page\'s own world');
          const fn = String(params.functionDeclaration);
          if (fn.startsWith('function codibyFieldFacts')) {
            const f = opts.field;
            return { result: { value: { tag: f.tag, type: f.type, origin: f.origin, disabled: !!f.disabled, readOnly: !!f.readOnly, connected: true } } };
          }
          if (fn.startsWith('function codibyFill')) {
            // The document the handle belongs to is gone: CDP refuses the call.
            if (opts.navigateBeforeFill) throw new Error('Cannot find context with specified id');
            const [text, origin] = (params.arguments as { value: string }[]).map(a => a.value);
            if (origin !== opts.field.origin) return { result: { value: 'moved' } };
            if (opts.field.focusable === false) return { result: { value: 'unfocused' } };
            value = String(text).slice(0, opts.field.maxLength ?? Infinity);
            return { result: { value: value.length === String(text).length ? 'ok' : 'short' } };
          }
          return { result: {} };
        }
        case 'Input.insertText': {
          value = String(params.text);
          return {};
        }
        default: return {};
    }
  };
  const page = new PageSession({
    async send(method, params = {}) {
      sent.push({ method, params });
      return respond(method, params) as any;
    },
    async info() { return { url: opts.url, title: 'Sign in' }; },
  });
  page.refToBackendNode.set('e3', 33);
  return { page, sent, typed: () => value };
}

/** Every CDP message that carried `secret`, by method. */
function carriers(sent: { method: string; params: any }[], secret: string): string[] {
  return sent.filter(s => JSON.stringify(s.params).includes(secret)).map(s => `${s.method}:${String(s.params.functionDeclaration ?? '').slice(0, 19)}`);
}

function depsFor(page: PageSession, logins: Record<string, { username?: string; password?: string }> = { 'site:example.com': { username: USERNAME, password: PASSWORD } }): FillSecretDeps {
  return {
    getLogin: (name) => logins[name] ?? null,
    page: async (_s, name) => ({ page, name: name ?? 'login' }),
  };
}

const ctx = { sessionId: 'main-session', sessionName: 'Agent' };
const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

function expectNoLeak(result: unknown) {
  const json = JSON.stringify(result);
  expect(json.includes(PASSWORD)).toBe(false);
  expect(json.includes(USERNAME)).toBe(false);
}

describe('domain rules', () => {
  test('secret names must be site:<full domain>', () => {
    expect(parseSecretDomain('site:Example.COM')).toBe('example.com');
    expect(parseSecretDomain('site:accounts.google.com.')).toBe('accounts.google.com');
    expect(parseSecretDomain('site:localhost')).toBe('localhost');
    for (const bad of ['example.com', 'site:', 'site:com', 'site:exa mple.com', 'site:-x.com', 'site:a..b', 'site:*.example.com']) {
      expect(() => parseSecretDomain(bad)).toThrow();
    }
  });

  test('the host must be the domain or a subdomain, never a look-alike', () => {
    expect(hostMatchesDomain('example.com', 'example.com')).toBe(true);
    expect(hostMatchesDomain('login.EXAMPLE.com.', 'example.com')).toBe(true);
    expect(hostMatchesDomain('example.com.evil.net', 'example.com')).toBe(false);
    expect(hostMatchesDomain('notexample.com', 'example.com')).toBe(false);
    expect(hostMatchesDomain('com', 'example.com')).toBe(false);
  });

  test('https only, except plain http on localhost', () => {
    expect(() => checkLoginOrigin('https://login.example.com/x', 'example.com')).not.toThrow();
    expect(() => checkLoginOrigin('http://example.com/', 'example.com')).toThrow(/https/);
    expect(() => checkLoginOrigin('http://localhost:3000/login', 'localhost')).not.toThrow();
    expect(() => checkLoginOrigin('data:text/html,<input type=password>', 'example.com')).toThrow(/not example\.com/);
    expect(() => checkLoginOrigin('https://examp1e.com/', 'example.com')).toThrow(/examp1e\.com, not example\.com/);
    expect(() => checkLoginOrigin('', 'example.com')).toThrow(/no real address/);
  });
});

describe('fillSecret', () => {
  test('fills the password on the right site, inside the field\'s own document', async () => {
    const f = fakeLoginPage({ url: 'https://www.example.com/login', field: { tag: 'INPUT', type: 'password', origin: 'https://www.example.com' } });
    const r = await fillSecret({ secret: 'site:example.com', field: 'password', ref: 'e3' }, ctx, depsFor(f.page));
    expect(r.isError).toBeUndefined();
    expect(text(r)).toBe('Filled the password for example.com');
    expect(f.typed()).toBe(PASSWORD);
    // The value travels once, as the argument of the in-document fill — never
    // as Input.insertText, which types into whatever holds focus when it lands.
    expect(carriers(f.sent, PASSWORD)).toEqual(['Runtime.callFunctionOn:function codibyFill']);
    expect(f.sent.some(s => s.method === 'Input.insertText')).toBe(false);
    // The handle comes from the tool's isolated world, which page script can't reach.
    expect(f.sent.find(s => s.method === 'DOM.resolveNode')!.params).toEqual({ backendNodeId: 33, executionContextId: WORLD });
    expect(f.sent.at(-1)!.method).toBe('Runtime.releaseObject');
    expectNoLeak(r);
  });

  test('a navigation that lands during the fill gets nothing typed and nothing echoed', async () => {
    const f = fakeLoginPage({ url: 'https://example.com/login', field: { tag: 'INPUT', type: 'password', origin: 'https://example.com' }, navigateBeforeFill: true });
    const r = await fillSecret({ secret: 'site:example.com', field: 'password', ref: 'e3' }, ctx, depsFor(f.page));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('The page changed before the password could be typed');
    expect(f.typed()).toBe('');
    expectNoLeak(r);
  });

  test('a field whose document no longer has the checked origin is not filled', async () => {
    // FILL_FN compares the origin again in the same call that types; here it changed after the facts were read.
    const f = fakeLoginPage({ url: 'https://example.com/', field: { tag: 'INPUT', type: 'password', origin: 'https://example.com' } });
    const send = f.page.send.bind(f.page);
    (f.page as unknown as { send: typeof send }).send = (async (method: string, params?: any) => {
      if (method === 'Runtime.callFunctionOn' && String(params?.functionDeclaration).startsWith('function codibyFill')) {
        return send(method, { ...params, arguments: [params.arguments[0], { value: 'https://evil.net' }] });
      }
      return send(method, params);
    }) as typeof send;
    const r = await fillSecret({ secret: 'site:example.com', field: 'password', ref: 'e3' }, ctx, depsFor(f.page));
    expect(text(r)).toContain('The page changed');
    expect(f.typed()).toBe('');
  });

  test('look-alike hosts, userinfo tricks and ports', () => {
    const ok = (u: string, d = 'example.com') => { checkLoginOrigin(u, d); return true; };
    // A homoglyph is a different (punycode) host.
    expect(() => checkLoginOrigin('https://ex\u0430mple.com/login', 'example.com')).toThrow(/xn--/);
    // Userinfo, fragments and paths never move the host.
    expect(() => checkLoginOrigin('https://example.com@evil.net/login', 'example.com')).toThrow(/evil\.net, not example\.com/);
    expect(() => checkLoginOrigin('https://evil.net/#@example.com', 'example.com')).toThrow(/evil\.net/);
    expect(() => checkLoginOrigin('https://evil.net/example.com', 'example.com')).toThrow(/evil\.net/);
    expect(() => checkLoginOrigin('https://example.com.evil.net:443/', 'example.com')).toThrow(/example\.com\.evil\.net/);
    // The port doesn't widen the match: any port on the right https host, never http.
    expect(ok('https://example.com:8443/login')).toBe(true);
    expect(() => checkLoginOrigin('http://example.com:443/', 'example.com')).toThrow(/https/);
    // Plain http only on localhost itself, not on look-alikes of it.
    expect(() => checkLoginOrigin('http://foo.localhost:3000/', 'localhost')).toThrow(/https/);
    expect(() => checkLoginOrigin('http://localhost.evil.net/', 'localhost')).toThrow(/not localhost/);
    expect(() => checkLoginOrigin('javascript:alert(1)', 'example.com')).toThrow(/refusing/);
    expect(() => checkLoginOrigin('blob:https://example.com/123', 'example.com')).toThrow(/refusing/);
  });

  test('fills the username by selector', async () => {
    const f = fakeLoginPage({ url: 'https://example.com/', field: { tag: 'INPUT', type: 'email', origin: 'https://example.com' } });
    const r = await fillSecret({ secret: 'site:example.com', field: 'username', selector: '#email' }, ctx, depsFor(f.page));
    expect(text(r)).toBe('Filled the username for example.com');
    expect(f.typed()).toBe(USERNAME);
  });

  test('refuses on another site — the phishing case — without typing anything', async () => {
    for (const url of ['https://example.com.evil.net/login', 'https://evil.net/?next=example.com', 'http://example.com/login']) {
      const f = fakeLoginPage({ url, field: { tag: 'INPUT', type: 'password', origin: new URL(url).origin } });
      const r = await fillSecret({ secret: 'site:example.com', field: 'password', ref: 'e3' }, ctx, depsFor(f.page));
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('refusing');
      expect(f.sent.some(s => s.method === 'Input.insertText')).toBe(false);
      expectNoLeak(r);
    }
  });

  test('a password never goes into a field the tool could not resolve in its own world', async () => {
    const f = fakeLoginPage({ url: 'https://example.com/', field: { tag: 'INPUT', type: 'password', origin: 'https://example.com' } });
    f.page.refToBackendNode.clear();
    const err = await fillSecret({ secret: 'site:example.com', field: 'password', ref: 'e3' }, ctx, depsFor(f.page)).catch(e => e as Error);
    expect(String(err)).toContain('unknown ref "e3"');
    expect(carriers(f.sent, PASSWORD)).toEqual([]);
  });

  test('refuses a field inside a frame from another site', async () => {
    const f = fakeLoginPage({ url: 'https://example.com/', field: { tag: 'INPUT', type: 'password', origin: 'https://evil.net' } });
    const r = await fillSecret({ secret: 'site:example.com', field: 'password', ref: 'e3' }, ctx, depsFor(f.page));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("The field's frame is on evil.net");
    expect(f.sent.some(s => s.method === 'Input.insertText')).toBe(false);
  });

  test('a password only goes into a password input', async () => {
    const f = fakeLoginPage({ url: 'https://example.com/', field: { tag: 'INPUT', type: 'text', origin: 'https://example.com' } });
    const r = await fillSecret({ secret: 'site:example.com', field: 'password', ref: 'e3' }, ctx, depsFor(f.page));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('password input');
    const area = fakeLoginPage({ url: 'https://example.com/', field: { tag: 'TEXTAREA', type: 'textarea', origin: 'https://example.com' } });
    expect(text(await fillSecret({ secret: 'site:example.com', field: 'username', ref: 'e3' }, ctx, depsFor(area.page)))).toContain('not an input');
    const hidden = fakeLoginPage({ url: 'https://example.com/', field: { tag: 'INPUT', type: 'hidden', origin: 'https://example.com' } });
    expect(text(await fillSecret({ secret: 'site:example.com', field: 'username', ref: 'e3' }, ctx, depsFor(hidden.page)))).toContain('type="hidden"');
  });

  test('reports a truncated fill without echoing anything', async () => {
    const f = fakeLoginPage({ url: 'https://example.com/', field: { tag: 'INPUT', type: 'password', origin: 'https://example.com', maxLength: 4 } });
    const r = await fillSecret({ secret: 'site:example.com', field: 'password', ref: 'e3' }, ctx, depsFor(f.page));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('did not take the whole password');
    expectNoLeak(r);
  });

  test('a subdomain falls back to the login saved for its parent domain', async () => {
    const f = fakeLoginPage({ url: 'https://login.example.com/signin', field: { tag: 'INPUT', type: 'password', origin: 'https://login.example.com' } });
    const looked: string[] = [];
    const deps = depsFor(f.page);
    const r = await fillSecret({ secret: 'site:login.example.com', field: 'password', ref: 'e3' }, ctx, {
      ...deps,
      getLogin: (name) => { looked.push(name); return deps.getLogin(name); },
    });
    expect(text(r)).toBe('Filled the password for login.example.com (the login saved for example.com)');
    expect(f.typed()).toBe(PASSWORD);
    // Most specific first, never the bare TLD.
    expect(looked).toEqual(['site:login.example.com', 'site:example.com']);
    expectNoLeak(r);
  });

  test('a login saved for the subdomain itself wins over the parent', async () => {
    const f = fakeLoginPage({ url: 'https://login.example.com/', field: { tag: 'INPUT', type: 'password', origin: 'https://login.example.com' } });
    const logins = { 'site:login.example.com': { username: 'sub', password: 'sub-password-123' }, 'site:example.com': { username: USERNAME, password: PASSWORD } };
    const r = await fillSecret({ secret: 'site:login.example.com', field: 'password', ref: 'e3' }, ctx, depsFor(f.page, logins));
    expect(text(r)).toBe('Filled the password for login.example.com');
    expect(f.typed()).toBe('sub-password-123');
  });

  test("a parent's login never reaches a sibling the model didn't name", async () => {
    // Asked for login.example.com, but the page is on another subdomain.
    const f = fakeLoginPage({ url: 'https://evil.example.com/', field: { tag: 'INPUT', type: 'password', origin: 'https://evil.example.com' } });
    const r = await fillSecret({ secret: 'site:login.example.com', field: 'password', ref: 'e3' }, ctx, depsFor(f.page));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('not login.example.com');
    expect(f.sent.some(s => s.method === 'Input.insertText')).toBe(false);
  });

  test('names come from google/secrets.ts: canonical host, IDN in punycode', async () => {
    expect(loginCandidates('a.b.example.co')).toEqual(['a.b.example.co', 'b.example.co', 'example.co']);
    expect(loginCandidates('example.com')).toEqual(['example.com']);
    expect(loginCandidates('localhost')).toEqual(['localhost']);
    expect(loginCandidates('192.168.1.20')).toEqual(['192.168.1.20']);
    expect(parseSecretDomain('site:Bücher.DE')).toBe(normalizeSiteDomain('bücher.de'));
    const f = fakeLoginPage({ url: 'https://xn--bcher-kva.de/login', field: { tag: 'INPUT', type: 'password', origin: 'https://xn--bcher-kva.de' } });
    const r = await fillSecret({ secret: 'site:bücher.de', field: 'password', ref: 'e3' }, ctx, depsFor(f.page, { [siteSecretName('xn--bcher-kva.de')]: { username: 'u', password: 'idn-password-1' } }));
    expect(text(r)).toBe('Filled the password for xn--bcher-kva.de');
    expect(f.typed()).toBe('idn-password-1');
  });

  test('argument and login problems are explained', async () => {
    const f = fakeLoginPage({ url: 'https://example.com/', field: { tag: 'INPUT', type: 'password', origin: 'https://example.com' } });
    const deps = depsFor(f.page);
    expect(text(await fillSecret({ secret: 'site:example.com', field: 'pin', ref: 'e3' }, ctx, deps))).toContain('"username" or "password"');
    expect(text(await fillSecret({ secret: 'site:example.com', field: 'password' }, ctx, deps))).toContain('exactly one of `ref`');
    expect(text(await fillSecret({ secret: 'site:example.com', field: 'password', ref: 'e3', selector: '#p' }, ctx, deps))).toContain('exactly one of `ref`');
    expect(text(await fillSecret({ secret: 'site:other.org', field: 'password', ref: 'e3' }, ctx, deps))).toContain('Agent → Connections');
    expect(text(await fillSecret({ secret: 'site:example.com', field: 'password', ref: 'e3' }, ctx, depsFor(f.page, { 'site:example.com': { username: 'x' } })))).toContain('has no password');
    const missing = fakeLoginPage({ url: 'https://example.com/', field: { tag: 'INPUT', type: 'text', origin: 'https://example.com' } });
    const err = await fillSecret({ secret: 'site:example.com', field: 'username', selector: '#missing' }, ctx, depsFor(missing.page)).catch(e => e);
    expect(err.message).toContain('No element matches "#missing"');
    expect(missing.sent.some(s => s.method === 'Input.insertText')).toBe(false);
  });
});

describe('registration', () => {
  test('browser_fill_secret is an agent-only tool', async () => {
    expect(listAgentToolsFor('some-coding-session').some(t => t.name === 'browser_fill_secret')).toBe(false);
    const r = await executeAgentTool('browser_fill_secret', { secret: 'site:example.com', field: 'password', ref: 'e1' }, { sessionId: 'some-coding-session', sessionName: 'x' });
    expect(r.isError).toBe(true);
    expect(text(r as { content: unknown[] })).toContain('only available to the Codiby agent session');
  });

  test('routes and the prompt section are registered', () => {
    expect(matchRoute('GET', '/agent/browser/status')).toMatchObject({ route: { method: 'GET' } });
    expect(matchRoute('GET', '/agent/browser/screenshot')).toMatchObject({ route: { method: 'GET' } });
    expect(matchRoute('POST', '/agent/browser/stop')).toMatchObject({ route: { method: 'POST' } });
    const section = listPromptSections().find(s => s.id === 'browser');
    expect(section?.order).toBe(70);
    // Only Claude sessions carry the browser_* tools.
    expect(section!.render({ provider: 'claude' } as never)).toContain('## Your browser');
    expect(section!.render({ provider: 'codex' } as never)).toBeNull();
  });

  test('the prompt explains the browser and lists saved logins by domain only', () => {
    const p = renderBrowserPrompt(['github.com', 'example.com']);
    expect(p.startsWith('## Your browser')).toBe(true);
    expect(p).toContain('browser_fill_secret');
    expect(p).toContain('Saved logins: github.com, example.com.');
    expect(p).toContain('Never type a password');
    expect(renderBrowserPrompt([])).toContain('No site logins are saved yet');
  });
});
