import { afterEach, describe, expect, test } from 'bun:test';
// Monaco's URI codec keeps tests faithful to the editor's file identities.
// @ts-expect-error Monaco ships this runtime module without declarations.
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js';
import { LspClient } from './lsp-client';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const range = { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } };
const capabilities = { definitionProvider: true, declarationProvider: true, typeDefinitionProvider: true, implementationProvider: true,
  referencesProvider: true, renameProvider: { prepareProvider: true }, documentSymbolProvider: true, documentHighlightProvider: true, documentFormattingProvider: true };
const originalWebSocket = globalThis.WebSocket;
const clients: LspClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); globalThis.WebSocket = originalWebSocket; });

function fixture(serverCapabilities = capabilities) {
  const messages: any[] = [];
  const providers: Record<string, any> = {};
  const responses: Record<string, any> = { initialize: { capabilities: serverCapabilities } };
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    constructor() { queueMicrotask(() => this.onopen?.()); }
    send(data: string) {
      const message = JSON.parse(data); messages.push(message);
      if (message.id && message.method) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: responses[message.method] ?? null }) }));
    }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = Socket as any;
  const models = new Map<string, any>();
  const model = (path: string, content = 'export const greet = 1;') => {
    const changes: (() => void)[] = [];
    const closing: (() => void)[] = [];
    const value = { uri: URI.file(path), getValue: () => content, getLanguageId: () => path.endsWith('.js') ? 'javascript' : 'typescript', getVersionId: () => 1,
      getWordAtPosition: () => ({ word: 'greet', startColumn: 5, endColumn: 10 }), getValueInRange: () => 'greet',
      onDidChangeContent: (f: () => void) => { changes.push(f); return { dispose() { changes.splice(changes.indexOf(f), 1); } }; },
      onWillDispose: (f: () => void) => { closing.push(f); return { dispose() {} }; },
      change(text: string) { content = text; changes.forEach(f => f()); }, dispose() { closing.forEach(f => f()); },
    };
    models.set(value.uri.toString(), value); return value;
  };
  const loaded: [string, boolean][] = [];
  const changed: [string, string][] = [];
  const monaco: any = { Uri: URI, Range: class { constructor(public startLineNumber: number, public startColumn: number, public endLineNumber: number, public endColumn: number) {} },
    languages: new Proxy({}, { get: (_, name: string) => (selector: string[], provider: any) => {
      providers[name] = { ...provider, selector }; return { dispose() { delete providers[name]; } };
    } }),
  };
  const client = new LspClient({ serverUrl: 'http://localhost', sessionId: 'test', languageId: 'typescript', rootUri: URI.file('/project').toString(), monaco,
    loadModel: async (uri, edit) => { loaded.push([uri, edit]); if (edit && URI.parse(uri).path.includes('node_modules')) throw new Error('Read-only'); return models.get(uri) || model(URI.parse(uri).fsPath); },
    onDocumentChange: (path, content) => changed.push([path, content]),
  }); clients.push(client);
  return { client, model, providers, responses, messages, loaded, changed, monaco };
}
const position = { lineNumber: 3, column: 5 };
const token = { isCancellationRequested: false };

describe('LSP symbol support', () => {
  test('starts only once and synchronizes encoded file URIs and unsaved JSX content', async () => {
    const f = fixture(); await Promise.all([f.client.start(), f.client.start()]);
    const model = f.model('/project/a #b.tsx', 'unsaved'); f.client.syncModel(model as any); f.client.syncModel(model as any);
    model.change('new text');
    expect(f.messages.filter(m => m.method === 'initialize')).toHaveLength(1);
    expect(f.messages.filter(m => m.method === 'textDocument/didOpen')).toHaveLength(1);
    expect(f.messages.find(m => m.method === 'textDocument/didOpen').params.textDocument).toMatchObject({ uri: model.uri.toString(), text: 'unsaved', languageId: 'typescriptreact' });
    expect(f.messages.find(m => m.method === 'textDocument/didChange').params.contentChanges).toEqual([{ text: 'new text' }]);
    expect(f.changed).toEqual([['/project/a #b.tsx', 'new text']]);
    expect(f.providers.registerDefinitionProvider.selector).toContain('javascript');
  });
  test('keeps unsaved documents synchronized across editor unmounts and closes explicitly', async () => {
    const f = fixture(); await f.client.start();
    const first = f.model('/project/main.ts', 'unsaved'); f.client.syncModel(first as any);
    first.dispose();
    expect(f.messages.filter(m => m.method === 'textDocument/didClose')).toHaveLength(0);
    const remounted = f.model('/project/main.ts', 'still unsaved'); f.client.syncModel(remounted as any);
    expect(f.messages.filter(m => m.method === 'textDocument/didOpen')).toHaveLength(1);
    expect(f.messages.at(-1).params.contentChanges).toEqual([{ text: 'still unsaved' }]);
    f.client.closeDocument('/project/main.ts');
    expect(f.messages.at(-1).method).toBe('textDocument/didClose');
  });
  test('retains target selection and origin ranges and preloads peek models', async () => {
    const f = fixture(); await f.client.start(); const source = f.model('/project/main.ts'); f.client.syncModel(source as any);
    const uri = URI.file('/project/other file.ts').toString();
    f.responses['textDocument/definition'] = [{ targetUri: uri, targetRange: range, targetSelectionRange: { start: { line: 3, character: 1 }, end: { line: 3, character: 4 } }, originSelectionRange: range }];
    const result = await f.providers.registerDefinitionProvider.provideDefinition(source, position);
    expect(result[0].targetSelectionRange.startLineNumber).toBe(4);
    expect(result[0].originSelectionRange.startColumn).toBe(5);
    expect(f.loaded).toEqual([[uri, false]]);
  });
  test('passes reference context and ignores models owned by another client', async () => {
    const f = fixture(); await f.client.start(); const source = f.model('/project/main.js');
    expect(await f.providers.registerReferenceProvider.provideReferences(source, position, { includeDeclaration: true })).toEqual([]);
    f.client.syncModel(source as any);
    await f.providers.registerReferenceProvider.provideReferences(source, position, { includeDeclaration: false });
    expect(f.messages.at(-1).params.context).toEqual({ includeDeclaration: false });
  });
  test('loads all rename targets and returns versioned edits without writing disk', async () => {
    const f = fixture(); await f.client.start(); const source = f.model('/project/main.ts'); f.client.syncModel(source as any);
    const other = URI.file('/project/other.ts').toString();
    f.responses['textDocument/rename'] = { changes: { [source.uri.toString()]: [{ range, newText: 'renamed' }], [other]: [{ range, newText: 'renamed' }] } };
    const result = await f.providers.registerRenameProvider.provideRenameEdits(source, position, 'renamed', token);
    expect(result.edits).toHaveLength(2);
    expect(result.edits[1]).toMatchObject({ versionId: 1, textEdit: { text: 'renamed', range: { startLineNumber: 3, startColumn: 5 } } });
    expect(f.loaded.every(([, edit]) => edit)).toBe(true);
  });
  test('rejects read-only rename targets and file operations without partial edits', async () => {
    const f = fixture(); await f.client.start(); const source = f.model('/project/main.ts'); f.client.syncModel(source as any);
    f.responses['textDocument/rename'] = { changes: { [URI.file('/project/node_modules/lib.ts').toString()]: [{ range, newText: 'x' }] } };
    expect(await f.providers.registerRenameProvider.provideRenameEdits(source, position, 'x', token)).toEqual({ edits: [], rejectReason: 'Read-only' });
    f.responses['textDocument/rename'] = { documentChanges: [{ kind: 'rename', oldUri: 'file:///a', newUri: 'file:///b' }] };
    expect((await f.providers.registerRenameProvider.provideRenameEdits(source, position, 'x', token)).edits).toEqual([]);
  });
  test('registers only supported symbol capabilities and cleans up providers', async () => {
    const f = fixture({} as any); await f.client.start();
    expect(f.providers.registerReferenceProvider).toBeUndefined();
    expect(f.providers.registerRenameProvider).toBeUndefined();
    f.client.dispose(); expect(Object.keys(f.providers)).toHaveLength(0);
  });
  test('converts document symbols and formatting edits', async () => {
    const f = fixture(); await f.client.start(); const source = f.model('/project/main.ts'); f.client.syncModel(source as any);
    f.responses['textDocument/documentSymbol'] = [{ name: 'greet', kind: 12, range, selectionRange: range }];
    expect((await f.providers.registerDocumentSymbolProvider.provideDocumentSymbols(source))[0]).toMatchObject({ name: 'greet', kind: 11, selectionRange: { startLineNumber: 3 } });
    f.responses['textDocument/formatting'] = [{ range, newText: 'formatted' }];
    expect((await f.providers.registerDocumentFormattingEditProvider.provideDocumentFormattingEdits(source, { tabSize: 2, insertSpaces: true }))[0].text).toBe('formatted');
  });
});

// Exercise the complete protocol against the real server when installed locally.
test.skipIf(!Bun.which('typescript-language-server'))('real TypeScript server resolves cross-file definitions, references, symbols and rename', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codiby-symbols-')));
  const source = "import { greet } from './other';\nconsole.log(greet('world'));\n";
  const target = "export function greet(name: string) { return name; }\n";
  await Promise.all([
    writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'ESNext', moduleResolution: 'Bundler' }, include: ['*.ts'] })),
    writeFile(join(root, 'main.ts'), source), writeFile(join(root, 'other.ts'), target),
  ]);
  const process = spawn(Bun.which('typescript-language-server')!, ['--stdio'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let socket: any;
  let buffer = Buffer.alloc(0);
  process.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())?.[1]);
      if (buffer.length < headerEnd + 4 + length) break;
      socket?.send(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
      buffer = buffer.subarray(headerEnd + 4 + length);
    }
  });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response('Not found', { status: 404 }); },
    websocket: {
      open(ws) { socket = ws; },
      message(_ws, message) { const body = message.toString(); process.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); },
    },
  });
  const f = fixture(); globalThis.WebSocket = originalWebSocket;
  const client = new LspClient({ serverUrl: `http://127.0.0.1:${server.port}`, sessionId: 'test', languageId: 'typescript', rootUri: URI.file(root).toString(), monaco: f.monaco,
    loadModel: async uri => f.model(URI.parse(uri).fsPath, target) as any,
  }); clients.push(client);
  try {
    await client.start(); const model = f.model(join(root, 'main.ts'), source); client.syncModel(model as any);
    const pos = { lineNumber: 2, column: 14 };
    const definitions = await f.providers.registerDefinitionProvider.provideDefinition(model, pos);
    expect(definitions[0].uri.fsPath).toBe(join(root, 'other.ts'));
    const declarations = await f.providers.registerDeclarationProvider.provideDeclaration(model, pos);
    expect(declarations[0].uri.fsPath).toBe(join(root, 'other.ts'));
    const references = await f.providers.registerReferenceProvider.provideReferences(model, pos, { includeDeclaration: true });
    expect(references.length).toBeGreaterThanOrEqual(3);
    const declaration = f.model(join(root, 'other.ts'), target); client.syncModel(declaration as any);
    const symbols = await f.providers.registerDocumentSymbolProvider.provideDocumentSymbols(declaration);
    expect(symbols.some((symbol: any) => symbol.name === 'greet')).toBe(true);
    const rename = await f.providers.registerRenameProvider.provideRenameEdits(declaration, { lineNumber: 1, column: 18 }, 'welcome', token);
    expect(rename.rejectReason).toBeUndefined();
    expect(new Set(rename.edits.map((edit: any) => edit.resource.fsPath)).size).toBe(2);
    expect(rename.edits.every((edit: any) => edit.textEdit.text === 'welcome')).toBe(true);
  } finally {
    client.dispose(); server.stop(true); process.kill(); await rm(root, { recursive: true, force: true });
  }
}, 20000);
