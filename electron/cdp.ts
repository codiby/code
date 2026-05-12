/**
 * CDP wrappers for each browser preview — playwright-cli–compatible surface.
 *
 * Per-preview state attaches once on `attachCdp(label, webContents)` and is
 * teared down on `detachCdp(label)`. The exported functions are called from
 * `electron/main.ts`'s `ipcMain.handle('tauri:cdp_*')` handlers, which the
 * bridge reaches via the renderer → preload `__TAURI_INTERNALS__.invoke`
 * shim.
 *
 * Snapshot uses the full accessibility tree (CDP `Accessibility.getFullAXTree`)
 * rendered as indented YAML with `[ref=eN]` handles, exactly the shape
 * playwright-cli's `browser_snapshot` returns. The same `eN` handles are then
 * accepted by every action tool (click / type / hover / select / etc.) until
 * the next snapshot regenerates the table.
 *
 * Buffered domains:
 *   - Network — last 200 `Network.requestWillBeSent` + response/finish/fail.
 *   - Console — last 200 `Runtime.consoleAPICalled` + `Runtime.exceptionThrown`.
 *   - Dialog  — single in-flight `Page.javascriptDialogOpening`. `handle_dialog`
 *               drains it via `Page.handleJavaScriptDialog`.
 */
import type { WebContents } from 'electron';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NetEntry = {
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

type ConsoleEntry = {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'exception';
  text: string;
  url?: string;
  line?: number;
  ts: number;
};

type DialogState = {
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

type CdpState = {
  wc: WebContents;
  refToBackendNode: Map<string, number>;
  network: NetEntry[];
  netInflight: Map<string, NetEntry>;
  consoleBuf: ConsoleEntry[];
  pendingDialog: DialogState | null;
};

const NET_BUFFER = 200;
const CONSOLE_BUFFER = 200;

const states = new Map<string, CdpState>();

function getState(label: string): CdpState {
  const s = states.get(label);
  if (!s) throw new Error(`no CDP state for label "${label}" — is the preview open?`);
  return s;
}

function send<T = unknown>(wc: WebContents, method: string, params?: object): Promise<T> {
  return wc.debugger.sendCommand(method, params ?? {}) as Promise<T>;
}

// ---------------------------------------------------------------------------
// attach / detach
// ---------------------------------------------------------------------------

export function attachCdp(label: string, wc: WebContents): void {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  } catch {
    return;
  }

  const state: CdpState = {
    wc,
    refToBackendNode: new Map(),
    network: [],
    netInflight: new Map(),
    consoleBuf: [],
    pendingDialog: null,
  };
  states.set(label, state);

  // Domains we drive — all best-effort, failures surface at call time.
  send(wc, 'Page.enable').catch(() => {});
  send(wc, 'DOM.enable').catch(() => {});
  send(wc, 'Runtime.enable').catch(() => {});
  send(wc, 'Network.enable').catch(() => {});
  send(wc, 'Accessibility.enable').catch(() => {});
  // Page.javascriptDialogOpening is fired by Page.enable; no extra enable needed.

  wc.debugger.on('message', (_e, method, params) => {
    if (method === 'Network.requestWillBeSent') {
      const p = params as { requestId: string; request: { url: string; method: string } };
      const entry: NetEntry = { requestId: p.requestId, method: p.request.method, url: p.request.url, ts: Date.now() };
      state.netInflight.set(p.requestId, entry);
      state.network.push(entry);
      if (state.network.length > NET_BUFFER) state.network.splice(0, state.network.length - NET_BUFFER);
      return;
    }
    if (method === 'Network.responseReceived') {
      const p = params as { requestId: string; response: { status: number; statusText: string; mimeType: string; fromDiskCache?: boolean; fromServiceWorker?: boolean } };
      const e = state.netInflight.get(p.requestId);
      if (!e) return;
      e.status = p.response.status;
      e.statusText = p.response.statusText;
      e.mimeType = p.response.mimeType;
      e.fromCache = !!(p.response.fromDiskCache || p.response.fromServiceWorker);
      return;
    }
    if (method === 'Network.loadingFinished') {
      const p = params as { requestId: string };
      const e = state.netInflight.get(p.requestId);
      if (!e) return;
      e.endTs = Date.now();
      state.netInflight.delete(p.requestId);
      return;
    }
    if (method === 'Network.loadingFailed') {
      const p = params as { requestId: string; errorText?: string };
      const e = state.netInflight.get(p.requestId);
      if (!e) return;
      e.endTs = Date.now();
      e.errorText = p.errorText;
      state.netInflight.delete(p.requestId);
      return;
    }
    if (method === 'Runtime.consoleAPICalled') {
      const p = params as {
        type: string;
        args: Array<{ type: string; value?: unknown; description?: string }>;
        timestamp: number;
        stackTrace?: { callFrames: Array<{ url: string; lineNumber: number }> };
      };
      const text = p.args
        .map((a) => (a.value !== undefined ? String(a.value) : a.description ?? a.type))
        .join(' ');
      const frame = p.stackTrace?.callFrames?.[0];
      const level = (['log', 'info', 'warn', 'error', 'debug'] as const).includes(p.type as 'log')
        ? (p.type as ConsoleEntry['level'])
        : 'log';
      state.consoleBuf.push({ level, text, url: frame?.url, line: frame?.lineNumber, ts: Date.now() });
      if (state.consoleBuf.length > CONSOLE_BUFFER) state.consoleBuf.splice(0, state.consoleBuf.length - CONSOLE_BUFFER);
      return;
    }
    if (method === 'Runtime.exceptionThrown') {
      const p = params as { exceptionDetails: { text: string; exception?: { description?: string }; url?: string; lineNumber?: number } };
      const text = p.exceptionDetails.exception?.description || p.exceptionDetails.text;
      state.consoleBuf.push({ level: 'exception', text, url: p.exceptionDetails.url, line: p.exceptionDetails.lineNumber, ts: Date.now() });
      if (state.consoleBuf.length > CONSOLE_BUFFER) state.consoleBuf.splice(0, state.consoleBuf.length - CONSOLE_BUFFER);
      return;
    }
    if (method === 'Page.javascriptDialogOpening') {
      const p = params as { type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string; defaultPrompt?: string };
      state.pendingDialog = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt };
      return;
    }
    if (method === 'Page.javascriptDialogClosed') {
      state.pendingDialog = null;
      return;
    }
  });
}

export function detachCdp(label: string): void {
  const state = states.get(label);
  if (!state) return;
  try {
    if (state.wc.debugger.isAttached()) state.wc.debugger.detach();
  } catch {}
  states.delete(label);
}

// ---------------------------------------------------------------------------
// snapshot — AX tree → YAML
// ---------------------------------------------------------------------------

/**
 * Properties we surface alongside the role/name in the YAML output. AX nodes
 * carry many more (focusable, focused, busy, etc.); we keep the ones that
 * usefully constrain identification or describe state.
 */
const ECHOED_PROPS = new Set(['level', 'checked', 'pressed', 'expanded', 'selected', 'disabled', 'readonly', 'required', 'placeholder']);

function quoteForYaml(s: string | undefined): string {
  if (!s) return '';
  // Match playwright's quoting: double-quotes with backslash-escapes.
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').slice(0, 200)}"`;
}

export async function snapshot(label: string): Promise<{ url: string; title: string; yaml: string }> {
  const state = getState(label);
  const wc = state.wc;

  // Refresh the ref table so old refs from a previous snapshot fail loudly.
  state.refToBackendNode.clear();

  const { nodes } = await send<{ nodes: AxNode[] }>(wc, 'Accessibility.getFullAXTree');
  const byId = new Map<string, AxNode>();
  for (const n of nodes) byId.set(n.nodeId, n);

  // Identify roots: a node whose parent isn't in the slice we got.
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
      state.refToBackendNode.set(ref, node.backendDOMNodeId);
      const indent = '  '.repeat(depth);
      const headParts = [`- ${role}`];
      if (name) headParts.push(quoteForYaml(name));
      if (value) headParts.push(`value=${quoteForYaml(String(value))}`);
      const props = describeProps(node);
      lines.push(`${indent}${headParts.join(' ')}${props} [ref=${ref}]`);
      printedSelf = true;
    }

    const nextDepth = printedSelf ? depth + 1 : depth;
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (!child) continue;
      walk(child, nextDepth);
    }
  }

  for (const root of roots) walk(root, 0);

  return { url: wc.getURL(), title: wc.getTitle(), yaml: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// screenshot
// ---------------------------------------------------------------------------

export async function screenshot(label: string): Promise<{ format: 'png'; data: string }> {
  const state = getState(label);
  const r = await send<{ data: string }>(state.wc, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  return { format: 'png', data: r.data };
}

// ---------------------------------------------------------------------------
// helpers for action tools
// ---------------------------------------------------------------------------

async function resolveBackendObjectId(state: CdpState, ref: string): Promise<string> {
  const backendNodeId = state.refToBackendNode.get(ref);
  if (!backendNodeId) throw new Error(`unknown ref "${ref}" — call browser_snapshot first to refresh refs`);
  const r = await send<{ object: { objectId: string } }>(state.wc, 'DOM.resolveNode', { backendNodeId });
  return r.object.objectId;
}

async function withObjectId<T>(state: CdpState, ref: string, fn: (objectId: string) => Promise<T>): Promise<T> {
  const objectId = await resolveBackendObjectId(state, ref);
  try { return await fn(objectId); }
  finally { await send(state.wc, 'Runtime.releaseObject', { objectId }).catch(() => {}); }
}

async function getElementCenter(state: CdpState, objectId: string): Promise<{ x: number; y: number }> {
  // Scroll into view first so the rect is meaningful.
  await send(state.wc, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function() { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }`,
    awaitPromise: false,
  });
  const result = await send<{ result: { value: { x: number; y: number; w: number; h: number } } }>(state.wc, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function() { var r = this.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }`,
    returnByValue: true,
  });
  const r = result.result.value;
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

// ---------------------------------------------------------------------------
// click / hover / drag
// ---------------------------------------------------------------------------

export async function click(label: string, ref: string, opts: { button?: 'left' | 'right' | 'middle'; doubleClick?: boolean } = {}): Promise<{ ok: true }> {
  const state = getState(label);
  await withObjectId(state, ref, async (objectId) => {
    if (!opts.doubleClick && (opts.button ?? 'left') === 'left') {
      // Fast path — programmatic .click() for plain left-clicks. Survives
      // overlays + works for elements that may not be hit-testable via
      // dispatched mouse events.
      await send(state.wc, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() {
          this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          if (typeof this.click === 'function') { this.click(); return; }
          var ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
          this.dispatchEvent(ev);
        }`,
        awaitPromise: false,
      });
      return;
    }
    // Synthetic mouse events for right/middle/double clicks.
    const { x, y } = await getElementCenter(state, objectId);
    const button = opts.button ?? 'left';
    const clickCount = opts.doubleClick ? 2 : 1;
    await send(state.wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send(state.wc, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
    await send(state.wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
    if (opts.doubleClick) {
      // Two press/release pairs is what dispatchMouseEvent expects for dblclick.
      await send(state.wc, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
      await send(state.wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
    }
  });
  return { ok: true };
}

export async function hover(label: string, ref: string): Promise<{ ok: true }> {
  const state = getState(label);
  await withObjectId(state, ref, async (objectId) => {
    const { x, y } = await getElementCenter(state, objectId);
    await send(state.wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// type / press_key / select_option
// ---------------------------------------------------------------------------

/**
 * Set the value of an input/textarea (replaces existing content) and fire
 * input + change. If `submit` is true, also dispatch a synthetic Enter
 * keydown so form-submission handlers fire. Matches playwright's
 * `browser_type({ ref, text, submit })`.
 */
export async function type_(label: string, ref: string, text: string, opts: { submit?: boolean } = {}): Promise<{ ok: true }> {
  const state = getState(label);
  await withObjectId(state, ref, async (objectId) => {
    await send(state.wc, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(v) {
        this.focus();
        var proto = Object.getPrototypeOf(this);
        var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && typeof desc.set === 'function') desc.set.call(this, v);
        else this.value = v;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      arguments: [{ value: text }],
      awaitPromise: false,
    });
  });
  if (opts.submit) {
    await pressKey(label, 'Enter');
  }
  return { ok: true };
}

/**
 * Map a playwright-style key name (e.g. 'Enter', 'Escape', 'ArrowDown',
 * 'Control+a') to a CDP `Input.dispatchKeyEvent` payload. Single
 * printable characters fall through to type 'char'.
 */
function buildKeyEvent(key: string): { type: 'keyDown' | 'rawKeyDown' | 'char'; key: string; code?: string; modifiers?: number }[] {
  // Modifier bitmask used by CDP: Alt=1, Ctrl=2, Meta=4, Shift=8.
  const MOD: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
  const parts = key.split('+');
  const lastRaw = parts.pop()!;
  let modifiers = 0;
  for (const p of parts) modifiers |= MOD[p.toLowerCase()] ?? 0;

  // Named keys table — playwright's small set. CDP wants `key` (the
  // value-like form, e.g. 'Enter') and ideally a `code` (e.g. 'Enter').
  const named: Record<string, { key: string; code: string }> = {
    Enter: { key: 'Enter', code: 'Enter' },
    Escape: { key: 'Escape', code: 'Escape' },
    Tab: { key: 'Tab', code: 'Tab' },
    Backspace: { key: 'Backspace', code: 'Backspace' },
    Delete: { key: 'Delete', code: 'Delete' },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp' },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown' },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft' },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight' },
    Home: { key: 'Home', code: 'Home' },
    End: { key: 'End', code: 'End' },
    PageUp: { key: 'PageUp', code: 'PageUp' },
    PageDown: { key: 'PageDown', code: 'PageDown' },
    Space: { key: ' ', code: 'Space' },
    ' ': { key: ' ', code: 'Space' },
  };
  const named1 = named[lastRaw] ?? named[lastRaw.charAt(0).toUpperCase() + lastRaw.slice(1)];
  if (named1) {
    return [
      { type: 'rawKeyDown', key: named1.key, code: named1.code, modifiers },
      // CDP doesn't need an explicit keyUp for most named keys to fire
      // listeners; rawKeyDown carries the listener-visible event. If a page
      // hangs on this we can add an Input.dispatchKeyEvent({ type: 'keyUp' })
      // here in the future.
    ];
  }
  // Single-char fallback.
  if (lastRaw.length === 1) {
    return [{ type: 'char', key: lastRaw, modifiers }];
  }
  // Last-ditch: send as `key` and hope the page handles it.
  return [{ type: 'rawKeyDown', key: lastRaw, modifiers }];
}

export async function pressKey(label: string, key: string): Promise<{ ok: true }> {
  const state = getState(label);
  for (const ev of buildKeyEvent(key)) {
    await send(state.wc, 'Input.dispatchKeyEvent', ev);
  }
  return { ok: true };
}

export async function selectOption(label: string, ref: string, values: string[]): Promise<{ ok: true }> {
  const state = getState(label);
  await withObjectId(state, ref, async (objectId) => {
    await send(state.wc, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(values) {
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
      }`,
      arguments: [{ value: values }],
      awaitPromise: false,
    });
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// scroll
// ---------------------------------------------------------------------------

export async function scroll(label: string, opts: { ref?: string; x?: number; y?: number }): Promise<{ ok: true }> {
  const state = getState(label);
  if (opts.ref) {
    await withObjectId(state, opts.ref, async (objectId) => {
      await send(state.wc, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() { this.scrollIntoView({ behavior: 'instant', block: 'center' }); }`,
        awaitPromise: false,
      });
    });
    return { ok: true };
  }
  const x = Number.isFinite(opts.x) ? Number(opts.x) : 0;
  const y = Number.isFinite(opts.y) ? Number(opts.y) : 0;
  await send(state.wc, 'Runtime.evaluate', { expression: `window.scrollTo(${x}, ${y})` });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// navigate
// ---------------------------------------------------------------------------

export async function navigate(label: string, action: 'goto' | 'back' | 'forward' | 'reload', url?: string): Promise<{ ok: true }> {
  const state = getState(label);
  const wc = state.wc;
  if (action === 'goto') {
    if (!url) throw new Error('goto requires `url`');
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http/https URLs are supported');
    }
    await wc.loadURL(parsed.toString());
  } else if (action === 'back') {
    if (wc.canGoBack()) wc.goBack();
  } else if (action === 'forward') {
    if (wc.canGoForward()) wc.goForward();
  } else if (action === 'reload') {
    wc.reload();
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

/**
 * Run an arbitrary JS function in the page. If `ref` is provided, the function
 * receives the resolved element as its `this` (and as the first argument);
 * otherwise the function runs in global scope. Returns the function's return
 * value, JSON-serialised.
 */
export async function evaluate(label: string, fn: string, opts: { ref?: string } = {}): Promise<{ value: unknown }> {
  const state = getState(label);
  if (opts.ref) {
    const result = await withObjectId(state, opts.ref, async (objectId) => {
      return await send<{ result: { value: unknown } }>(state.wc, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: fn,
        returnByValue: true,
        awaitPromise: true,
        arguments: [{ objectId }],
      });
    });
    return { value: result.result?.value };
  }
  const result = await send<{ result: { value: unknown } }>(state.wc, 'Runtime.evaluate', {
    expression: `(${fn})()`,
    returnByValue: true,
    awaitPromise: true,
  });
  return { value: result.result?.value };
}

// ---------------------------------------------------------------------------
// wait_for
// ---------------------------------------------------------------------------

/**
 * Block until one of:
 *   - `text` appears in the page (textContent contains).
 *   - `textGone` disappears from the page.
 *   - `time` seconds elapse.
 * Times out after `timeoutMs` (default 5s). Poll interval 100ms.
 */
export async function waitFor(
  label: string,
  opts: { text?: string; textGone?: string; time?: number; timeoutMs?: number },
): Promise<{ ok: true }> {
  const state = getState(label);
  const timeoutMs = opts.timeoutMs ?? 5000;

  if (opts.time != null) {
    const seconds = opts.time;
    await new Promise((r) => setTimeout(r, Math.max(0, seconds * 1000)));
    return { ok: true };
  }
  if (opts.text == null && opts.textGone == null) {
    throw new Error('wait_for requires one of `text`, `textGone`, or `time`');
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const expr = opts.text != null
      ? `document.body && document.body.innerText.includes(${JSON.stringify(opts.text)})`
      : `!document.body || !document.body.innerText.includes(${JSON.stringify(opts.textGone)})`;
    const r = await send<{ result: { value: boolean } }>(state.wc, 'Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
    }).catch(() => ({ result: { value: false } as { value: boolean } }));
    if (r.result?.value) return { ok: true };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`wait_for timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// console / network / dialog
// ---------------------------------------------------------------------------

export function consoleMessages(label: string, opts: { tail?: number } = {}): { entries: ConsoleEntry[] } {
  const state = getState(label);
  const tail = Math.max(1, Math.min(CONSOLE_BUFFER, opts.tail ?? 50));
  return { entries: state.consoleBuf.slice(-tail) };
}

export function network(label: string, opts: { tail?: number } = {}): { entries: NetEntry[] } {
  const state = getState(label);
  const tail = Math.max(1, Math.min(NET_BUFFER, opts.tail ?? 50));
  return { entries: state.network.slice(-tail) };
}

export async function handleDialog(
  label: string,
  opts: { accept: boolean; promptText?: string },
): Promise<{ ok: true; handled: DialogState | null }> {
  const state = getState(label);
  const dialog = state.pendingDialog;
  if (!dialog) return { ok: true, handled: null };
  await send(state.wc, 'Page.handleJavaScriptDialog', {
    accept: opts.accept,
    promptText: opts.promptText,
  });
  state.pendingDialog = null;
  return { ok: true, handled: dialog };
}

/** Read the in-flight dialog without acting on it (useful for tests). */
export function peekDialog(label: string): DialogState | null {
  return getState(label).pendingDialog;
}
