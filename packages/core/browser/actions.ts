/**
 * Browser actions over raw CDP — the server-side twin of packages/desktop/cdp.ts.
 *
 * Electron reaches each preview through `webContents.debugger`; the headless
 * browser reaches each tab through a flatten-mode CDP session. Both expose the
 * same playwright-cli–style surface and return the same result shapes, so the
 * `browser_*` tools in provider/sdk-tools.ts do not care which one served them.
 * This is a copy, not a shared module: Electron keeps its own so the desktop
 * bundle never depends on bridge code.
 *
 * A `PageSession` owns everything per tab that outlives a single command: the
 * snapshot's ref table and the console / network / dialog buffers fed by the
 * tab's CDP events (the manager forwards them to `handleEvent`).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NetEntry = {
  requestId: string;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  fromCache?: boolean;
  errorText?: string;
  ts: number;
  endTs?: number;
};

export type ConsoleEntry = {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'exception';
  text: string;
  url?: string;
  line?: number;
  ts: number;
};

export type DialogState = {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultPrompt?: string;
};

type AxValue<T = unknown> = { type: string; value?: T };
type AxProperty = { name: string; value: AxValue };
type AxNode = {
  nodeId: string;
  parentId?: string;
  backendDOMNodeId?: number;
  role?: AxValue<string>;
  name?: AxValue<string>;
  value?: AxValue<string>;
  description?: AxValue<string>;
  properties?: AxProperty[];
  childIds?: string[];
  ignored?: boolean;
};

type RemoteObjectResult<T = unknown> = {
  result?: { value?: T; objectId?: string; subtype?: string; description?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

/** Same action names the Electron path accepts (provider/browser-cdp.ts `CdpAction`). */
export type BrowserAction =
  | 'snapshot'
  | 'take_screenshot'
  | 'click'
  | 'hover'
  | 'type'
  | 'press_key'
  | 'select_option'
  | 'scroll'
  | 'navigate'
  | 'evaluate'
  | 'wait_for'
  | 'console_messages'
  | 'network_requests'
  | 'handle_dialog';

export const BROWSER_ACTIONS: readonly BrowserAction[] = [
  'snapshot', 'take_screenshot', 'click', 'hover', 'type', 'press_key', 'select_option',
  'scroll', 'navigate', 'evaluate', 'wait_for', 'console_messages', 'network_requests', 'handle_dialog',
];

/** How a page session reaches its tab. */
export interface PageTransport {
  send<T = any>(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T>;
  /** URL and title of the tab's main frame. */
  info(): Promise<{ url: string; title: string }>;
}

const NET_BUFFER = 200;
const CONSOLE_BUFFER = 200;
const DEFAULT_LOAD_TIMEOUT_MS = 15_000;

type EventWaiter = { method: string; predicate?: (params: any) => boolean; resolve(params: any): void };

export class PageSession {
  readonly refToBackendNode = new Map<string, number>();
  readonly network: NetEntry[] = [];
  readonly netInflight = new Map<string, NetEntry>();
  readonly consoleBuf: ConsoleEntry[] = [];
  pendingDialog: DialogState | null = null;
  private readonly waiters = new Set<EventWaiter>();

  constructor(private readonly transport: PageTransport) {}

  send<T = any>(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T> {
    return this.transport.send<T>(method, params ?? {}, opts);
  }

  info(): Promise<{ url: string; title: string }> {
    return this.transport.info();
  }

  /**
   * Resolve on the next `method` event that passes `predicate`, or reject
   * after `timeoutMs`. Register it before sending the command that causes the
   * event, or a fast page can fire it first.
   */
  waitForEvent<T = any>(method: string, timeoutMs: number, predicate?: (params: T) => boolean): { promise: Promise<T>; cancel(): void } {
    let waiter!: EventWaiter;
    let timer: ReturnType<typeof setTimeout>;
    const promise = new Promise<T>((resolve, reject) => {
      waiter = {
        method,
        predicate: predicate as ((p: any) => boolean) | undefined,
        resolve: (params) => { clearTimeout(timer); this.waiters.delete(waiter); resolve(params); },
      };
      timer = setTimeout(() => { this.waiters.delete(waiter); reject(new Error(`${method} did not fire within ${timeoutMs}ms`)); }, timeoutMs);
      this.waiters.add(waiter);
    });
    // Callers that only want "best effort" never see the rejection as unhandled.
    promise.catch(() => {});
    return { promise, cancel: () => { clearTimeout(timer); this.waiters.delete(waiter); } };
  }

  /** Feed one CDP event of this tab into the buffers. */
  handleEvent(method: string, params: any): void {
    for (const w of [...this.waiters]) {
      if (w.method !== method) continue;
      try {
        if (w.predicate && !w.predicate(params)) continue;
      } catch { continue; }
      w.resolve(params);
    }

    switch (method) {
      case 'Network.requestWillBeSent': {
        const p = params as { requestId: string; request: { url: string; method: string } };
        const entry: NetEntry = { requestId: p.requestId, method: p.request.method, url: p.request.url, ts: Date.now() };
        this.netInflight.set(p.requestId, entry);
        this.network.push(entry);
        if (this.network.length > NET_BUFFER) this.network.splice(0, this.network.length - NET_BUFFER);
        return;
      }
      case 'Network.responseReceived': {
        const p = params as { requestId: string; response: { status: number; statusText: string; mimeType: string; fromDiskCache?: boolean; fromServiceWorker?: boolean } };
        const e = this.netInflight.get(p.requestId);
        if (!e) return;
        e.status = p.response.status;
        e.statusText = p.response.statusText;
        e.mimeType = p.response.mimeType;
        e.fromCache = !!(p.response.fromDiskCache || p.response.fromServiceWorker);
        return;
      }
      case 'Network.loadingFinished': {
        const e = this.netInflight.get((params as { requestId: string }).requestId);
        if (!e) return;
        e.endTs = Date.now();
        this.netInflight.delete(e.requestId);
        return;
      }
      case 'Network.loadingFailed': {
        const p = params as { requestId: string; errorText?: string };
        const e = this.netInflight.get(p.requestId);
        if (!e) return;
        e.endTs = Date.now();
        e.errorText = p.errorText;
        this.netInflight.delete(p.requestId);
        return;
      }
      case 'Runtime.consoleAPICalled': {
        const p = params as {
          type: string;
          args: Array<{ type: string; value?: unknown; description?: string }>;
          stackTrace?: { callFrames: Array<{ url: string; lineNumber: number }> };
        };
        const text = (p.args ?? []).map((a) => (a.value !== undefined ? String(a.value) : a.description ?? a.type)).join(' ');
        const frame = p.stackTrace?.callFrames?.[0];
        const level = (['log', 'info', 'warn', 'error', 'debug'] as const).includes(p.type as 'log')
          ? (p.type as ConsoleEntry['level'])
          // CDP calls console.warn "warning"; keep it a warning, not a log.
          : p.type === 'warning' ? 'warn' : 'log';
        this.pushConsole({ level, text, url: frame?.url, line: frame?.lineNumber, ts: Date.now() });
        return;
      }
      case 'Runtime.exceptionThrown': {
        const p = params as { exceptionDetails: { text: string; exception?: { description?: string }; url?: string; lineNumber?: number } };
        const text = p.exceptionDetails.exception?.description || p.exceptionDetails.text;
        this.pushConsole({ level: 'exception', text, url: p.exceptionDetails.url, line: p.exceptionDetails.lineNumber, ts: Date.now() });
        return;
      }
      case 'Page.javascriptDialogOpening': {
        const p = params as DialogState;
        this.pendingDialog = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt };
        return;
      }
      case 'Page.javascriptDialogClosed':
        this.pendingDialog = null;
        return;
      case 'Page.frameNavigated': {
        // A new document invalidates every backend node id; failing with
        // "call browser_snapshot first" beats a cryptic DOM error.
        const frame = (params as { frame?: { parentId?: string } }).frame;
        if (frame && !frame.parentId) this.refToBackendNode.clear();
        return;
      }
    }
  }

  private pushConsole(entry: ConsoleEntry): void {
    this.consoleBuf.push(entry);
    if (this.consoleBuf.length > CONSOLE_BUFFER) this.consoleBuf.splice(0, this.consoleBuf.length - CONSOLE_BUFFER);
  }
}

/** Domains a tab needs for every action below. */
export async function enablePageDomains(page: PageSession): Promise<void> {
  await Promise.all([
    page.send('Page.enable'),
    page.send('DOM.enable'),
    page.send('Runtime.enable'),
    page.send('Network.enable'),
    page.send('Accessibility.enable'),
  ].map(p => p.catch(() => {})));
  // Headless windows never have OS focus; without this, focus/blur handlers
  // and `document.hasFocus()` behave as if the user tabbed away.
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// snapshot — AX tree → YAML
// ---------------------------------------------------------------------------

/** Properties echoed next to role/name — the ones that identify an element or describe its state. */
const ECHOED_PROPS = new Set(['level', 'checked', 'pressed', 'expanded', 'selected', 'disabled', 'readonly', 'required', 'placeholder']);

function quoteForYaml(s: string | undefined): string {
  if (!s) return '';
  // Match playwright's quoting: double-quotes with backslash-escapes.
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').slice(0, 200)}"`;
}

export async function snapshot(page: PageSession): Promise<{ url: string; title: string; yaml: string }> {
  // Refresh the ref table so refs from an older snapshot fail loudly.
  page.refToBackendNode.clear();

  const { nodes } = await page.send<{ nodes: AxNode[] }>('Accessibility.getFullAXTree');
  const byId = new Map<string, AxNode>();
  for (const n of nodes) byId.set(n.nodeId, n);
  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));

  let counter = 0;
  const lines: string[] = [];

  function describeProps(node: AxNode): string {
    if (!node.properties) return '';
    const parts: string[] = [];
    for (const p of node.properties) {
      if (!ECHOED_PROPS.has(p.name)) continue;
      const v = p.value?.value;
      if (v === undefined || v === false) continue;
      if (v === true) parts.push(p.name);
      else parts.push(`${p.name}=${typeof v === 'string' ? quoteForYaml(v) : String(v)}`);
    }
    return parts.length ? ' [' + parts.join('] [') + ']' : '';
  }

  function walk(node: AxNode, depth: number) {
    const role = node.role?.value || 'unknown';
    const ignored = !!node.ignored || role === 'none' || role === 'presentation' || role === 'InlineTextBox';
    const name = node.name?.value || '';
    const value = node.value?.value;

    let printedSelf = false;
    if (!ignored && node.backendDOMNodeId) {
      counter++;
      const ref = `e${counter}`;
      page.refToBackendNode.set(ref, node.backendDOMNodeId);
      const headParts = [`- ${role}`];
      if (name) headParts.push(quoteForYaml(name));
      if (value) headParts.push(`value=${quoteForYaml(String(value))}`);
      lines.push(`${'  '.repeat(depth)}${headParts.join(' ')}${describeProps(node)} [ref=${ref}]`);
      printedSelf = true;
    }

    const nextDepth = printedSelf ? depth + 1 : depth;
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) walk(child, nextDepth);
    }
  }

  for (const root of roots) walk(root, 0);

  const { url, title } = await page.info();
  return { url, title, yaml: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// screenshot
// ---------------------------------------------------------------------------

export async function screenshot(page: PageSession): Promise<{ format: 'png'; data: string }> {
  const r = await page.send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  return { format: 'png', data: r.data };
}

/** Compressed frame for the live view — smaller and cheaper than the PNG the tools save. */
export async function screenshotJpeg(page: PageSession, quality = 60, timeoutMs = 8_000): Promise<Buffer> {
  const r = await page.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality, captureBeyondViewport: false }, { timeoutMs });
  return Buffer.from(r.data, 'base64');
}

// ---------------------------------------------------------------------------
// helpers for action tools
// ---------------------------------------------------------------------------

export async function resolveRef(page: PageSession, ref: string): Promise<string> {
  const backendNodeId = page.refToBackendNode.get(ref);
  if (!backendNodeId) throw new Error(`unknown ref "${ref}" — call browser_snapshot first to refresh refs`);
  const r = await page.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId });
  if (!r.object?.objectId) throw new Error(`ref "${ref}" no longer exists on the page — call browser_snapshot again`);
  return r.object.objectId;
}

/** Run `fn` with a remote handle on the element behind `ref`, releasing it afterwards. */
export async function withObjectId<T>(page: PageSession, ref: string, fn: (objectId: string) => Promise<T>): Promise<T> {
  const objectId = await resolveRef(page, ref);
  try { return await fn(objectId); }
  finally { await page.send('Runtime.releaseObject', { objectId }).catch(() => {}); }
}

/** Throw the page's own error instead of returning `undefined` for a failed call. */
function checkException(r: RemoteObjectResult, what: string): void {
  if (!r.exceptionDetails) return;
  const detail = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'unknown error';
  throw new Error(`${what} threw: ${detail.split('\n')[0]}`);
}

async function callOn<T = unknown>(page: PageSession, objectId: string, functionDeclaration: string, args: unknown[] = [], opts: { returnByValue?: boolean; awaitPromise?: boolean } = {}): Promise<T> {
  const r = await page.send<RemoteObjectResult<T>>('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration,
    arguments: args.map(value => ({ value })),
    returnByValue: opts.returnByValue ?? true,
    awaitPromise: opts.awaitPromise ?? false,
  });
  checkException(r, 'The page');
  return r.result?.value as T;
}

async function getElementCenter(page: PageSession, objectId: string): Promise<{ x: number; y: number }> {
  // Scroll into view first so the rect is meaningful.
  await callOn(page, objectId, `function() { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }`);
  const r = await callOn<{ x: number; y: number; w: number; h: number }>(
    page,
    objectId,
    `function() { var r = this.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }`,
  );
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

// ---------------------------------------------------------------------------
// click / hover
// ---------------------------------------------------------------------------

export async function click(page: PageSession, ref: string, opts: { button?: 'left' | 'right' | 'middle'; doubleClick?: boolean } = {}): Promise<{ ok: true }> {
  await withObjectId(page, ref, async (objectId) => {
    if (!opts.doubleClick && (opts.button ?? 'left') === 'left') {
      // Programmatic .click() for plain left-clicks: survives overlays and
      // elements that aren't hit-testable via dispatched mouse events.
      await callOn(page, objectId, `function() {
        this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        if (typeof this.focus === 'function') { try { this.focus({ preventScroll: true }); } catch (e) {} }
        if (typeof this.click === 'function') { this.click(); return; }
        this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }`);
      return;
    }
    const { x, y } = await getElementCenter(page, objectId);
    const button = opts.button ?? 'left';
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
    if (opts.doubleClick) {
      // Chromium only reports a dblclick for a second press/release pair with clickCount 2.
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 2 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 2 });
    }
  });
  return { ok: true };
}

export async function hover(page: PageSession, ref: string): Promise<{ ok: true }> {
  await withObjectId(page, ref, async (objectId) => {
    const { x, y } = await getElementCenter(page, objectId);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// type / press_key / select_option
// ---------------------------------------------------------------------------

/**
 * Replace the value of an input/textarea (or the text of a contenteditable)
 * and fire input + change, through the prototype setter so React/Vue
 * controlled inputs notice. `submit` presses Enter afterwards.
 */
export async function typeText(page: PageSession, ref: string, text: string, opts: { submit?: boolean } = {}): Promise<{ ok: true }> {
  await withObjectId(page, ref, async (objectId) => {
    await callOn(page, objectId, `function(v) {
      this.focus();
      if (this.isContentEditable) {
        var range = document.createRange();
        range.selectNodeContents(this);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        if (!document.execCommand('insertText', false, v)) this.textContent = v;
        return;
      }
      var proto = Object.getPrototypeOf(this);
      var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && typeof desc.set === 'function') desc.set.call(this, v);
      else this.value = v;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
    }`, [text]);
  });
  if (opts.submit) await pressKey(page, 'Enter');
  return { ok: true };
}

type KeyDef = { key: string; code: string; keyCode: number; text?: string };

const NAMED_KEYS: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

// CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
const MODIFIERS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

/**
 * Turn a playwright-style key ("Enter", "Control+a", "x") into the
 * keyDown/keyUp pair Chromium needs. Unlike Electron's port this sends real
 * key codes and a keyUp: a headless page only submits a form on Enter when
 * the keyDown carries `\r` as its text.
 */
export function buildKeyEvents(key: string): Record<string, unknown>[] {
  // A trailing "+" is the plus key itself ("+", "Control++").
  const plusKey = key === '+' || key.endsWith('++');
  const parts = plusKey ? key.slice(0, -1).split('+').filter(Boolean) : key.split('+');
  const lastRaw = plusKey ? '+' : parts.pop()!;
  let modifiers = 0;
  for (const p of parts) modifiers |= MODIFIERS[p.toLowerCase()] ?? 0;
  // Ctrl/Alt/Meta chords are shortcuts, not text.
  const chord = (modifiers & (1 | 2 | 4)) !== 0;

  const named = NAMED_KEYS[lastRaw] ?? NAMED_KEYS[lastRaw.charAt(0).toUpperCase() + lastRaw.slice(1)];
  let def: KeyDef;
  if (named) {
    def = named;
  } else if (lastRaw.length === 1) {
    const upper = lastRaw.toUpperCase();
    const letter = /^[a-z]$/i.test(lastRaw);
    const digit = /^[0-9]$/.test(lastRaw);
    const code = letter ? `Key${upper}` : digit ? `Digit${lastRaw}` : '';
    const shifted = (modifiers & 8) !== 0 && letter ? upper : lastRaw;
    // Virtual key codes only line up with char codes for A–Z and 0–9; "." is
    // 46, which Chromium would take for Delete.
    def = { key: shifted, code, keyCode: letter || digit ? upper.charCodeAt(0) : 0, text: shifted };
  } else {
    def = { key: lastRaw, code: lastRaw, keyCode: 0 };
  }

  const text = chord ? undefined : def.text;
  const down: Record<string, unknown> = {
    type: text ? 'keyDown' : 'rawKeyDown',
    key: def.key,
    code: def.code || undefined,
    windowsVirtualKeyCode: def.keyCode || undefined,
    modifiers,
  };
  if (text) { down.text = text; down.unmodifiedText = text; }
  // Editing shortcuts come from the OS on a Mac, so the renderer needs the command spelled out.
  if (chord && def.key.toLowerCase() === 'a' && (modifiers & (2 | 4))) down.commands = ['selectAll'];
  const up = { type: 'keyUp', key: def.key, code: def.code || undefined, windowsVirtualKeyCode: def.keyCode || undefined, modifiers };
  return [down, up];
}

export async function pressKey(page: PageSession, key: string): Promise<{ ok: true }> {
  for (const ev of buildKeyEvents(key)) await page.send('Input.dispatchKeyEvent', ev);
  return { ok: true };
}

export async function selectOption(page: PageSession, ref: string, values: string[]): Promise<{ ok: true }> {
  await withObjectId(page, ref, async (objectId) => {
    await callOn(page, objectId, `function(values) {
      if (this.tagName !== 'SELECT') throw new Error('select_option requires a <select> element');
      var wanted = new Set(values);
      var changed = false;
      for (var i = 0; i < this.options.length; i++) {
        var opt = this.options[i];
        var should = wanted.has(opt.value) || wanted.has(opt.label) || wanted.has(opt.text);
        if (opt.selected !== should) { opt.selected = should; changed = true; }
        if (!this.multiple && should) break;
      }
      if (changed) {
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }`, [values]);
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// scroll
// ---------------------------------------------------------------------------

export async function scroll(page: PageSession, opts: { ref?: string; x?: number; y?: number }): Promise<{ ok: true }> {
  if (opts.ref) {
    await withObjectId(page, opts.ref, (objectId) =>
      callOn(page, objectId, `function() { this.scrollIntoView({ behavior: 'instant', block: 'center' }); }`));
    return { ok: true };
  }
  const x = Number.isFinite(opts.x) ? Number(opts.x) : 0;
  const y = Number.isFinite(opts.y) ? Number(opts.y) : 0;
  await page.send('Runtime.evaluate', { expression: `window.scrollTo(${x}, ${y})` });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// navigate
// ---------------------------------------------------------------------------

/** What a model may navigate to. Never file: — the browser runs on the server. */
export const TOOL_URL_SCHEMES: readonly string[] = ['http:', 'https:'];

export function checkUrl(raw: string, allowedSchemes: readonly string[] = TOOL_URL_SCHEMES): URL {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`Invalid URL "${raw}"`); }
  if (!allowedSchemes.includes(parsed.protocol)) {
    throw new Error(allowedSchemes.length === 2 ? 'Only http/https URLs are supported' : `URL scheme ${parsed.protocol} is not allowed`);
  }
  return parsed;
}

const isMainFrame = (p: { frame?: { parentId?: string } }) => !!p.frame && !p.frame.parentId;

/** Load `url` and wait (bounded) for the load event. A slow page is not an error — wait_for covers it. */
export async function goto(page: PageSession, url: string, opts: { allowedSchemes?: readonly string[]; loadTimeoutMs?: number } = {}): Promise<void> {
  const target = checkUrl(url, opts.allowedSchemes).toString();
  const load = page.waitForEvent('Page.loadEventFired', opts.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS);
  let r: { loaderId?: string; errorText?: string };
  try {
    r = await page.send<{ loaderId?: string; errorText?: string }>('Page.navigate', { url: target });
  } catch (err) {
    load.cancel();
    throw err;
  }
  if (r.errorText) {
    load.cancel();
    throw new Error(`Navigation to ${target} failed: ${r.errorText}`);
  }
  // No loaderId = same-document navigation (a #fragment): nothing will load.
  if (!r.loaderId) { load.cancel(); return; }
  await load.promise.catch(() => {});
}

export async function navigate(
  page: PageSession,
  action: 'goto' | 'back' | 'forward' | 'reload',
  url?: string,
  opts: { allowedSchemes?: readonly string[]; loadTimeoutMs?: number } = {},
): Promise<{ ok: true }> {
  if (action === 'goto') {
    if (!url) throw new Error('goto requires `url`');
    await goto(page, url, opts);
  } else if (action === 'back' || action === 'forward') {
    const { currentIndex, entries } = await page.send<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory');
    const entry = entries[currentIndex + (action === 'back' ? -1 : 1)];
    if (entry) {
      // A back-forward-cache restore never fires `load`, but it does navigate the main frame.
      const moved = page.waitForEvent('Page.frameNavigated', 5_000, isMainFrame);
      await page.send('Page.navigateToHistoryEntry', { entryId: entry.id });
      await moved.promise.catch(() => {});
    }
  } else if (action === 'reload') {
    const load = page.waitForEvent('Page.loadEventFired', opts.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS);
    await page.send('Page.reload', {});
    await load.promise.catch(() => {});
  } else {
    throw new Error(`Unknown navigation action "${String(action)}"`);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

/**
 * Run a JS function in the page. With `ref` it receives the element as
 * `this` and as its first argument; otherwise it runs in global scope.
 */
export async function evaluate(page: PageSession, fn: string, opts: { ref?: string } = {}): Promise<{ value: unknown }> {
  if (opts.ref) {
    const r = await withObjectId(page, opts.ref, (objectId) =>
      page.send<RemoteObjectResult>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: fn,
        returnByValue: true,
        awaitPromise: true,
        arguments: [{ objectId }],
      }));
    checkException(r, 'The function');
    return { value: r.result?.value };
  }
  const r = await page.send<RemoteObjectResult>('Runtime.evaluate', {
    expression: `(${fn})()`,
    returnByValue: true,
    awaitPromise: true,
  });
  checkException(r, 'The function');
  return { value: r.result?.value };
}

// ---------------------------------------------------------------------------
// wait_for
// ---------------------------------------------------------------------------

/** Block until `text` appears, `textGone` disappears, or `time` seconds pass. Polls every 100ms. */
export async function waitFor(page: PageSession, opts: { text?: string; textGone?: string; time?: number; timeoutMs?: number }): Promise<{ ok: true }> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  if (opts.time != null) {
    await Bun.sleep(Math.max(0, opts.time * 1000));
    return { ok: true };
  }
  if (opts.text == null && opts.textGone == null) throw new Error('wait_for requires one of `text`, `textGone`, or `time`');
  const expression = opts.text != null
    ? `!!document.body && document.body.innerText.includes(${JSON.stringify(opts.text)})`
    : `!document.body || !document.body.innerText.includes(${JSON.stringify(opts.textGone)})`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await page.send<RemoteObjectResult<boolean>>('Runtime.evaluate', { expression, returnByValue: true }, { timeoutMs: 2_000 })
      .catch(() => ({ result: { value: false } }));
    if (r.result?.value) return { ok: true };
    await Bun.sleep(100);
  }
  throw new Error(`wait_for timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// console / network / dialog
// ---------------------------------------------------------------------------

export function consoleMessages(page: PageSession, opts: { tail?: number } = {}): { entries: ConsoleEntry[] } {
  const tail = Math.max(1, Math.min(CONSOLE_BUFFER, opts.tail ?? 50));
  return { entries: page.consoleBuf.slice(-tail) };
}

export function networkRequests(page: PageSession, opts: { tail?: number } = {}): { entries: NetEntry[] } {
  const tail = Math.max(1, Math.min(NET_BUFFER, opts.tail ?? 50));
  return { entries: page.network.slice(-tail) };
}

export async function handleDialog(page: PageSession, opts: { accept: boolean; promptText?: string }): Promise<{ ok: true; handled: DialogState | null }> {
  const dialog = page.pendingDialog;
  if (!dialog) return { ok: true, handled: null };
  await page.send('Page.handleJavaScriptDialog', { accept: opts.accept, promptText: opts.promptText });
  page.pendingDialog = null;
  return { ok: true, handled: dialog };
}

// ---------------------------------------------------------------------------
// Dispatch — the same argument names the Electron IPC handlers take
// ---------------------------------------------------------------------------

const optString = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const optNumber = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function reqString(args: Record<string, unknown>, key: string, action: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v) throw new Error(`browser_${action} requires \`${key}\``);
  return v;
}

export async function dispatchAction(page: PageSession, action: BrowserAction, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (action) {
    case 'snapshot':
      return snapshot(page);
    case 'take_screenshot':
      return screenshot(page);
    case 'click': {
      const button = args.button === 'right' || args.button === 'middle' || args.button === 'left' ? args.button : undefined;
      return click(page, reqString(args, 'ref', action), { button, doubleClick: args.doubleClick === true });
    }
    case 'hover':
      return hover(page, reqString(args, 'ref', action));
    case 'type':
      return typeText(page, reqString(args, 'ref', action), typeof args.text === 'string' ? args.text : '', { submit: args.submit === true });
    case 'press_key':
      return pressKey(page, reqString(args, 'key', action));
    case 'select_option': {
      const values = Array.isArray(args.values) ? args.values.filter((v): v is string => typeof v === 'string') : [];
      if (!values.length) throw new Error('browser_select_option requires `values`');
      return selectOption(page, reqString(args, 'ref', action), values);
    }
    case 'scroll':
      return scroll(page, { ref: optString(args.ref), x: optNumber(args.x), y: optNumber(args.y) });
    case 'navigate': {
      const url = optString(args.url);
      // The requirements runner sends `{ url }` alone and means "go there".
      const nav = args.action ?? (url ? 'goto' : undefined);
      if (nav !== 'goto' && nav !== 'back' && nav !== 'forward' && nav !== 'reload') throw new Error('browser_navigate requires `action`');
      return navigate(page, nav, url);
    }
    case 'evaluate':
      return evaluate(page, reqString(args, 'function', action), { ref: optString(args.ref) });
    case 'wait_for':
      return waitFor(page, {
        text: typeof args.text === 'string' ? args.text : undefined,
        textGone: typeof args.textGone === 'string' ? args.textGone : undefined,
        time: optNumber(args.time),
        timeoutMs: optNumber(args.timeoutMs),
      });
    case 'console_messages':
      return consoleMessages(page, { tail: optNumber(args.tail) });
    case 'network_requests':
      return networkRequests(page, { tail: optNumber(args.tail) });
    case 'handle_dialog':
      return handleDialog(page, { accept: args.accept === true, promptText: typeof args.promptText === 'string' ? args.promptText : undefined });
    default:
      throw new Error(`Unknown action "${String(action)}".`);
  }
}
