/** Codex 0.153.4 app-server JSONL transport. Keeps the return channel open for approvals. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, delimiter } from 'node:path';

export type CodexModel = { id: string; model: string; displayName: string; hidden?: boolean; isDefault: boolean; supportedReasoningEfforts: { reasoningEffort: string; description: string }[] };
export type CodexHandlers = {
  notification(method: string, params: any): void;
  request(method: string, params: any): Promise<unknown>;
  exit(error: Error): void;
};
export interface CodexConnection {
  ready: Promise<void>;
  request<T = any>(method: string, params: object): Promise<T>;
  close(): Promise<void>;
}
export type CodexConnect = (handlers: CodexHandlers) => CodexConnection;

export function codexRuntime(): { executable: string; env: NodeJS.ProcessEnv } {
  const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
  let nativeRoot = join(import.meta.dir, 'codex-runtime');
  if (process.env.CODEX_BIN) return { executable: process.env.CODEX_BIN, env: process.env };
  if (!existsSync(join(nativeRoot, 'bin', binary))) {
    // Development: resolve the SDK's pinned optional native package. Packaged
    // servers never enter this branch because they ship the whole runtime.
    try {
      const sdkRequire = createRequire(import.meta.resolve('@openai/codex-sdk'));
      const cliRequire = createRequire(sdkRequire.resolve('@openai/codex/package.json'));
      const pkg = cliRequire.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
      const targets: Record<string, string> = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'linux-arm64': 'aarch64-unknown-linux-musl', 'linux-x64': 'x86_64-unknown-linux-musl', 'win32-arm64': 'aarch64-pc-windows-msvc', 'win32-x64': 'x86_64-pc-windows-msvc' };
      nativeRoot = join(dirname(pkg), 'vendor', targets[`${process.platform}-${process.arch}`]!);
    } catch {
      const executable = Bun.which('codex');
      if (executable) return { executable, env: process.env };
      throw new Error('Codex runtime is missing. Reinstall Codiby Code or install the Codex CLI.');
    }
  }
  return { executable: join(nativeRoot, 'bin', binary), env: { ...process.env, PATH: `${join(nativeRoot, 'codex-path')}${delimiter}${process.env.PATH || ''}` } };
}

export class CodexAppServer implements CodexConnection {
  readonly ready: Promise<void>;
  private child: ChildProcessWithoutNullStreams;
  private closed = false;
  private sequence = 0;
  private stderr = '';
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private handlers: CodexHandlers) {
    const runtime = codexRuntime();
    this.child = spawn(runtime.executable, ['app-server', '--listen', 'stdio://'], { env: runtime.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data.toString()).slice(-8000); });
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Codex app-server exited (${signal || code}). ${this.stderr.trim()}`)));
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      try { this.receive(JSON.parse(line)); }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    this.ready = this.request('initialize', { clientInfo: { name: 'codiby_code', title: 'Codiby Code', version: '0.29.0' }, capabilities: { experimentalApi: true } })
      .then(() => { this.write({ method: 'initialized', params: {} }); });
    // A caller may attach after spawn; process errors must never become
    // unhandled rejections while the lifecycle is wiring the session.
    void this.ready.catch(() => {});
  }

  request<T = any>(method: string, params: object): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Codex connection is closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex did not respond to ${method} within 30 seconds`);
        reject(error);
        this.fail(error);
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  private write(message: object) {
    if (!this.closed) this.child.stdin.write(JSON.stringify(message) + '\n', error => { if (error) this.fail(error); });
  }

  private receive(message: any) {
    if (this.closed) return;
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        // Do not block stdout while a person is considering an approval.
        void this.handlers.request(message.method, message.params || {}).then(
          result => this.write({ id: message.id, result }),
          error => this.write({ id: message.id, error: { code: -32601, message: String(error) } }),
        );
      } else this.handlers.notification(message.method, message.params || {});
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else pending.resolve(message.result);
  }

  private fail(error: Error) {
    if (this.closed) return;
    void this.close();
    this.handlers.exit(error);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Codex connection closed')); }
    this.pending.clear();
    this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 1500);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

export async function listCodexModels(connection: CodexConnection): Promise<CodexModel[]> {
  await connection.ready;
  const models: CodexModel[] = [];
  let cursor: string | null = null;
  do {
    const result: { data: CodexModel[]; nextCursor: string | null } = await connection.request('model/list', { limit: 100, includeHidden: false, cursor });
    models.push(...result.data.filter(model => !model.hidden));
    cursor = result.nextCursor;
  } while (cursor);
  return models;
}
