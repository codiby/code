import { NativeModules } from 'react-native';
import type { HomeSnapshot } from '../src/api/homeSnapshot';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn().mockResolvedValue(undefined),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';

const snapshot: HomeSnapshot = {
  sessions: [
    {
      id: 'chat',
      serverId: 'host',
      key: 'host:chat',
      name: 'Chat del inicio',
      cwd: '/src/code',
      folder: 'code',
      updatedAt: 10,
      isOpen: true,
      isRunning: false,
      provider: null,
      disposableTtlMs: null,
    },
  ],
  groups: [],
  serverMaps: [],
  pinnedIds: [],
  pinnedGroups: [],
  previews: {},
};

test('hidratar el inicio y actualizarlo publica la misma lista para compartir', async () => {
  jest.useFakeTimers();
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(
    JSON.stringify(snapshot),
  );
  NativeModules.ShareTargets = {
    cacheSessions: jest.fn().mockResolvedValue(undefined),
  };
  const {
    loadHomeSnapshot,
    saveHomeSnapshot,
  } = require('../src/api/homeSnapshot');
  await loadHomeSnapshot();
  expect(
    JSON.parse(NativeModules.ShareTargets.cacheSessions.mock.calls[0][0])[0]
      .name,
  ).toBe('Chat del inicio');
  saveHomeSnapshot({ ...snapshot, sessions: [] });
  expect(NativeModules.ShareTargets.cacheSessions).toHaveBeenLastCalledWith(
    '[]',
  );
  jest.runOnlyPendingTimers();
  delete NativeModules.ShareTargets;
  jest.useRealTimers();
});
