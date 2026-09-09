/** Browser regression: real composer, repeated Enter, failure, preserved draft.
 * Run Chrome with --remote-debugging-port=9227 and a temporary profile, then
 * `bun run scripts/test-session-composer.ts`. CDP_URL overrides the endpoint.
 * `--baseline` tests HEAD's composer and must fail on the original double send.
 */
import { join } from 'node:path';
const root = join(import.meta.dir, '..');
const built = await Bun.build({
  entrypoints: ['composer-fixture'], target: 'browser',
  plugins: [{ name: 'fixture', setup(build) {
    if (process.argv.includes('--baseline')) build.onLoad({ filter: /GroupComposer\.tsx$/ }, () => ({ loader: 'tsx', contents: Bun.spawnSync(['git', 'show', 'HEAD:packages/ui/src/components/GroupComposer.tsx'], { cwd: root }).stdout.toString() }));
    build.onResolve({ filter: /^composer-fixture$/ }, () => ({ path: 'fixture', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'tsx', resolveDir: root, contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { GroupComposer } from './packages/ui/src/components/GroupComposer';
      localStorage.setItem('claude-ui-last-provider', 'codex');
      window.calls = [];
      const root = createRoot(document.getElementById('root'));
      root.render(<GroupComposer groupName="Test" groupCwd="/tmp" client={{ getCodexInfo: async () => ({available:true,models:[{id:'codex-fixture',label:'Codex fixture model',isDefault:true,efforts:['low','high']}]}), getGitInfo: async () => ({is_git:false}), getFileIndex: async () => [] } as any} claudeModels={[{id:"claude-test",label:"Claude-only model"}]}
        onSpawn={(...args) => { window.calls.push(args); return new Promise((resolve, reject) => { window.resolveSpawn = resolve; window.rejectSpawn = reject; }); }} />);
    ` }));
  } }],
});
if (!built.success) throw new Error(built.logs.join('\n'));
const js = await built.outputs.find(x => x.kind === 'entry-point')!.text();
const server = Bun.serve({ hostname: '127.0.0.1', port: 41829, fetch(req) {
  return new URL(req.url).pathname === '/fixture.js'
    ? new Response(js, { headers: { 'Content-Type': 'text/javascript' } })
    : new Response('<!doctype html><html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } });
} });
const endpoint = process.env.CDP_URL || 'http://127.0.0.1:9227';
const target = await (await fetch(`${endpoint}/json/new?${encodeURIComponent(server.url.href)}`, { method: 'PUT' })).json() as { webSocketDebuggerUrl: string; id: string };
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
let nextId = 0;
const pending = new Map<number, { resolve(value: any): void; reject(reason: any): void }>();
ws.onmessage = e => { const m = JSON.parse(String(e.data)); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); } };
function command(method: string, params: object = {}): Promise<any> {
  return new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression: string) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression: string) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await evaluate(expression)) return; await Bun.sleep(25); }
  throw new Error(`Timed out: ${expression}`);
}
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }
try {
  await until('!!document.querySelector("[contenteditable=true]")');
  await until('!document.body.innerText.includes("Loading Codex models")');
  // Codex must not inherit the global Claude model cache.
  await evaluate('document.querySelector("[aria-label=Model]").click()');
  await until('!!document.querySelector("[role=listbox]")');
  assert(await evaluate('!document.body.innerText.includes("Claude-only model")'), 'Codex offered a Claude model');
  assert(await evaluate('document.body.innerText.includes("Codex fixture model")'), 'Codex catalog is missing');
  await evaluate(`Array.from(document.querySelectorAll('[role=option]')).find(el => el.textContent.includes('Codex fixture model')).click()`);
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await evaluate('document.querySelector("[contenteditable=true]").focus()');
  await command('Input.insertText', { text: 'first message' });
  await until('document.body.innerText.includes("first message")');
  // Same JS task: no React render can race ahead and mask a missing ref lock.
  await evaluate(`(() => { const el = document.querySelector('[contenteditable=true]'); for (let i=0;i<2;i++) el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true})); })()`);
  await until('window.calls.length > 0');
  assert(await evaluate('window.calls.length === 1'), 'Double Enter created multiple sessions');
  assert(await evaluate('window.calls[0][3] === "codex-fixture"'), 'Selected Codex model was not sent');
  await until('document.body.innerText.includes("Creating session")');
  await evaluate('window.rejectSpawn(new Error("Codex could not start"))');
  await until('document.querySelector("[role=alert]")?.textContent.includes("Codex could not start")');
  assert(await evaluate('document.querySelector("[contenteditable=true]").textContent.includes("first message")'), 'Failure lost the draft');
  await evaluate(`document.querySelector('[contenteditable=true]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}))`);
  await until('window.calls.length === 2');
  assert(await evaluate('window.calls[1][2] === "first message"'), 'Retry did not preserve the first message');
  await evaluate('window.resolveSpawn()');
  await until('!document.querySelector("[contenteditable=true]").textContent.trim()');
  console.log('PASS: Codex catalog and selected model, double Enter, busy feedback, visible error, preserved draft, retry');
} finally {
  ws.close(); server.stop(true);
  await fetch(`${endpoint}/json/close/${target.id}`);
}
