import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { HostCard } from '../src/components/HostCard';
import { HostEditorSheet } from '../src/screens/HostEditorSheet';
import type { ServerEntry } from '../src/config/servers';

const mockServer: ServerEntry = {
  id: 'studio',
  name: 'Mac Studio',
  localUrl: 'http://192.168.1.2:3111',
  remoteUrl: '',
  token: 'existing-token',
  color: 'green',
  mode: 'auto',
};
const mockUpsert = jest.fn();
const mockRemove = jest.fn();
const mockRefresh = jest.fn();
jest.mock('../src/config/ServerConfigContext', () => ({
  useServers: () => ({
    servers: [mockServer],
    upsertServer: mockUpsert,
    removeServer: mockRemove,
    refreshRoutes: mockRefresh,
    routes: {
      studio: {
        baseUrl: mockServer.localUrl,
        path: 'local',
        latencyMs: 12,
        isProbing: false,
      },
    },
  }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockUpsert.mockResolvedValue(undefined);
});

test('la tarjeta abre una edición aislada; cancelar conserva la configuración', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<SettingsScreen />);
  });
  expect(tree.root.findByType(HostEditorSheet).props.server).toBeNull();
  await act(async () => {
    tree.root.findByType(HostCard).props.onPress();
  });
  const sheet = () => tree.root.findByType(HostEditorSheet);
  expect(sheet().props.server).toEqual(mockServer);
  expect(sheet().props.canRemove).toBe(false);
  await act(async () => {
    sheet().props.onChange({ ...mockServer, name: 'Otro nombre' });
  });
  await act(async () => {
    sheet().props.onClose();
  });
  expect(sheet().props.server).toBeNull();
  expect(tree.root.findByType(HostCard).props.server.name).toBe('Mac Studio');
  expect(mockUpsert).not.toHaveBeenCalled();
  await act(async () => {
    tree.unmount();
  });
});

test('guardar normaliza las direcciones y cierra la hoja después de persistir', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<SettingsScreen />);
  });
  await act(async () => {
    tree.root.findByType(HostCard).props.onPress();
  });
  const sheet = () => tree.root.findByType(HostEditorSheet);
  await act(async () => {
    sheet().props.onChange({
      ...mockServer,
      name: ' Studio ',
      localUrl: '192.168.1.3',
      token: ' token ',
    });
  });
  await act(async () => {
    await sheet().props.onSave();
  });
  expect(mockUpsert).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'studio',
      name: 'Studio',
      localUrl: 'http://192.168.1.3:3111',
      token: 'token',
    }),
  );
  expect(mockRefresh).toHaveBeenCalledTimes(1);
  expect(sheet().props.server).toBeNull();
  await act(async () => {
    tree.unmount();
  });
});

test('un fallo de guardado conserva los campos y permite reintentar', async () => {
  mockUpsert.mockRejectedValueOnce(new Error('storage unavailable'));
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<SettingsScreen />);
  });
  await act(async () => {
    tree.root.findByType(HostCard).props.onPress();
  });
  const sheet = () => tree.root.findByType(HostEditorSheet);
  await act(async () => {
    sheet().props.onChange({ ...mockServer, name: 'Mi host' });
  });
  await act(async () => {
    await sheet().props.onSave();
  });
  expect(sheet().props.server.name).toBe('Mi host');
  expect(sheet().props.error).toContain('No se pudo guardar');
  expect(sheet().props.isBusy).toBe(false);
  await act(async () => {
    await sheet().props.onSave();
  });
  expect(mockUpsert).toHaveBeenCalledTimes(2);
  expect(sheet().props.server).toBeNull();
  await act(async () => {
    tree.unmount();
  });
});
