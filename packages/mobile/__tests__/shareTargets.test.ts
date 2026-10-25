import { NativeModules } from 'react-native';
import {
  shareTargetsConfig,
  syncShareTargets,
  shareSessionsSnapshot,
  syncShareSessions,
} from '../src/lib/shareTargets';
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
    color: 'green',
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

test('compartir reutiliza los chats activos del inicio, anclados y vistas previas', async () => {
  const row = {
    id: 'same',
    serverId: 'host',
    key: 'host:same',
    name: 'Codiby',
    cwd: '/src/code',
    folder: 'code',
    updatedAt: 5,
    isOpen: true,
    isRunning: false,
    provider: null,
    disposableTtlMs: null,
  };
  const snapshot = {
    sessions: [
      row,
      { ...row, serverId: 'other', key: 'other:same' },
      { ...row, id: 'archived', isOpen: false },
    ],
    pinnedIds: ['host:same'],
    pinnedGroups: [],
    groups: [],
    serverMaps: [],
    previews: { 'host:same': { at: 5, text: 'Último mensaje' } },
  };
  const rows = JSON.parse(shareSessionsSnapshot(snapshot));
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    id: 'same',
    serverId: 'host',
    pinned: true,
    pinOrder: 0,
    preview: 'Último mensaje',
  });
  expect(rows[1]).toMatchObject({
    id: 'same',
    serverId: 'other',
    pinned: false,
    pinOrder: -1,
  });
  NativeModules.ShareTargets = {
    cacheSessions: jest.fn().mockResolvedValue(undefined),
  };
  await syncShareSessions(snapshot);
  expect(NativeModules.ShareTargets.cacheSessions).toHaveBeenCalledWith(
    shareSessionsSnapshot(snapshot),
  );
  await syncShareSessions({ ...snapshot, sessions: [] });
  expect(NativeModules.ShareTargets.cacheSessions).toHaveBeenLastCalledWith(
    '[]',
  );
  delete NativeModules.ShareTargets;
});
