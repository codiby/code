#!/usr/bin/env bun
// Benchmark the file search handler against a real codebase.
// Usage: bun run scripts/bench-search.ts [root] [query]

import { rgPath } from '@vscode/ripgrep';
import { handleSearch } from '../packages/core/handlers/search';

const ROOT = process.argv[2] || '/Users/jovaz/src/up/utilityprofit';
const QUERY = process.argv[3] || 'auto';
const TARGET_MS = 500;
const RUNS = 5;

async function timeIt<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}

async function rawRg(caseFlag: string): Promise<{ ms: number; lines: number; bytes: number }> {
  const start = performance.now();
  const proc = Bun.spawn(
    [
      rgPath, '--vimgrep', '--no-heading', '--color', 'never',
      '--max-count', '5', '--max-filesize', '1M', '--max-columns', '300',
      '--threads', '0', caseFlag, '-e', QUERY, '.',
    ],
    { cwd: ROOT, stdout: 'pipe', stderr: 'ignore' },
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return { ms: performance.now() - start, lines: stdout.split('\n').filter(Boolean).length, bytes: stdout.length };
}

async function handler(caseMode: 'sensitive' | 'insensitive' | 'smart') {
  const { ms, value } = await timeIt(async () => {
    const resp = await handleSearch(ROOT, QUERY, caseMode);
    return resp.json() as Promise<{ results: unknown[] }>;
  });
  return { ms, count: value.results.length };
}

console.log(`root:  ${ROOT}`);
console.log(`query: "${QUERY}"`);
console.log(`target: < ${TARGET_MS}ms\n`);

// Warm up filesystem cache and the rg path cache.
await rawRg('--ignore-case');
await handler('insensitive');

for (const caseFlag of ['--ignore-case', '--case-sensitive'] as const) {
  const rawTimes: number[] = [];
  let lastLines = 0, lastBytes = 0;
  for (let i = 0; i < RUNS; i++) {
    const r = await rawRg(caseFlag);
    rawTimes.push(r.ms);
    lastLines = r.lines; lastBytes = r.bytes;
  }
  const avg = rawTimes.reduce((a, b) => a + b, 0) / rawTimes.length;
  const min = Math.min(...rawTimes), max = Math.max(...rawTimes);
  console.log(`raw rg ${caseFlag.padEnd(16)}  avg ${avg.toFixed(0)}ms  min ${min.toFixed(0)}  max ${max.toFixed(0)}  (${lastLines} lines, ${(lastBytes / 1024).toFixed(0)}KB)`);
}

console.log('');

for (const mode of ['insensitive', 'sensitive', 'smart'] as const) {
  const times: number[] = [];
  let lastCount = 0;
  for (let i = 0; i < RUNS; i++) {
    const r = await handler(mode);
    times.push(r.ms);
    lastCount = r.count;
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times), max = Math.max(...times);
  const verdict = avg < TARGET_MS ? 'PASS' : 'FAIL';
  console.log(`handler ${mode.padEnd(11)}  avg ${avg.toFixed(0)}ms  min ${min.toFixed(0)}  max ${max.toFixed(0)}  (${lastCount} results)  [${verdict}]`);
}
