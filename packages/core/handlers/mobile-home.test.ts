import { expect, test } from 'bun:test';
import { buildMobileHome, handleMobileHome } from './mobile-home';

const sessions = [
  { id: 's1', name: 'Uno', cwd: '/tmp', updated_at: 1, status: 'open', runtime_status: 'idle', provider: 'claude', ws_url: 'ws://x', saved_commands: [1, 2] },
];
const prefs = {
  tabGroups: { g1: { name: 'code', color: 'red', cwd: '/secret', envVars: { A: '1' } } },
  tabGroupMap: { s1: 'g1' },
  pinnedSessionIds: ['s1'],
};

test('only the fields the phone reads', () => {
  const home = buildMobileHome(sessions, prefs);
  expect(Object.keys(home.sessions[0]!)).toEqual(['id', 'name', 'cwd', 'updated_at', 'status', 'runtime_status', 'provider']);
  expect(home.preferences.tabGroups.g1).toEqual({ name: 'code', color: 'red', parentId: undefined });
  expect('pinnedGroupIds' in home.preferences).toBe(false);
});

test('gzips, tags, and answers 304 when nothing changed', async () => {
  const first = handleMobileHome(new Request('http://h/mobile/home', { headers: { 'accept-encoding': 'gzip' } }), sessions, prefs);
  expect(first.headers.get('content-encoding')).toBe('gzip');
  const etag = first.headers.get('etag')!;
  const body = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await first.arrayBuffer()))));
  expect(body.sessions[0].id).toBe('s1');

  const again = handleMobileHome(new Request('http://h/mobile/home', { headers: { 'if-none-match': etag } }), sessions, prefs);
  expect(again.status).toBe(304);
});
