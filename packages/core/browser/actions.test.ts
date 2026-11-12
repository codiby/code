import { describe, expect, test } from 'bun:test';
import { PageSession, buildKeyEvents, checkUrl, dispatchAction, navigate, snapshot, type PageTransport } from './actions';

type Call = { method: string; params: Record<string, unknown> };

/** A page whose CDP replies come from `respond`; every call is recorded. */
function fakePage(respond: (method: string, params: Record<string, unknown>, page: PageSession) => unknown = () => ({})) {
  const calls: Call[] = [];
  let page!: PageSession;
  const transport: PageTransport = {
    async send(method, params = {}) {
      calls.push({ method, params });
      const r = respond(method, params, page);
      if (r instanceof Error) throw r;
      return r as any;
    },
    async info() { return { url: 'https://example.com/', title: 'Example' }; },
  };
  page = new PageSession(transport);
  return { page, calls };
}

describe('buildKeyEvents', () => {
  test('Enter carries \\r so a headless form submits, and gets a keyUp', () => {
    const [down, up] = buildKeyEvents('Enter');
    expect(down).toMatchObject({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    expect(up).toMatchObject({ type: 'keyUp', key: 'Enter' });
  });

  test('modifier chords are shortcuts, not text', () => {
    const [down] = buildKeyEvents('Control+a');
    expect(down).toMatchObject({ type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 2, commands: ['selectAll'] });
    expect(down!.text).toBeUndefined();
    expect(buildKeyEvents('Shift+Tab')[0]).toMatchObject({ key: 'Tab', modifiers: 8 });
  });

  test('characters type themselves; punctuation never borrows a named key code', () => {
    expect(buildKeyEvents('x')[0]).toMatchObject({ type: 'keyDown', key: 'x', text: 'x', windowsVirtualKeyCode: 88 });
    const dot = buildKeyEvents('.')[0]!;
    expect(dot).toMatchObject({ type: 'keyDown', key: '.', text: '.' });
    // 46 would be Delete.
    expect(dot.windowsVirtualKeyCode).toBeUndefined();
    expect(buildKeyEvents('+')[0]).toMatchObject({ key: '+', text: '+' });
    expect(buildKeyEvents('Control++')[0]).toMatchObject({ key: '+', modifiers: 2 });
  });
});

describe('PageSession buffers', () => {
  test('network entries follow a request from start to finish', () => {
    const { page } = fakePage();
    page.handleEvent('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://x/a', method: 'GET' } });
    page.handleEvent('Network.responseReceived', { requestId: 'r1', response: { status: 200, statusText: 'OK', mimeType: 'text/html' } });
    page.handleEvent('Network.loadingFinished', { requestId: 'r1' });
    page.handleEvent('Network.requestWillBeSent', { requestId: 'r2', request: { url: 'https://x/b', method: 'POST' } });
    page.handleEvent('Network.loadingFailed', { requestId: 'r2', errorText: 'net::ERR_FAILED' });
    expect(page.network.map(e => [e.method, e.status ?? null, e.errorText ?? null, !!e.endTs])).toEqual([
      ['GET', 200, null, true],
      ['POST', null, 'net::ERR_FAILED', true],
    ]);
  });

  test('console and exceptions are captured, warnings stay warnings', async () => {
    const { page } = fakePage();
    page.handleEvent('Runtime.consoleAPICalled', { type: 'warning', args: [{ type: 'string', value: 'careful' }, { type: 'number', value: 3 }] });
    page.handleEvent('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x' } } });
    const r = await dispatchAction(page, 'console_messages', { tail: 10 }) as { entries: { level: string; text: string }[] };
    expect(r.entries.map(e => [e.level, e.text])).toEqual([['warn', 'careful 3'], ['exception', 'TypeError: x']]);
  });

  test('dialogs are tracked and handled', async () => {
    const { page, calls } = fakePage();
    expect(await dispatchAction(page, 'handle_dialog', { accept: true })).toEqual({ ok: true, handled: null });
    page.handleEvent('Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' });
    expect(await dispatchAction(page, 'handle_dialog', { accept: false })).toEqual({ ok: true, handled: { type: 'confirm', message: 'Sure?', defaultPrompt: undefined } });
    expect(calls.at(-1)).toEqual({ method: 'Page.handleJavaScriptDialog', params: { accept: false, promptText: undefined } });
  });

  test('a main-frame navigation invalidates snapshot refs', async () => {
    const { page } = fakePage((method) => method === 'Accessibility.getFullAXTree'
      ? { nodes: [{ nodeId: '1', backendDOMNodeId: 10, role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: 'Go' } }] }
      : {});
    const snap = await snapshot(page);
    expect(snap.yaml).toBe('- button "Go" [ref=e1]');
    expect(snap.url).toBe('https://example.com/');
    page.handleEvent('Page.frameNavigated', { frame: { id: 'child', parentId: 'main', url: 'https://ads/' } });
    expect(page.refToBackendNode.size).toBe(1);
    page.handleEvent('Page.frameNavigated', { frame: { id: 'main', url: 'https://example.com/next' } });
    const err = await dispatchAction(page, 'click', { ref: 'e1' }).catch((e: Error) => e) as Error;
    expect(err.message).toContain('call browser_snapshot first');
  });
});

describe('actions', () => {
  test('the snapshot renders roles, names, values and states as playwright YAML', async () => {
    const { page } = fakePage(() => ({
      nodes: [
        { nodeId: '1', backendDOMNodeId: 1, role: { type: 'role', value: 'RootWebArea' }, name: { type: 's', value: 'Login' }, childIds: ['2', '3'] },
        { nodeId: '2', parentId: '1', role: { type: 'role', value: 'none' }, childIds: ['4'] },
        { nodeId: '4', parentId: '2', backendDOMNodeId: 4, role: { type: 'role', value: 'textbox' }, name: { type: 's', value: 'Email' }, value: { type: 's', value: 'a@b.c' }, properties: [{ name: 'required', value: { type: 'boolean', value: true } }] },
        { nodeId: '3', parentId: '1', backendDOMNodeId: 3, role: { type: 'role', value: 'checkbox' }, name: { type: 's', value: 'Say "hi"' }, properties: [{ name: 'checked', value: { type: 'tristate', value: 'true' } }] },
      ],
    }));
    const r = await snapshot(page);
    expect(r.yaml.split('\n')).toEqual([
      '- RootWebArea "Login" [ref=e1]',
      '  - textbox "Email" value="a@b.c" [required] [ref=e2]',
      '  - checkbox "Say \\"hi\\"" [checked="true"] [ref=e3]',
    ]);
  });

  test('a left click calls .click() on the resolved node and releases it', async () => {
    const { page, calls } = fakePage((method) => method === 'DOM.resolveNode' ? { object: { objectId: 'obj-1' } } : { result: {} });
    page.refToBackendNode.set('e5', 55);
    expect(await dispatchAction(page, 'click', { ref: 'e5' })).toEqual({ ok: true });
    expect(calls.map(c => c.method)).toEqual(['DOM.resolveNode', 'Runtime.callFunctionOn', 'Runtime.releaseObject']);
    expect(calls[0]!.params).toEqual({ backendNodeId: 55 });
    expect(String(calls[1]!.params.functionDeclaration)).toContain('this.click()');
  });

  test('page exceptions surface as errors instead of undefined values', async () => {
    const { page } = fakePage(() => ({ exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: nope is not defined\n    at <anonymous>' } } }));
    const err = await dispatchAction(page, 'evaluate', { function: '() => nope' }).catch((e: Error) => e) as Error;
    expect(err.message).toBe('The function threw: ReferenceError: nope is not defined');
  });

  test('goto waits for load and reports network failures', async () => {
    const { page } = fakePage((method, params, p) => {
      if (method !== 'Page.navigate') return {};
      if (String(params.url).includes('down')) return { frameId: 'f', errorText: 'net::ERR_NAME_NOT_RESOLVED' };
      queueMicrotask(() => p.handleEvent('Page.loadEventFired', {}));
      return { frameId: 'f', loaderId: 'l' };
    });
    expect(await navigate(page, 'goto', 'https://up.example/')).toEqual({ ok: true });
    const err = await navigate(page, 'goto', 'https://down.example/').catch(e => e);
    expect(err.message).toBe('Navigation to https://down.example/ failed: net::ERR_NAME_NOT_RESOLVED');
  });

  test('a page that never finishes loading is not an error', async () => {
    const { page } = fakePage((method) => method === 'Page.navigate' ? { frameId: 'f', loaderId: 'l' } : {});
    const started = Date.now();
    expect(await navigate(page, 'goto', 'https://slow.example/', { loadTimeoutMs: 50 })).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('navigation stays on http(s); the requirements runner\'s bare { url } means goto', async () => {
    expect(() => checkUrl('file:///etc/passwd')).toThrow('Only http/https URLs are supported');
    expect(() => checkUrl('javascript:alert(1)')).toThrow();
    const { page, calls } = fakePage((method, _params, p) => {
      if (method === 'Page.navigate') { queueMicrotask(() => p.handleEvent('Page.loadEventFired', {})); return { loaderId: 'l' }; }
      return {};
    });
    await dispatchAction(page, 'navigate', { url: 'https://example.com/x' });
    expect(calls.find(c => c.method === 'Page.navigate')!.params).toEqual({ url: 'https://example.com/x' });
    expect(await dispatchAction(page, 'navigate', { action: 'goto', url: 'file:///etc/hosts' }).catch(e => e.message)).toBe('Only http/https URLs are supported');
  });

  test('back uses the history list', async () => {
    const { page, calls } = fakePage((method, _params, p) => {
      if (method === 'Page.getNavigationHistory') return { currentIndex: 1, entries: [{ id: 7 }, { id: 8 }] };
      if (method === 'Page.navigateToHistoryEntry') queueMicrotask(() => p.handleEvent('Page.frameNavigated', { frame: { id: 'main' } }));
      return {};
    });
    await dispatchAction(page, 'navigate', { action: 'back' });
    expect(calls.find(c => c.method === 'Page.navigateToHistoryEntry')!.params).toEqual({ entryId: 7 });
  });

  test('wait_for polls page text until it appears', async () => {
    let n = 0;
    const { page } = fakePage(() => ({ result: { value: ++n >= 3 } }));
    expect(await dispatchAction(page, 'wait_for', { text: 'Done', timeoutMs: 2000 })).toEqual({ ok: true });
    expect(n).toBe(3);
    const { page: never } = fakePage(() => ({ result: { value: false } }));
    expect(await dispatchAction(never, 'wait_for', { text: 'x', timeoutMs: 150 }).catch(e => e.message)).toBe('wait_for timed out after 150ms');
  });
});
