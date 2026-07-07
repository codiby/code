/**
 * LSP process manager and stdio transport.
 *
 * Spawns language server processes per (sessionId, languageId) and relays
 * JSON-RPC messages between WebSocket clients and the language server's stdio.
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { log, logError } from '../lib/logger';
import { sessions } from '../session/sessions';

// ---------------------------------------------------------------------------
// Language server registry
// ---------------------------------------------------------------------------

const LSP_SERVERS: Record<string, { command: string; args: string[] }> = {
  typescript: { command: 'typescript-language-server', args: ['--stdio'] },
  javascript: { command: 'typescript-language-server', args: ['--stdio'] },
  typescriptreact: { command: 'typescript-language-server', args: ['--stdio'] },
  javascriptreact: { command: 'typescript-language-server', args: ['--stdio'] },
  // python: { command: 'pyright-langserver', args: ['--stdio'] },
  // rust: { command: 'rust-analyzer', args: [] },
  // go: { command: 'gopls', args: ['serve'] },
};

// ---------------------------------------------------------------------------
// LSP process state
// ---------------------------------------------------------------------------

interface LspProcess {
  proc: ChildProcess;
  sessionId: string;
  languageId: string;
  rootUri: string;
  clients: Set<any>; // WebSocket connections
  initialized: boolean;
}

const lspProcesses = new Map<string, LspProcess>();

function lspKey(sessionId: string, languageId: string): string {
  // Normalize react variants to base language for shared server
  const lang = languageId.replace('react', '');
  return `${sessionId}:${lang}`;
}

// ---------------------------------------------------------------------------
// stdio framing (Content-Length protocol)
// ---------------------------------------------------------------------------

/** Write a JSON-RPC message to a process's stdin with Content-Length framing */
function writeLspMessage(proc: ChildProcess, json: object) {
  const body = JSON.stringify(json);
  const header = `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n`;
  proc.stdin?.write(header + body);
}

/**
 * Attach a streaming parser to a readable stream that emits complete
 * JSON-RPC messages (Content-Length framed).
 */
function createLspReader(stream: NodeJS.ReadableStream, onMessage: (json: any) => void) {
  let buffer = Buffer.alloc(0);
  let contentLength = -1;

  stream.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      if (contentLength === -1) {
        // Look for header boundary
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const header = buffer.subarray(0, headerEnd).toString('utf-8');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // Malformed — skip this header
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        contentLength = parseInt(match[1]!, 10);
        buffer = buffer.subarray(headerEnd + 4);
      }

      if (buffer.length < contentLength) break;

      const body = buffer.subarray(0, contentLength).toString('utf-8');
      buffer = buffer.subarray(contentLength);
      contentLength = -1;

      try {
        onMessage(JSON.parse(body));
      } catch (e) {
        logError('LSP', `Failed to parse LSP message: ${e}`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

export function getOrCreateLsp(sessionId: string, languageId: string): LspProcess | null {
  const key = lspKey(sessionId, languageId);
  const existing = lspProcesses.get(key);
  if (existing && existing.proc.exitCode === null) return existing;

  // Clean up dead process
  if (existing) lspProcesses.delete(key);

  const serverDef = LSP_SERVERS[languageId];
  if (!serverDef) {
    log(`[LSP] No language server registered for ${languageId}`);
    return null;
  }

  const session = sessions.get(sessionId);
  if (!session) return null;

  const rootUri = `file://${session.cwd}`;
  log(`[LSP] Spawning ${serverDef.command} for session=${sessionId.slice(0, 8)} lang=${languageId} root=${session.cwd}`);

  const proc = spawn(serverDef.command, serverDef.args, {
    cwd: session.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '' },
  });

  const lsp: LspProcess = {
    proc,
    sessionId,
    languageId,
    rootUri,
    clients: new Set(),
    initialized: false,
  };

  // Read stdout → broadcast to all connected WS clients
  if (proc.stdout) {
    createLspReader(proc.stdout, (msg) => {
      const method = msg.method || (msg.id !== undefined ? `response:${msg.id}` : 'unknown');
      log(`[LSP ←] ${method}${msg.method === 'textDocument/publishDiagnostics' ? ` (${msg.params?.diagnostics?.length || 0} diagnostics)` : ''}`);
      const text = JSON.stringify(msg);
      for (const ws of lsp.clients) {
        try { ws.send(text); } catch {}
      }
    });
  }

  // Log stderr
  proc.stderr?.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const line of lines) log(`[LSP stderr] ${line}`);
  });

  proc.on('exit', (code) => {
    log(`[LSP] Process exited code=${code} session=${sessionId.slice(0, 8)} lang=${languageId}`);
    lspProcesses.delete(key);
    // Notify clients
    for (const ws of lsp.clients) {
      try { ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'window/logMessage', params: { type: 1, message: `Language server exited (code ${code})` } })); } catch {}
    }
  });

  proc.on('error', (err) => {
    logError('LSP', `Failed to spawn ${serverDef.command}: ${err.message}`);
    lspProcesses.delete(key);
  });

  lspProcesses.set(key, lsp);
  return lsp;
}

/** Forward a JSON-RPC message from the client to the LSP process stdin */
export function sendToLsp(lsp: LspProcess, message: any) {
  const method = message.method || 'response';
  log(`[LSP →] ${method}${message.id ? ` id=${message.id}` : ''}`);
  writeLspMessage(lsp.proc, message);
}

/** Register a WebSocket client with an LSP process */
export function addLspClient(lsp: LspProcess, ws: any) {
  lsp.clients.add(ws);
}

/** Unregister a WebSocket client; shut down LSP if no clients remain */
export function removeLspClient(lsp: LspProcess, ws: any) {
  lsp.clients.delete(ws);
  if (lsp.clients.size === 0) {
    shutdownLsp(lsp);
  }
}

/** Gracefully shutdown an LSP process */
function shutdownLsp(lsp: LspProcess) {
  const key = lspKey(lsp.sessionId, lsp.languageId);
  log(`[LSP] Shutting down session=${lsp.sessionId.slice(0, 8)} lang=${lsp.languageId}`);

  // Send shutdown request, then exit notification
  try {
    writeLspMessage(lsp.proc, { jsonrpc: '2.0', id: 'shutdown', method: 'shutdown', params: null });
    setTimeout(() => {
      try {
        writeLspMessage(lsp.proc, { jsonrpc: '2.0', method: 'exit' });
      } catch {}
      // Force kill after grace period
      setTimeout(() => {
        try { lsp.proc.kill('SIGTERM'); } catch {}
      }, 2000);
    }, 1000);
  } catch {
    try { lsp.proc.kill('SIGTERM'); } catch {}
  }

  lspProcesses.delete(key);
}

/** Kill all LSP processes for a given session */
export function killSessionLsp(sessionId: string) {
  for (const [key, lsp] of lspProcesses) {
    if (lsp.sessionId === sessionId) {
      try { lsp.proc.kill('SIGTERM'); } catch {}
      lspProcesses.delete(key);
    }
  }
}

/** List supported language IDs */
export function supportedLanguages(): string[] {
  return Object.keys(LSP_SERVERS);
}
