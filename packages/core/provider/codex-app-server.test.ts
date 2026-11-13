import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServer } from './codex-app-server';

// A stand-in `codex app-server`: answers `initialize` and `ping`, never `turn/interrupt`.
const dir = mkdtempSync(join(tmpdir(), 'fake-codex-'));
const bin = join(dir, 'codex');
writeFileSync(bin, `#!/usr/bin/env bun
for await (const line of console) {
  const m = JSON.parse(line);
  if (m.id !== undefined && (m.method === 'initialize' || m.method === 'ping')) console.log(JSON.stringify({ id: m.id, result: {} }));
}
`);
chmodSync(bin, 0o755);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function connect() {
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  const exits: Error[] = [];
  try {
    const server = new CodexAppServer({ notification() {}, request: async () => ({}), exit: error => { exits.push(error); } });
    return { server, exits };
  } finally {
    if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous;
  }
}

test('a non-fatal timeout rejects the request but keeps the runtime alive', async () => {
  const { server, exits } = connect();
  await server.ready;
  await expect(server.request('turn/interrupt', {}, { timeoutMs: 50, fatal: false })).rejects.toThrow('turn/interrupt');
  expect(exits).toHaveLength(0);
  expect(await server.request<Record<string, never>>('ping', {})).toEqual({});
  await server.close();
});

test('a fatal timeout still kills a wedged runtime', async () => {
  const { server, exits } = connect();
  await server.ready;
  await expect(server.request('turn/interrupt', {}, { timeoutMs: 50 })).rejects.toThrow();
  expect(exits).toHaveLength(1);
  await server.close();
});
