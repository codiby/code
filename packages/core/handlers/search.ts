import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { rgPath as bundledRgPath } from '@vscode/ripgrep';
import { corsHeaders } from '../config';

export type CaseMode = 'smart' | 'sensitive' | 'insensitive';

const EXCLUDE_DIRS = ['node_modules', '.git', 'dist', '.next', '.nuxt', '.output', '__pycache__', '.cache', 'coverage', '.turbo'];

let cachedRgPath: string | null | undefined;

function getRgPath(): string | null {
  if (cachedRgPath !== undefined) return cachedRgPath;
  // Packaged Electron: the shell passes the absolute path to the rg shipped
  // alongside `bun` and `server.js` in `process.resourcesPath`.
  const fromEnv = process.env.CODIBY_RG_PATH;
  if (fromEnv && existsSync(fromEnv)) {
    cachedRgPath = fromEnv;
    return cachedRgPath;
  }
  // Dev: `@vscode/ripgrep` exports a path into node_modules.
  if (bundledRgPath && existsSync(bundledRgPath)) {
    cachedRgPath = bundledRgPath;
    return cachedRgPath;
  }
  // Last resort: whatever the user has on PATH.
  try {
    const result = spawnSync('which', ['rg'], { encoding: 'utf-8', timeout: 2000 });
    cachedRgPath = result.status === 0 ? result.stdout.trim() || null : null;
  } catch {
    cachedRgPath = null;
  }
  return cachedRgPath;
}

function caseFlagRg(mode: CaseMode): string {
  if (mode === 'sensitive') return '--case-sensitive';
  if (mode === 'insensitive') return '--ignore-case';
  return '--smart-case';
}

async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function runWithTimeout(proc: ReturnType<typeof Bun.spawn>, ms: number): Promise<{ stdout: string; timedOut: boolean }> {
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch {}
  }, ms);
  const stdout = await readAll(proc.stdout as ReadableStream<Uint8Array> | null);
  await proc.exited;
  clearTimeout(killer);
  return { stdout, timedOut };
}

export async function handleSearch(
  root: string,
  query: string,
  caseMode: CaseMode = 'smart',
  ignoreGlobs: string[] = [],
): Promise<Response> {
  try {
    const rg = getRgPath();
    const MAX_RESULTS = 100;

    if (rg) {
      // --vimgrep gives us `file:line:col:text` — much cheaper to parse than --json.
      const args = [
        '--vimgrep',
        '--no-heading',
        '--color', 'never',
        '--max-count', '5',
        '--max-filesize', '1M',
        '--max-columns', '300',
        '--threads', '0',
        caseFlagRg(caseMode),
      ];
      for (const g of ignoreGlobs) {
        if (g) args.push('-g', `!${g}`);
      }
      args.push('-e', query, '.');
      const proc = Bun.spawn([rg, ...args], { cwd: root, stdout: 'pipe', stderr: 'ignore' });
      const { stdout } = await runWithTimeout(proc, 15000);

      const results: { file: string; line: number; text: string }[] = [];
      const lines = stdout.split('\n');
      for (let i = 0; i < lines.length && results.length < MAX_RESULTS; i++) {
        const line = lines[i];
        if (!line) continue;
        // Format: file:line:col:text — text itself may contain colons.
        const c1 = line.indexOf(':');
        if (c1 < 0) continue;
        const c2 = line.indexOf(':', c1 + 1);
        if (c2 < 0) continue;
        const c3 = line.indexOf(':', c2 + 1);
        if (c3 < 0) continue;
        const file = line.slice(0, c1);
        const ln = parseInt(line.slice(c1 + 1, c2), 10);
        const text = line.slice(c3 + 1).trim().slice(0, 200);
        if (!Number.isFinite(ln)) continue;
        results.push({ file, line: ln, text });
      }
      return Response.json({ results }, { headers: corsHeaders });
    }

    // grep fallback
    const grepArgs = ['-rn', '-m', '50'];
    if (caseMode === 'insensitive') grepArgs.push('-i');
    else if (caseMode === 'smart' && query === query.toLowerCase()) grepArgs.push('-i');
    for (const d of EXCLUDE_DIRS) grepArgs.push(`--exclude-dir=${d}`);
    grepArgs.push('-e', query, '.');

    const proc = Bun.spawn(['grep', ...grepArgs], { cwd: root, stdout: 'pipe', stderr: 'ignore' });
    const { stdout } = await runWithTimeout(proc, 15000);

    const results = stdout.split('\n').filter(Boolean).slice(0, MAX_RESULTS).map(line => {
      const c1 = line.indexOf(':');
      const c2 = c1 >= 0 ? line.indexOf(':', c1 + 1) : -1;
      if (c1 < 0 || c2 < 0) return { file: '', line: 0, text: line };
      const file = line.slice(0, c1);
      const ln = parseInt(line.slice(c1 + 1, c2), 10);
      const text = line.slice(c2 + 1).trim().slice(0, 200);
      return { file, line: Number.isFinite(ln) ? ln : 0, text };
    });
    return Response.json({ results }, { headers: corsHeaders });
  } catch {
    return Response.json({ results: [] }, { headers: corsHeaders });
  }
}
