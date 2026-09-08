import { describe, test, expect } from 'bun:test';
import type { SessionInfo } from './claude-client';
import { mergeSessionsByOwner } from './merge-sessions';

function session(id: string, remoteId: string | null, name = id): SessionInfo {
  return {
    id, name, cwd: '/src',
    created_at: 0, updated_at: 0,
    status: 'open', runtime_status: 'running', ready: true,
    claude_session_id: null, ws_url: '', saved_commands: [],
    model: null, permission_mode: 'default',
    remoteId, remoteName: remoteId ? 'ryzen9' : null, remoteColor: null,
  } as SessionInfo;
}

const RYZEN = 'rmt_ryzen9';

describe('mergeSessionsByOwner', () => {
  test('a session mirrored by the local bridge is listed once', () => {
    const owned = session('s1', RYZEN, 'App debug');
    const merged = mergeSessionsByOwner([
      // The local bridge surfacing an aggregated remote row…
      ['', [session('local-1', null), session('s1', RYZEN, 'App debug (stale)')]],
      // …and the remote's own direct connection reporting the same session.
      [RYZEN, [owned]],
    ]);

    expect(merged.map(s => s.id)).toEqual(['local-1', 's1']);
    expect(merged.find(s => s.id === 's1')!.name).toBe('App debug');
  });

  test('the owner wins even when its list arrives first', () => {
    const owned = session('s1', RYZEN, 'App debug');
    const merged = mergeSessionsByOwner([
      [RYZEN, [owned]],
      ['', [session('s1', RYZEN, 'App debug (stale)')]],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.name).toBe('App debug');
  });

  test('one machine registered under two remotes yields one row', () => {
    const merged = mergeSessionsByOwner([
      [RYZEN, [session('s1', RYZEN)]],
      ['rmt_ryzen9_lan', [session('s1', 'rmt_ryzen9_lan')]],
    ]);
    expect(merged).toHaveLength(1);
  });

  test('distinct sessions from every connection are kept, in connection order', () => {
    const merged = mergeSessionsByOwner([
      ['', [session('a', null), session('b', null)]],
      [RYZEN, [session('c', RYZEN)]],
    ]);
    expect(merged.map(s => s.id)).toEqual(['a', 'b', 'c']);
  });

  test('no connections is an empty list', () => {
    expect(mergeSessionsByOwner([])).toEqual([]);
  });
});
