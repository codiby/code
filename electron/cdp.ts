/**
 * CDP wrappers for each browser preview.
 *
 * On preview create, `attachCdp(label, webContents)` attaches the Chrome
 * DevTools Protocol debugger and enables the Page/DOM/Runtime/Network
 * domains. The tools below issue commands against the resulting
 * `webContents.debugger`:
 *
 *   - snapshot(label)         → flat list of interactive nodes with ids
 *   - screenshot(label)       → base64 PNG of the viewport
 *   - click(label, id)        → click by snapshot id
 *   - fill(label, id, value)  → set value + fire input/change
 *   - scroll(label, opts)     → scroll element into view OR scroll viewport
 *   - network(label, opts)    → ring buffer of recent requests
 *
 * Ids are synthetic strings handed out by the most recent snapshot. Each
 * snapshot rebuilds the id→backendNodeId map; stale ids fail loudly.
 */
import type { WebContents } from 'electron';

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

type CdpState = {
  wc: WebContents;
  idToBackendNode: Map<string, number>;
  /** Ring buffer of recent network requests. */
  network: NetEntry[];
  /** Lookup of in-flight requests by CDP requestId. */
  netInflight: Map<string, NetEntry>;
};

const NET_BUFFER = 200;
const states = new Map<string, CdpState>();

function getState(label: string): CdpState {
  const s = states.get(label);
  if (!s) throw new Error(`no CDP state for label "${label}" — is the preview open?`);
  return s;
}

function send<T = unknown>(wc: WebContents, method: string, params?: object): Promise<T> {
  return wc.debugger.sendCommand(method, params ?? {}) as Promise<T>;
}

export function attachCdp(label: string, wc: WebContents): void {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  } catch (e) {
    // Attach can throw if a devtools window is already attached; degrade
    // silently — the tool calls will surface a clearer error.
    return;
  }

  const state: CdpState = {
    wc,
    idToBackendNode: new Map(),
    network: [],
    netInflight: new Map(),
  };
  states.set(label, state);

  // Enable the domains the tools need. Failures are non-fatal — surface at
  // call time instead of crashing the preview open.
  send(wc, 'Page.enable').catch(() => {});
  send(wc, 'DOM.enable').catch(() => {});
  send(wc, 'Runtime.enable').catch(() => {});
  send(wc, 'Network.enable').catch(() => {});

  wc.debugger.on('message', (_e, method, params) => {
    if (method === 'Network.requestWillBeSent') {
      const p = params as {
        requestId: string;
        request: { url: string; method: string };
        timestamp?: number;
      };
      const entry: NetEntry = {
        requestId: p.requestId,
        method: p.request.method,
        url: p.request.url,
        ts: Date.now(),
      };
      state.netInflight.set(p.requestId, entry);
      state.network.push(entry);
      if (state.network.length > NET_BUFFER) state.network.splice(0, state.network.length - NET_BUFFER);
    } else if (method === 'Network.responseReceived') {
      const p = params as {
        requestId: string;
        response: { status: number; statusText: string; mimeType: string; fromDiskCache?: boolean; fromServiceWorker?: boolean };
      };
      const entry = state.netInflight.get(p.requestId);
      if (!entry) return;
      entry.status = p.response.status;
      entry.statusText = p.response.statusText;
      entry.mimeType = p.response.mimeType;
      entry.fromCache = !!(p.response.fromDiskCache || p.response.fromServiceWorker);
    } else if (method === 'Network.loadingFinished') {
      const p = params as { requestId: string };
      const entry = state.netInflight.get(p.requestId);
      if (!entry) return;
      entry.endTs = Date.now();
      state.netInflight.delete(p.requestId);
    } else if (method === 'Network.loadingFailed') {
      const p = params as { requestId: string; errorText?: string };
      const entry = state.netInflight.get(p.requestId);
      if (!entry) return;
      entry.endTs = Date.now();
      entry.errorText = p.errorText;
      state.netInflight.delete(p.requestId);
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
// snapshot
// ---------------------------------------------------------------------------

/**
 * Walk the DOM via Runtime.evaluate (cheaper than DOM.getDocument+pierce for
 * a one-shot snapshot; we don't need a live tree, just a flat list of
 * candidates with stable handles). Each interactive node gets a synthetic id;
 * the corresponding `backendNodeId` is recorded so click/fill/scroll can
 * later resolve to it.
 */
const SNAPSHOT_SCRIPT = `
(() => {
  const SELECTORS = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea',
    '[role=button]', '[role=link]', '[role=textbox]', '[role=checkbox]',
    '[role=radio]', '[role=tab]', '[role=menuitem]', '[contenteditable=true]',
  ];
  const nodes = Array.from(document.querySelectorAll(SELECTORS.join(',')));
  return nodes.map((el, i) => {
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || tag;
    const name =
      (el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 80) ||
        el.getAttribute('placeholder') ||
        el.getAttribute('name') ||
        ''
      ).slice(0, 120);
    const value = (el).value != null ? String((el).value).slice(0, 200) : undefined;
    const href = el.getAttribute('href') || undefined;
    return {
      idx: i,
      tag, role, name, value, href,
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
      visible: r.width > 0 && r.height > 0,
    };
  });
})()
`;

export async function snapshot(label: string): Promise<{
  url: string;
  title: string;
  nodes: Array<{
    id: string; tag: string; role: string; name: string; value?: string; href?: string;
    bounds: { x: number; y: number; width: number; height: number };
    visible: boolean;
  }>;
}> {
  const state = getState(label);
  const wc = state.wc;

  const url = wc.getURL();
  const title = wc.getTitle();

  // 1. Get the raw list of candidates from the page.
  type RawNode = {
    idx: number; tag: string; role: string; name: string; value?: string; href?: string;
    x: number; y: number; w: number; h: number; visible: boolean;
  };
  const result = await send<{ result: { value: RawNode[] } }>(wc, 'Runtime.evaluate', {
    expression: SNAPSHOT_SCRIPT,
    returnByValue: true,
  });
  const raw = (result.result?.value as RawNode[] | undefined) ?? [];

  // 2. Resolve each one to a backendNodeId so click/fill can address it
  //    even after the DOM rearranges.
  state.idToBackendNode.clear();
  const nodes: Awaited<ReturnType<typeof snapshot>>['nodes'] = [];
  for (const item of raw) {
    const synthId = `n${item.idx}`;
    try {
      // Re-evaluate to get an object handle for *this specific* node, then
      // pull its backendNodeId via DOM.describeNode.
      const handle = await send<{ result: { objectId?: string } }>(wc, 'Runtime.evaluate', {
        expression: `document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=textbox], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [contenteditable=true]')[${item.idx}]`,
        returnByValue: false,
      });
      const objectId = handle.result?.objectId;
      if (objectId) {
        const desc = await send<{ node: { backendNodeId: number } }>(wc, 'DOM.describeNode', { objectId });
        const backendNodeId = desc.node?.backendNodeId;
        if (backendNodeId) state.idToBackendNode.set(synthId, backendNodeId);
        await send(wc, 'Runtime.releaseObject', { objectId }).catch(() => {});
      }
    } catch {
      // Snapshot is best-effort; skip unresolvable nodes.
    }
    nodes.push({
      id: synthId,
      tag: item.tag, role: item.role, name: item.name,
      value: item.value, href: item.href,
      bounds: { x: item.x, y: item.y, width: item.w, height: item.h },
      visible: item.visible,
    });
  }

  return { url, title, nodes };
}

// ---------------------------------------------------------------------------
// screenshot
// ---------------------------------------------------------------------------

export async function screenshot(label: string): Promise<{ format: 'png'; data: string }> {
  const state = getState(label);
  const r = await send<{ data: string }>(state.wc, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  return { format: 'png', data: r.data };
}

// ---------------------------------------------------------------------------
// click / fill / scroll
// ---------------------------------------------------------------------------

async function resolveBackendObjectId(state: CdpState, id: string): Promise<string> {
  const backendNodeId = state.idToBackendNode.get(id);
  if (!backendNodeId) {
    throw new Error(`unknown id "${id}" — call browser_snapshot first to refresh ids`);
  }
  const r = await send<{ object: { objectId: string } }>(state.wc, 'DOM.resolveNode', { backendNodeId });
  return r.object.objectId;
}

export async function click(label: string, id: string): Promise<{ ok: true }> {
  const state = getState(label);
  const objectId = await resolveBackendObjectId(state, id);
  try {
    await send(state.wc, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        this.scrollIntoView({ behavior: 'instant', block: 'center' });
        if (typeof this.click === 'function') { this.click(); return; }
        var ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
        this.dispatchEvent(ev);
      }`,
      awaitPromise: false,
    });
  } finally {
    await send(state.wc, 'Runtime.releaseObject', { objectId }).catch(() => {});
  }
  return { ok: true };
}

export async function fill(label: string, id: string, value: string): Promise<{ ok: true }> {
  const state = getState(label);
  const objectId = await resolveBackendObjectId(state, id);
  try {
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
      arguments: [{ value }],
      awaitPromise: false,
    });
  } finally {
    await send(state.wc, 'Runtime.releaseObject', { objectId }).catch(() => {});
  }
  return { ok: true };
}

export async function scroll(
  label: string,
  opts: { id?: string; x?: number; y?: number },
): Promise<{ ok: true }> {
  const state = getState(label);
  if (opts.id) {
    const objectId = await resolveBackendObjectId(state, opts.id);
    try {
      await send(state.wc, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() { this.scrollIntoView({ behavior: 'instant', block: 'center' }); }`,
        awaitPromise: false,
      });
    } finally {
      await send(state.wc, 'Runtime.releaseObject', { objectId }).catch(() => {});
    }
    return { ok: true };
  }
  const x = Number.isFinite(opts.x) ? Number(opts.x) : 0;
  const y = Number.isFinite(opts.y) ? Number(opts.y) : 0;
  await send(state.wc, 'Runtime.evaluate', {
    expression: `window.scrollTo(${x}, ${y})`,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// network
// ---------------------------------------------------------------------------

export function network(label: string, opts: { tail?: number } = {}): { entries: NetEntry[] } {
  const state = getState(label);
  const tail = Math.max(1, Math.min(NET_BUFFER, opts.tail ?? 50));
  const entries = state.network.slice(-tail);
  return { entries };
}
