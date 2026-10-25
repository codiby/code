import { NativeModules } from 'react-native';
import { shareTargetsConfig, syncShareTargets } from '../src/lib/shareTargets';
import type { ServerEntry } from '../src/config/servers';

const server: ServerEntry = {
  id: 'host',
  name: 'Mi host',
  token: ' token ',
  color: 'green',
  mode: 'auto',
  localUrl: 'http://192.168.1.5:3111/',
  remoteUrl: 'https://host.example/',
};

test('el receptor usa las rutas configuradas y respeta el modo forzado', () => {
  const read = (entry: ServerEntry) =>
    JSON.parse(shareTargetsConfig([entry])).servers;
  expect(read(server)[0]).toEqual({
    id: 'host',
    name: 'Mi host',
    token: 'token',
    urls: ['http://192.168.1.5:3111', 'https://host.example'],
  });
  expect(read({ ...server, mode: 'remote' })[0].urls).toEqual([
    'https://host.example',
  ]);
  expect(read({ ...server, mode: 'local' })[0].urls).toEqual([
    'http://192.168.1.5:3111',
  ]);
  expect(read({ ...server, mode: 'remote', remoteUrl: '' })).toEqual([]);
  expect(
    read({
      ...server,
      localUrl: 'file:///private',
      remoteUrl: 'ftp://host.example',
    }),
  ).toEqual([]);
});

test('eliminar hosts también elimina el acceso de los receptores nativos', async () => {
  NativeModules.ShareTargets = {
    configure: jest.fn().mockResolvedValue(undefined),
  };
  await syncShareTargets([server]);
  await syncShareTargets([]);
  expect(NativeModules.ShareTargets.configure).toHaveBeenLastCalledWith(
    '{"version":1,"servers":[]}',
  );
  delete NativeModules.ShareTargets;
});
