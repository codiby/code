import { expect, test } from 'bun:test';
import { configureRemoteRegistry, getRemote, loadRemotes } from './remotes';

test('Electron resolves the current registry from Bun and fails explicitly when unavailable', async () => {
  let alias = 'pc-b';
  let status = 200;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    expect(new URL(req.url).pathname).toBe('/remotes');
    return Response.json([{ id: 'remote-b', alias, bunPort: 3111 }], { status });
  } });
  configureRemoteRegistry(async () => server.url.origin);
  try {
    expect((await getRemote('remote-b'))?.alias).toBe('pc-b');
    alias = 'pc-b-updated';
    expect((await getRemote('remote-b'))?.alias).toBe('pc-b-updated');
    alias = '-oProxyCommand=bad';
    await expect(loadRemotes()).rejects.toThrow('Invalid remote registry');
    status = 503;
    await expect(loadRemotes()).rejects.toThrow('503');
  } finally { server.stop(true); }
});
