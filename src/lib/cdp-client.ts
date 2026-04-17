/**
 * Chrome DevTools Protocol client.
 *
 * Connects to the bridge server's CDP proxy WebSocket and provides
 * typed methods for debugger operations.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DebugTarget {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl: string;
}

export interface CallFrame {
  callFrameId: string;
  functionName: string;
  location: { scriptId: string; lineNumber: number; columnNumber: number };
  url: string;
  scopeChain: Scope[];
}

export interface Scope {
  type: string; // 'global' | 'local' | 'closure' | 'with' | 'catch' | 'block' | 'script' | 'eval' | 'module'
  object: RemoteObject;
  name?: string;
  startLocation?: { lineNumber: number; columnNumber: number };
  endLocation?: { lineNumber: number; columnNumber: number };
}

export interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: any;
  description?: string;
  objectId?: string;
  preview?: ObjectPreview;
}

export interface ObjectPreview {
  type: string;
  subtype?: string;
  description?: string;
  overflow: boolean;
  properties: PropertyPreview[];
}

export interface PropertyPreview {
  name: string;
  type: string;
  value?: string;
  subtype?: string;
}

export interface PropertyDescriptor {
  name: string;
  value?: RemoteObject;
  writable?: boolean;
  get?: RemoteObject;
  set?: RemoteObject;
  configurable?: boolean;
  enumerable?: boolean;
  isOwn?: boolean;
}

export interface ScriptInfo {
  scriptId: string;
  url: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  sourceMapURL?: string;
}

export interface BreakpointInfo {
  breakpointId: string;
  locations: { scriptId: string; lineNumber: number; columnNumber: number }[];
}

// ---------------------------------------------------------------------------
// CDP Client
// ---------------------------------------------------------------------------

export class CdpClient {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private scripts = new Map<string, ScriptInfo>(); // scriptId → info
  private scriptsByUrl = new Map<string, ScriptInfo>(); // url → info
  private _callFrames: CallFrame[] = [];
  private _paused = false;

  // Event callbacks
  onPaused: ((callFrames: CallFrame[], reason: string, data?: any) => void) | null = null;
  onResumed: (() => void) | null = null;
  onScriptParsed: ((script: ScriptInfo) => void) | null = null;
  onDisconnected: (() => void) | null = null;

  get paused() { return this._paused; }
  get callFrames() { return this._callFrames; }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  async connect(serverUrl: string, connectionId: string): Promise<void> {
    const wsUrl = serverUrl.replace(/^http/, 'ws') + `/debug/ws/${encodeURIComponent(connectionId)}`;
    this.ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => resolve();
      this.ws!.onerror = () => reject(new Error('CDP WebSocket failed'));
    });

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch {}
    };

    this.ws.onclose = () => {
      this._paused = false;
      this._callFrames = [];
      this.onDisconnected?.();
    };

    // Enable debugger and runtime domains
    await this.send('Debugger.enable', {});
    await this.send('Runtime.enable', {});
  }

  disconnect() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this._paused = false;
    this._callFrames = [];
    this.scripts.clear();
    this.scriptsByUrl.clear();
    this.pending.clear();
  }

  // -------------------------------------------------------------------------
  // CDP protocol methods
  // -------------------------------------------------------------------------

  async setBreakpointByUrl(url: string, lineNumber: number, columnNumber?: number): Promise<BreakpointInfo> {
    const params: any = { url, lineNumber };
    if (columnNumber !== undefined) params.columnNumber = columnNumber;
    return this.send('Debugger.setBreakpointByUrl', params);
  }

  async removeBreakpoint(breakpointId: string): Promise<void> {
    await this.send('Debugger.removeBreakpoint', { breakpointId });
  }

  async resume(): Promise<void> {
    await this.send('Debugger.resume', {});
  }

  async pause(): Promise<void> {
    await this.send('Debugger.pause', {});
  }

  async stepOver(): Promise<void> {
    await this.send('Debugger.stepOver', {});
  }

  async stepInto(): Promise<void> {
    await this.send('Debugger.stepInto', {});
  }

  async stepOut(): Promise<void> {
    await this.send('Debugger.stepOut', {});
  }

  async getProperties(objectId: string, ownProperties = true): Promise<PropertyDescriptor[]> {
    const result = await this.send('Runtime.getProperties', { objectId, ownProperties });
    return result.result || [];
  }

  async evaluateOnCallFrame(callFrameId: string, expression: string): Promise<RemoteObject> {
    const result = await this.send('Debugger.evaluateOnCallFrame', {
      callFrameId,
      expression,
      generatePreview: true,
    });
    return result.result;
  }

  getScriptByUrl(url: string): ScriptInfo | undefined {
    return this.scriptsByUrl.get(url);
  }

  getScriptById(scriptId: string): ScriptInfo | undefined {
    return this.scripts.get(scriptId);
  }

  /** Convert a file:// URI or absolute path to the URL the debugger uses */
  fileToDebugUrl(filePath: string): string {
    if (filePath.startsWith('file://')) return filePath;
    return `file://${filePath}`;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private send(method: string, params: any): Promise<any> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ id, method, params }));
      } else {
        reject(new Error('CDP WebSocket not open'));
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }
      }, 30000);
    });
  }

  private handleMessage(msg: any) {
    // Response
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(msg.error);
        else p.resolve(msg.result || {});
      }
      return;
    }

    // Events
    switch (msg.method) {
      case 'Debugger.paused': {
        this._paused = true;
        this._callFrames = msg.params.callFrames || [];
        this.onPaused?.(this._callFrames, msg.params.reason, msg.params.data);
        break;
      }
      case 'Debugger.resumed': {
        this._paused = false;
        this._callFrames = [];
        this.onResumed?.();
        break;
      }
      case 'Debugger.scriptParsed': {
        const info: ScriptInfo = {
          scriptId: msg.params.scriptId,
          url: msg.params.url,
          startLine: msg.params.startLine,
          startColumn: msg.params.startColumn,
          endLine: msg.params.endLine,
          endColumn: msg.params.endColumn,
          sourceMapURL: msg.params.sourceMapURL,
        };
        this.scripts.set(info.scriptId, info);
        if (info.url) this.scriptsByUrl.set(info.url, info);
        this.onScriptParsed?.(info);
        break;
      }
      case '_cdp.disconnected': {
        this._paused = false;
        this._callFrames = [];
        this.onDisconnected?.();
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

export async function fetchDebugTargets(serverUrl: string, host = '127.0.0.1', port = 9229): Promise<DebugTarget[]> {
  const resp = await fetch(`${serverUrl}/debug/targets?host=${encodeURIComponent(host)}&port=${port}`);
  if (!resp.ok) return [];
  return resp.json();
}

export async function requestDebugConnect(serverUrl: string, host: string, port: number, targetId?: string): Promise<{ connectionId: string } | null> {
  const resp = await fetch(`${serverUrl}/debug/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host, port, targetId }),
  });
  if (!resp.ok) return null;
  return resp.json();
}

export async function requestDebugDisconnect(serverUrl: string, connectionId: string): Promise<void> {
  await fetch(`${serverUrl}/debug/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectionId }),
  }).catch(() => {});
}
