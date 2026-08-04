/**
 * Portless cross-action exports are an ACTION-only feature.
 *
 * Two halves to this file:
 *   1. `buildInjectedActionEnv` still produces sibling exports (what an
 *      Action must keep receiving), and still excludes the action's own.
 *   2. The spawn paths that are NOT actions — the terminals REST route
 *      (dock "+", mobile, `/terminal`, `/t`, `>` commands, terminals
 *      restored on reconnect) and the `spawn_terminal` MCP tool — never
 *      reach for it. That half is asserted against the source of the two
 *      handlers, because the injection bug was a call-site bug: the
 *      builder was correct, it was simply invoked from the wrong places.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildInjectedActionEnv } from './action-env';
import { spawnPty } from './pty';
import type { TabGroupInfo } from '../../ui/src/lib/tab-groups';

const API = 'act-api';
const WEB = 'act-web';

function group(overrides: Partial<TabGroupInfo> = {}): TabGroupInfo {
  return {
    id: 'grp-1',
    name: 'Demo',
    cwd: '/tmp/demo',
    portless: {
      tls: true,
      actions: [
        { id: API, name: 'api', command: 'bun run api' },
        { id: WEB, name: 'web', command: 'bun run web' },
      ],
      exports: [
        { id: 'e1', name: 'API_URL', sourceActionId: API, format: 'url' },
        { id: 'e2', name: 'WEB_URL', sourceActionId: WEB, format: 'url' },
      ],
    },
    ...overrides,
  } as TabGroupInfo;
}

describe('buildInjectedActionEnv — what an Action receives', () => {
  test('an action gets its siblings exports but never its own', () => {
    const env = buildInjectedActionEnv(group(), 'localhost', API);
    expect(env).toEqual({ WEB_URL: 'https://web.localhost' });
  });

  test('the sibling in the other direction sees the api export', () => {
    const env = buildInjectedActionEnv(group(), 'localhost', WEB);
    expect(env).toEqual({ API_URL: 'https://api.localhost' });
  });

  test('portless disabled for the project yields nothing', () => {
    const g = group();
    g.portless!.enabled = false;
    expect(buildInjectedActionEnv(g, 'localhost', API)).toEqual({});
  });

  test('a project with no portless config yields nothing', () => {
    expect(buildInjectedActionEnv({ id: 'g', name: 'x' } as TabGroupInfo, 'localhost', API)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Call-site guard. `injectedEnv` is plumbed through `createTerminal`, so the
// only thing standing between a plain shell and a surprise `API_URL` is
// whether these handlers build one. Slice each handler out of its file and
// assert on that slice — a future edit that re-adds injection to a terminal
// path fails here with the handler named.
// ---------------------------------------------------------------------------

const CORE = join(import.meta.dir, '..');
const indexSrc = readFileSync(join(CORE, 'index.ts'), 'utf-8');
const sdkToolsSrc = readFileSync(join(CORE, 'provider', 'sdk-tools.ts'), 'utf-8');

/** Text between `start` and the next `end` marker after it. Throws when the
 *  markers moved, so the guard can never silently pass on a stale slice. */
function slice(src: string, label: string, start: string, end: string): string {
  const from = src.indexOf(start);
  if (from === -1) throw new Error(`could not find the start of ${label} ("${start}")`);
  const to = src.indexOf(end, from + start.length);
  if (to === -1) throw new Error(`could not find the end of ${label} ("${end}")`);
  return src.slice(from, to);
}

const terminalsRoute = slice(
  indexSrc,
  'POST /sessions/:id/terminals',
  `app.post('/sessions/:id/terminals'`,
  `app.get('/sessions/:id/terminals/:procId'`,
);
const spawnTerminalTool = slice(sdkToolsSrc, 'spawn_terminal', `'spawn_terminal',`, `'read_terminal_output',`);
const actionsRunTool = slice(sdkToolsSrc, 'actions_run', `'actions_run',`, `\n      tool(\n`);
const portlessRunRoute = slice(indexSrc, 'POST /portless/run', `app.post('/portless/run'`, `app.post('/portless/stop'`);

describe('terminal spawn paths never inject Portless exports', () => {
  test('the terminals REST route builds no injected env', () => {
    expect(terminalsRoute).not.toContain('buildInjectedActionEnv');
    expect(terminalsRoute).not.toContain('injectedEnv');
  });

  test('the spawn_terminal MCP tool builds no injected env', () => {
    expect(spawnTerminalTool).not.toContain('buildInjectedActionEnv');
    expect(spawnTerminalTool).not.toContain('injectedEnv');
  });

  test('buildInjectedActionEnv is called from the two Action paths only', () => {
    const calls = [...indexSrc.matchAll(/buildInjectedActionEnv\(/g)].length
      + [...sdkToolsSrc.matchAll(/buildInjectedActionEnv\(/g)].length;
    expect(calls).toBe(2);
  });
});

describe('Action launch paths still inject Portless exports', () => {
  test('actions_run passes sibling exports, excluding the action itself', () => {
    expect(actionsRunTool).toContain('buildInjectedActionEnv');
    expect(actionsRunTool).toContain('injectedEnv: actionEnv');
    // `match.id` is the exclusion argument — without it an action would
    // receive its own URL.
    expect(actionsRunTool).toMatch(/buildInjectedActionEnv\([^;]*match\.id/);
  });

  test('POST /portless/run passes sibling exports, excluding the action itself', () => {
    expect(portlessRunRoute).toContain('buildInjectedActionEnv');
    expect(portlessRunRoute).toMatch(/buildInjectedActionEnv\([^;]*body\.actionId/);
    expect(portlessRunRoute).toContain('env: runEnv');
  });
});

// ---------------------------------------------------------------------------
// The other end of the chain: the PTY only ever sees an export because a
// caller handed it one. `createTerminal` forwards `injectedEnv` verbatim as
// `extraEnv`, so proving the shell's env is untouched without it closes the
// loop with the call-site guard above.
// ---------------------------------------------------------------------------

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const PROBE = 'CODIBY_TEST_ACTION_URL';

async function probeShellEnv(extraEnv?: Record<string, string>): Promise<string> {
  const pty = spawnPty({ cwd: process.cwd(), cols: 100, rows: 30, shell: '/bin/sh', extraEnv });
  expect(pty).not.toBeNull();
  if (!pty) return '';
  let output = '';
  pty.onData(text => { output += text; });
  try {
    await delay(300);
    pty.write(`printf "<%s>" "$${PROBE}"\r`);
    const deadline = Date.now() + 3_000;
    // The echoed command line also contains "<%s>", so wait for the shell's
    // own rendering of it (no `%s` left) before reading.
    while (!/<[^%>]*>/.test(output) && Date.now() < deadline) await delay(20);
    return output;
  } finally {
    pty.kill();
  }
}

describe.skipIf(process.platform === 'win32' || !!process.env[PROBE])(
  'a PTY only carries exports its caller injected',
  () => {
    test('no extraEnv — the shell sees an empty value', async () => {
      const output = await probeShellEnv();
      expect(output).toMatch(/<>/);
      expect(output).not.toContain('https://api.localhost');
    }, 10_000);

    test('extraEnv — the shell sees the injected value', async () => {
      const output = await probeShellEnv({ [PROBE]: 'https://api.localhost' });
      expect(output).toContain('<https://api.localhost>');
    }, 10_000);
  },
);
