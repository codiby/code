import { describe, expect, test, beforeEach } from 'bun:test';

// `bun test` has no DOM, and the module under test reads `localStorage` as a
// bare global. An in-memory stub installed before the import keeps the suite
// free of a jsdom dependency.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
};

const { addRecentDir, getRecentDirs, LOCAL_HOST } = await import('./recent-dirs');

const LEGACY_KEY = 'claude-ui-recent-dirs';
const KEY = 'claude-ui-recent-dirs-by-host';
const REMOTE = 'rmt_ryzen9';

beforeEach(() => {
  localStorage.removeItem(KEY);
  localStorage.removeItem(LEGACY_KEY);
});

describe('recent dirs', () => {
  test('a remote path never surfaces under local', () => {
    addRecentDir(REMOTE, '/home/jovaz/vtb');
    expect(getRecentDirs(REMOTE)).toEqual(['/home/jovaz/vtb']);
    expect(getRecentDirs(null)).toEqual([]);
  });

  test('a local path never surfaces under a remote', () => {
    addRecentDir(null, '/Users/jovaz/src/code');
    expect(getRecentDirs(null)).toEqual(['/Users/jovaz/src/code']);
    expect(getRecentDirs(REMOTE)).toEqual([]);
  });

  test('the same path on two hosts keeps a slot on each', () => {
    addRecentDir(null, '/srv/app');
    addRecentDir(REMOTE, '/srv/app');
    expect(getRecentDirs(null)).toEqual(['/srv/app']);
    expect(getRecentDirs(REMOTE)).toEqual(['/srv/app']);
  });

  test('re-using a directory moves it to the front without duplicating', () => {
    addRecentDir(null, '/a');
    addRecentDir(null, '/b');
    addRecentDir(null, '/a');
    expect(getRecentDirs(null)).toEqual(['/a', '/b']);
  });

  test('trimming is per host, so a busy machine cannot evict another', () => {
    for (let i = 0; i < 12; i++) addRecentDir(null, `/local/${i}`);
    addRecentDir(REMOTE, '/home/jovaz/vtb');
    for (let i = 0; i < 12; i++) addRecentDir(null, `/local/more/${i}`);
    expect(getRecentDirs(null)).toHaveLength(10);
    expect(getRecentDirs(REMOTE)).toEqual(['/home/jovaz/vtb']);
  });

  test('pre-migration entries are read as local', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(['/Users/jovaz/src/code', '/Users/jovaz/3d']));
    expect(getRecentDirs(null)).toEqual(['/Users/jovaz/src/code', '/Users/jovaz/3d']);
    expect(getRecentDirs(REMOTE)).toEqual([]);
  });

  test('the first write after migration keeps the legacy entries', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(['/Users/jovaz/3d']));
    addRecentDir(REMOTE, '/home/jovaz/vtb');
    expect(getRecentDirs(null)).toEqual(['/Users/jovaz/3d']);
    expect(getRecentDirs(REMOTE)).toEqual(['/home/jovaz/vtb']);
  });

  test('an undefined remote id is this machine', () => {
    addRecentDir(undefined, '/x');
    expect(getRecentDirs(LOCAL_HOST)).toEqual(['/x']);
  });

  test('corrupt storage degrades to empty rather than throwing', () => {
    localStorage.setItem(KEY, '{not json');
    expect(getRecentDirs(null)).toEqual([]);
  });
});
