/**
 * LSP client that bridges a WebSocket connection to a language server
 * with Monaco editor providers (completion, hover, diagnostics, definition).
 *
 * Uses the manual bridge approach — no heavy @codingame/monaco-vscode-api needed.
 */

import type { IDisposable, IRange } from 'monaco-editor';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Monaco = typeof import('monaco-editor');

interface LspClientOptions {
  serverUrl: string;
  sessionId: string;
  languageId: string;
  rootUri: string;
  monaco: Monaco;
}

// ---------------------------------------------------------------------------
// URI / position helpers
// ---------------------------------------------------------------------------

function monacoToLspPosition(pos: { lineNumber: number; column: number }) {
  return { line: pos.lineNumber - 1, character: pos.column - 1 };
}

function lspToMonacoRange(range: { start: { line: number; character: number }; end: { line: number; character: number } }): IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function fileUri(path: string): string {
  return `file://${path}`;
}

// LSP CompletionItemKind → Monaco CompletionItemKind mapping
function mapCompletionKind(kind: number | undefined, monaco: Monaco): number {
  const m = monaco.languages.CompletionItemKind;
  const map: Record<number, number> = {
    1: m.Text, 2: m.Method, 3: m.Function, 4: m.Constructor,
    5: m.Field, 6: m.Variable, 7: m.Class, 8: m.Interface,
    9: m.Module, 10: m.Property, 11: m.Unit, 12: m.Value,
    13: m.Enum, 14: m.Keyword, 15: m.Snippet, 16: m.Color,
    17: m.File, 18: m.Reference, 19: m.Folder, 20: m.EnumMember,
    21: m.Constant, 22: m.Struct, 23: m.Event, 24: m.Operator,
    25: m.TypeParameter,
  };
  return map[kind ?? 1] ?? m.Text;
}

// LSP DiagnosticSeverity → Monaco MarkerSeverity
function mapDiagnosticSeverity(sev: number | undefined, monaco: Monaco): number {
  switch (sev) {
    case 1: return monaco.MarkerSeverity.Error;
    case 2: return monaco.MarkerSeverity.Warning;
    case 3: return monaco.MarkerSeverity.Info;
    case 4: return monaco.MarkerSeverity.Hint;
    default: return monaco.MarkerSeverity.Info;
  }
}

// ---------------------------------------------------------------------------
// LspClient
// ---------------------------------------------------------------------------

export class LspClient {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number | string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private disposables: IDisposable[] = [];
  private monaco: Monaco;
  private openDocVersions = new Map<string, number>(); // uri → version
  private serverUrl: string;
  private sessionId: string;
  private languageId: string;
  private rootUri: string;
  private connected = false;
  private initialized = false;

  constructor(opts: LspClientOptions) {
    this.serverUrl = opts.serverUrl;
    this.sessionId = opts.sessionId;
    this.languageId = opts.languageId;
    this.rootUri = opts.rootUri;
    this.monaco = opts.monaco;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    const wsUrl = this.serverUrl.replace(/^http/, 'ws') + `/lsp/ws/${this.sessionId}/${this.languageId}`;
    this.ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => {
        this.connected = true;
        resolve();
      };
      this.ws!.onerror = () => reject(new Error('LSP WebSocket failed'));
      this.ws!.onclose = () => { this.connected = false; };
    });

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch {}
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.initialized = false;
    };

    // Send initialize
    const initResult = await this.request('initialize', {
      processId: null,
      rootUri: this.rootUri,
      capabilities: {
        textDocument: {
          completion: {
            completionItem: {
              snippetSupport: true,
              commitCharactersSupport: true,
              documentationFormat: ['markdown', 'plaintext'],
              resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
            },
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: {},
          publishDiagnostics: { relatedInformation: true },
          signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'] } },
        },
      },
    });

    // Send initialized notification
    this.notify('initialized', {});
    this.initialized = true;

    // Register Monaco providers
    this.registerProviders();
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    // Close open documents
    for (const [uri] of this.openDocVersions) {
      this.notify('textDocument/didClose', { textDocument: { uri } });
    }
    this.openDocVersions.clear();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.pendingRequests.clear();
  }

  // -------------------------------------------------------------------------
  // JSON-RPC transport
  // -------------------------------------------------------------------------

  private request(method: string, params: any): Promise<any> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
      // Timeout after 30s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`LSP request ${method} timed out`));
        }
      }, 30000);
    });
  }

  private notify(method: string, params: any) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(msg: any) {
    // Response to a request
    if ('id' in msg && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) pending.reject(msg.error);
        else pending.resolve(msg.result);
      }
      return;
    }

    // Server notification
    if (msg.method === 'textDocument/publishDiagnostics') {
      this.handleDiagnostics(msg.params);
    }
  }

  // -------------------------------------------------------------------------
  // Document sync
  // -------------------------------------------------------------------------

  /** Notify the LSP server that a document was opened */
  openDocument(path: string, content: string, languageId?: string) {
    const uri = fileUri(path);
    if (this.openDocVersions.has(uri)) return; // already open
    this.openDocVersions.set(uri, 1);
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: languageId || this.languageId,
        version: 1,
        text: content,
      },
    });
  }

  /** Notify the LSP server of a document change */
  changeDocument(path: string, content: string) {
    const uri = fileUri(path);
    const version = (this.openDocVersions.get(uri) || 0) + 1;
    this.openDocVersions.set(uri, version);
    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text: content }],
    });
  }

  /** Notify the LSP server that a document was closed */
  closeDocument(path: string) {
    const uri = fileUri(path);
    if (!this.openDocVersions.has(uri)) return;
    this.openDocVersions.delete(uri);
    this.notify('textDocument/didClose', {
      textDocument: { uri },
    });
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  private handleDiagnostics(params: { uri: string; diagnostics: any[] }) {
    const monaco = this.monaco;
    // Find the Monaco model for this URI
    const modelUri = monaco.Uri.parse(params.uri);
    const model = monaco.editor.getModel(modelUri);
    if (!model) return;

    const markers = params.diagnostics.map((d: any) => ({
      severity: mapDiagnosticSeverity(d.severity, monaco),
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      message: d.message,
      source: d.source || 'lsp',
      code: d.code?.toString(),
    }));

    monaco.editor.setModelMarkers(model, 'lsp', markers);
  }

  // -------------------------------------------------------------------------
  // Monaco providers
  // -------------------------------------------------------------------------

  private registerProviders() {
    const monaco = this.monaco;
    const langSelector = this.getLanguageSelector();

    // Completion
    this.disposables.push(
      monaco.languages.registerCompletionItemProvider(langSelector, {
        triggerCharacters: ['.', '/', '"', "'", '`', '<', '@', '#'],
        provideCompletionItems: async (model, position) => {
          if (!this.initialized) return { suggestions: [] };
          try {
            const result = await this.request('textDocument/completion', {
              textDocument: { uri: model.uri.toString() },
              position: monacoToLspPosition(position),
            });

            const items = Array.isArray(result) ? result : result?.items || [];
            const suggestions = items.map((item: any) => {
              const insertText = item.insertText || item.label;
              const isSnippet = item.insertTextFormat === 2;
              return {
                label: item.label,
                kind: mapCompletionKind(item.kind, monaco),
                insertText,
                insertTextRules: isSnippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
                detail: item.detail,
                documentation: item.documentation?.value || item.documentation,
                sortText: item.sortText,
                filterText: item.filterText,
                range: item.textEdit?.range ? lspToMonacoRange(item.textEdit.range) : undefined,
              };
            });
            return { suggestions };
          } catch {
            return { suggestions: [] };
          }
        },
      })
    );

    // Hover
    this.disposables.push(
      monaco.languages.registerHoverProvider(langSelector, {
        provideHover: async (model, position) => {
          if (!this.initialized) return null;
          try {
            const result = await this.request('textDocument/hover', {
              textDocument: { uri: model.uri.toString() },
              position: monacoToLspPosition(position),
            });
            if (!result) return null;

            const contents = Array.isArray(result.contents)
              ? result.contents.map((c: any) => ({ value: typeof c === 'string' ? c : c.value }))
              : [{ value: typeof result.contents === 'string' ? result.contents : result.contents?.value || '' }];

            return {
              range: result.range ? lspToMonacoRange(result.range) : undefined,
              contents,
            };
          } catch {
            return null;
          }
        },
      })
    );

    // Go to Definition
    this.disposables.push(
      monaco.languages.registerDefinitionProvider(langSelector, {
        provideDefinition: async (model, position) => {
          if (!this.initialized) return null;
          try {
            const result = await this.request('textDocument/definition', {
              textDocument: { uri: model.uri.toString() },
              position: monacoToLspPosition(position),
            });
            if (!result) return null;

            const locations = Array.isArray(result) ? result : [result];
            return locations.map((loc: any) => ({
              uri: monaco.Uri.parse(loc.uri || loc.targetUri),
              range: lspToMonacoRange(loc.range || loc.targetRange),
            }));
          } catch {
            return null;
          }
        },
      })
    );

    // Signature Help
    this.disposables.push(
      monaco.languages.registerSignatureHelpProvider(langSelector, {
        signatureHelpTriggerCharacters: ['(', ','],
        provideSignatureHelp: async (model, position) => {
          if (!this.initialized) return null;
          try {
            const result = await this.request('textDocument/signatureHelp', {
              textDocument: { uri: model.uri.toString() },
              position: monacoToLspPosition(position),
            });
            if (!result) return null;

            return {
              value: {
                signatures: result.signatures.map((sig: any) => ({
                  label: sig.label,
                  documentation: sig.documentation?.value || sig.documentation,
                  parameters: (sig.parameters || []).map((p: any) => ({
                    label: p.label,
                    documentation: p.documentation?.value || p.documentation,
                  })),
                })),
                activeSignature: result.activeSignature ?? 0,
                activeParameter: result.activeParameter ?? 0,
              },
              dispose: () => {},
            };
          } catch {
            return null;
          }
        },
      })
    );
  }

  private getLanguageSelector(): string | string[] {
    // Map language IDs to what Monaco uses
    const map: Record<string, string[]> = {
      typescript: ['typescript', 'typescriptreact'],
      javascript: ['javascript', 'javascriptreact'],
    };
    return map[this.languageId] || [this.languageId];
  }
}
