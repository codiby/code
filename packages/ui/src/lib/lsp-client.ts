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
  onDocumentChange?: (path: string, content: string) => void;
  loadModel?: (uri: string, forEdit: boolean) => Promise<import('monaco-editor').editor.ITextModel | null>;
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
  private capabilities: Record<string, any> = {};
  private loadModel: LspClientOptions['loadModel'];
  private disposed = false;
  private syncedModels = new Set<import('monaco-editor').editor.ITextModel>();
  private onDocumentChange: LspClientOptions['onDocumentChange'];

  constructor(opts: LspClientOptions) {
    this.serverUrl = opts.serverUrl;
    this.sessionId = opts.sessionId;
    this.languageId = opts.languageId;
    this.rootUri = opts.rootUri;
    this.monaco = opts.monaco;
    this.loadModel = opts.loadModel;
    this.onDocumentChange = opts.onDocumentChange;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private starting?: Promise<void>;

  start(): Promise<void> {
    return this.starting ??= this.connect();
  }

  private async connect(): Promise<void> {
    const wsUrl = this.serverUrl.replace(/^http/, 'ws') + `/lsp/ws/${this.sessionId}/${this.languageId}`;
    this.ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => {
        this.connected = true;
        resolve();
      };
      this.ws!.onerror = () => reject(new Error('LSP WebSocket failed'));
      this.ws!.onclose = () => { this.connected = false; reject(new Error('LSP WebSocket closed before initialization')); };
    });

    if (this.disposed || !this.ws) throw new Error('LSP disposed');
    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch {}
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.initialized = false;
      for (const pending of this.pendingRequests.values()) pending.reject(new Error('LSP disconnected'));
      this.pendingRequests.clear();
    };

    // Send initialize
    const initResult = await this.request('initialize', {
      processId: null,
      rootUri: this.rootUri,
      // Syntax-only answers during project startup cannot resolve imported symbols.
      initializationOptions: { tsserver: { useSyntaxServer: 'never' } },
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
          definition: { linkSupport: true },
          declaration: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          implementation: { linkSupport: true },
          references: {},
          rename: { prepareSupport: true },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          documentHighlight: {},
          formatting: {},
          publishDiagnostics: { relatedInformation: true },
          signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'] } },
        },
      },
    });

    if (this.disposed) return;
    this.capabilities = initResult?.capabilities || {};
    // Send initialized notification
    this.notify('initialized', {});
    this.initialized = true;

    // Register Monaco providers
    this.registerProviders();
  }

  dispose() {
    this.disposed = true;
    this.initialized = false;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    // Close open documents
    for (const [uri] of this.openDocVersions) {
      this.notify('textDocument/didClose', { textDocument: { uri } });
    }
    this.openDocVersions.clear();
    this.syncedModels.clear();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    for (const pending of this.pendingRequests.values()) pending.reject(new Error('LSP disposed'));
    this.pendingRequests.clear();
  }

  // -------------------------------------------------------------------------
  // JSON-RPC transport
  // -------------------------------------------------------------------------

  private request(method: string, params: any): Promise<any> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`LSP request ${method} timed out`));
        }
      }, 30000);
      this.pendingRequests.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
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

    // Language servers may request configuration during project loading.
    if ('id' in msg && msg.method) {
      if (msg.method === 'workspace/configuration') {
        this.send({ jsonrpc: '2.0', id: msg.id, result: (msg.params?.items || []).map(() => null) });
      } else {
        this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not supported' } });
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

  syncModel(model: import('monaco-editor').editor.ITextModel) {
    if (this.disposed || this.syncedModels.has(model)) return;
    this.syncedModels.add(model);
    const path = model.uri.fsPath;
    const language = model.getLanguageId();
    const extension = path.split('.').pop();
    if (this.openDocVersions.has(model.uri.toString())) this.changeDocument(path, model.getValue());
    else this.openDocument(path, model.getValue(), extension === 'tsx' ? 'typescriptreact' : extension === 'jsx' ? 'javascriptreact' : language);
    this.disposables.push(model.onDidChangeContent(() => {
      this.changeDocument(path, model.getValue());
      this.onDocumentChange?.(path, model.getValue());
    }), model.onWillDispose(() => {
      // Tab switches unmount Monaco but retain unsaved buffers. Keep the server
      // document alive until the tab closes or the session client is disposed.
      this.syncedModels.delete(model);
    }));
  }

  /** Notify the LSP server that a document was opened */
  openDocument(path: string, content: string, languageId?: string) {
    const uri = this.monaco.Uri.file(path).toString();
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
    const uri = this.monaco.Uri.file(path).toString();
    if (!this.openDocVersions.has(uri)) return;
    const version = this.openDocVersions.get(uri)! + 1;
    this.openDocVersions.set(uri, version);
    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text: content }],
    });
  }

  /** Notify the LSP server that a document was closed */
  closeDocument(path: string) {
    const uri = this.monaco.Uri.file(path).toString();
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
          if (!this.initialized || !this.openDocVersions.has(model.uri.toString())) return { suggestions: [] };
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
          if (!this.initialized || !this.openDocVersions.has(model.uri.toString())) return null;
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

    // All navigation providers share Location / LocationLink conversion.
    const locations = async (method: string, model: any, position: any, extra = {}) => {
      if (!this.initialized || !this.openDocVersions.has(model.uri.toString())) return [];
      const result = await this.request(method, {
        textDocument: { uri: model.uri.toString() },
        position: monacoToLspPosition(position), ...extra,
      });
      const links = (Array.isArray(result) ? result : result ? [result] : []).map((loc: any) => ({
        uri: monaco.Uri.parse(loc.uri || loc.targetUri),
        range: lspToMonacoRange(loc.range || loc.targetRange),
        targetSelectionRange: loc.targetSelectionRange ? lspToMonacoRange(loc.targetSelectionRange) : undefined,
        originSelectionRange: loc.originSelectionRange ? lspToMonacoRange(loc.originSelectionRange) : undefined,
      }));
      // Monaco's peek widgets resolve only models already in memory.
      await Promise.all([...new Set<string>(links.map((loc: any) => loc.uri.toString()))]
        .map(uri => this.loadModel?.(uri, false)));
      return links;
    };
    const navigation = [
      ['definition', 'registerDefinitionProvider', 'provideDefinition'],
      ['declaration', 'registerDeclarationProvider', 'provideDeclaration'],
      ['typeDefinition', 'registerTypeDefinitionProvider', 'provideTypeDefinition'],
      ['implementation', 'registerImplementationProvider', 'provideImplementation'],
    ] as const;
    for (const [method, register, provide] of navigation) {
      const requestMethod = method === 'declaration' && !this.capabilities.declarationProvider ? 'definition' : method;
      if (!this.capabilities[`${requestMethod}Provider`]) continue;
      this.disposables.push(monaco.languages[register](langSelector, {
        [provide]: (model: any, position: any) => locations(`textDocument/${requestMethod}`, model, position),
      } as any));
    }
    if (this.capabilities.referencesProvider) this.disposables.push(
      monaco.languages.registerReferenceProvider(langSelector, {
        provideReferences: (model, position, context) => locations('textDocument/references', model, position, { context }),
      }),
    );
    if (this.capabilities.documentHighlightProvider) this.disposables.push(
      monaco.languages.registerDocumentHighlightProvider(langSelector, {
        provideDocumentHighlights: async (model, position) => {
          if (!this.openDocVersions.has(model.uri.toString())) return [];
          const result = await this.request('textDocument/documentHighlight', {
            textDocument: { uri: model.uri.toString() }, position: monacoToLspPosition(position),
          });
          return (result || []).map((h: any) => ({ range: lspToMonacoRange(h.range), kind: h.kind || 1 }));
        },
      }),
    );
    if (this.capabilities.documentSymbolProvider) this.disposables.push(
      monaco.languages.registerDocumentSymbolProvider(langSelector, {
        provideDocumentSymbols: async (model) => {
          if (!this.openDocVersions.has(model.uri.toString())) return [];
          const result = await this.request('textDocument/documentSymbol', { textDocument: { uri: model.uri.toString() } });
          const convert = (s: any): any => ({
            name: s.name, detail: s.detail || '', kind: s.kind - 1, tags: s.tags || [],
            range: lspToMonacoRange(s.range || s.location.range),
            selectionRange: lspToMonacoRange(s.selectionRange || s.range || s.location.range),
            children: s.children?.map(convert),
          });
          return (result || []).map(convert);
        },
      }),
    );
    if (this.capabilities.documentFormattingProvider) this.disposables.push(
      monaco.languages.registerDocumentFormattingEditProvider(langSelector, {
        provideDocumentFormattingEdits: async (model, options) => {
          if (!this.openDocVersions.has(model.uri.toString())) return [];
          const result = await this.request('textDocument/formatting', { textDocument: { uri: model.uri.toString() }, options });
          return (result || []).map((e: any) => ({ range: lspToMonacoRange(e.range), text: e.newText }));
        },
      }),
    );
    if (this.capabilities.renameProvider && this.loadModel) this.disposables.push(
      monaco.languages.registerRenameProvider(langSelector, {
        resolveRenameLocation: async (model, position) => {
          const word = model.getWordAtPosition(position);
          const fallback = { range: new monaco.Range(position.lineNumber, word?.startColumn || position.column, position.lineNumber, word?.endColumn || position.column), text: word?.word || '' };
          if (!this.openDocVersions.has(model.uri.toString())) return { ...fallback, rejectReason: 'Document is not connected to the language server.' };
          if (!this.capabilities.renameProvider.prepareProvider) return fallback;
          try {
            const result = await this.request('textDocument/prepareRename', { textDocument: { uri: model.uri.toString() }, position: monacoToLspPosition(position) });
            if (!result) return { ...fallback, rejectReason: 'This symbol cannot be renamed.' };
            if (result.defaultBehavior) return fallback;
            const range = lspToMonacoRange(result.range || result);
            return { range, text: result.placeholder || model.getValueInRange(range) };
          } catch (error: any) { return { ...fallback, rejectReason: error.message || 'Could not prepare the rename.' }; }
        },
        provideRenameEdits: async (model, position, newName, token) => {
          if (!this.openDocVersions.has(model.uri.toString())) return { edits: [], rejectReason: 'Document is not connected.' };
          try {
            const result = await this.request('textDocument/rename', { textDocument: { uri: model.uri.toString() }, position: monacoToLspPosition(position), newName });
            const changes = result?.documentChanges || Object.entries(result?.changes || {}).map(([uri, edits]) => ({ textDocument: { uri }, edits }));
            if (changes.some((c: any) => !c.textDocument || c.kind)) throw new Error('The rename needs file operations that are not supported.');
            const edits = [];
            for (const change of changes) {
              if (token.isCancellationRequested) return { edits: [] };
              const version = change.textDocument.version;
              if (version != null && version !== this.openDocVersions.get(change.textDocument.uri)) throw new Error('The document changed; try the rename again.');
              const target = await this.loadModel!(change.textDocument.uri, true);
              if (!target) throw new Error('Could not load a file affected by the rename.');
              for (const edit of change.edits) edits.push({ resource: target.uri, versionId: target.getVersionId(), textEdit: { range: lspToMonacoRange(edit.range), text: edit.newText } });
            }
            return token.isCancellationRequested ? { edits: [] } : { edits };
          } catch (error: any) { return { edits: [], rejectReason: error.message || 'Could not rename the symbol.' }; }
        },
      }),
    );

    // Signature Help
    this.disposables.push(
      monaco.languages.registerSignatureHelpProvider(langSelector, {
        signatureHelpTriggerCharacters: ['(', ','],
        provideSignatureHelp: async (model, position) => {
          if (!this.initialized || !this.openDocVersions.has(model.uri.toString())) return null;
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
      typescript: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
      javascript: ['javascript', 'javascriptreact'],
    };
    return map[this.languageId] || [this.languageId];
  }
}
