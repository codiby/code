import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { NativeModules } from 'react-native';
import { ShareScreen } from '../src/ShareApp';
import { SessionRow } from '../src/components/SessionList/SessionRow';
import { Composer } from '../src/components/Chat/Composer';
import { fetchShareHost, sendIncomingShare } from '../src/lib/incomingShare';

jest.mock('../src/global.css', () => ({}));
jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: require('react-native').View,
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: require('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
}));
jest.mock('../src/components/Chat/ComposerSpots', () => ({
  ComposerSpots: () => null,
}));
jest.mock('../src/lib/incomingShare', () => ({
  ...jest.requireActual('../src/lib/incomingShare'),
  fetchShareHost: jest.fn(),
  sendIncomingShare: jest.fn(),
}));

const image = { mediaType: 'image/jpeg', data: 'image-data' };
const payload = {
  config: JSON.stringify({
    version: 1,
    servers: [
      {
        id: 'host',
        name: 'Mac',
        color: 'violet',
        token: 'token',
        urls: ['https://host'],
      },
    ],
  }),
  snapshot: JSON.stringify([
    {
      id: 'chat',
      serverId: 'host',
      name: 'Chat del inicio',
      cwd: '/src/code',
      updated_at: 10,
      preview: 'Último mensaje',
      pinned: true,
      pinOrder: 0,
    },
  ]),
  text: 'Desde la galería',
  images: [image],
};
const button = (tree: ReactTestRenderer.ReactTestRenderer, label: string) =>
  tree.root.findAllByProps({ accessibilityLabel: label })[0]!;

beforeEach(() => {
  NativeModules.ShareTargets = {
    read: jest.fn().mockResolvedValue(payload),
    finish: jest.fn().mockResolvedValue(undefined),
  };
  (fetchShareHost as jest.Mock).mockImplementation(() => new Promise(() => {}));
  (sendIncomingShare as jest.Mock).mockReset();
});
afterEach(() => {
  delete NativeModules.ShareTargets;
});

test('usa la fila real del inicio y el compositor del chat sin esperar a la red', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<ShareScreen requestId="incoming-1" />);
  });
  const row = tree.root.findByType(SessionRow);
  expect(row.props.session.name).toBe('Chat del inicio');
  expect(row.props.preview).toBe('Último mensaje');
  expect(row.props.serverColor).toBe('#7c3aed');
  expect(tree.root.findByType(Composer).props.initialImages).toEqual([image]);
  expect(button(tree, 'Enviar').props.disabled).toBe(true);
  expect(sendIncomingShare).not.toHaveBeenCalled();
  await act(async () => row.props.onPress(row.props.session));
  expect(button(tree, 'Enviar').props.disabled).toBe(false);
  await act(async () => {
    tree.unmount();
  });
});

test('restaura imágenes y texto al fallar; solo cierra después de enviar', async () => {
  (sendIncomingShare as jest.Mock)
    .mockRejectedValueOnce(new Error('Sin conexión'))
    .mockResolvedValueOnce(undefined);
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<ShareScreen requestId="incoming-1" />);
  });
  const row = tree.root.findByType(SessionRow);
  await act(async () => row.props.onPress(row.props.session));
  await act(async () => button(tree, 'Enviar').props.onPress());
  expect(button(tree, 'Mensaje').props.value).toBe('Desde la galería');
  expect(button(tree, 'Enviar').props.disabled).toBe(false);
  expect(NativeModules.ShareTargets.finish).not.toHaveBeenCalled();
  await act(async () => button(tree, 'Enviar').props.onPress());
  expect(sendIncomingShare).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: 'host' }),
    expect.objectContaining({ id: 'chat' }),
    'Desde la galería',
    [image],
  );
  expect(NativeModules.ShareTargets.finish).toHaveBeenCalledWith(
    'incoming-1',
    true,
  );
  await act(async () => {
    tree.unmount();
  });
});

test('cancelar termina únicamente el compartir actual sin enviar', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<ShareScreen requestId="incoming-2" />);
  });
  expect(NativeModules.ShareTargets.read).toHaveBeenCalledWith('incoming-2');
  await act(async () => button(tree, 'Cancelar').props.onPress());
  expect(NativeModules.ShareTargets.finish).toHaveBeenCalledWith(
    'incoming-2',
    false,
  );
  expect(sendIncomingShare).not.toHaveBeenCalled();
  await act(async () => {
    tree.unmount();
  });
});
