import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Modal } from 'react-native';
import { ChatImage } from '../src/components/Chat/ChatImage';
import { ImageLightbox } from '../src/components/Gallery';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: require('react-native').View,
}));
jest.mock('../src/components/Gallery', () => ({
  ImageLightbox: jest.fn(() => null),
}));

test('abre las fotos del chat en el visor con zoom dentro de una raíz de gestos Android', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <ChatImage image={{ mediaType: 'image/png', data: 'photo-base64' }} />,
    );
  });
  expect(tree.root.findAllByType(ImageLightbox)).toHaveLength(0);
  const open = () => tree.root.findAllByProps({ accessibilityLabel: 'Abrir imagen' })[0]!;
  await act(async () => open().props.onPress());
  const viewer = tree.root.findByType(ImageLightbox);
  expect(viewer.props.items).toEqual([
    { id: 'chat-image', uri: 'data:image/png;base64,photo-base64', name: 'Imagen' },
  ]);
  expect(tree.root.findAllByType(GestureHandlerRootView).some(root =>
    root.findAllByType(ImageLightbox).length === 1,
  )).toBe(true);
  await act(async () => viewer.props.onClose());
  expect(tree.root.findAllByType(ImageLightbox)).toHaveLength(0);
  await act(async () => open().props.onPress());
  await act(async () => tree.root.findByType(Modal).props.onRequestClose());
  expect(tree.root.findAllByType(ImageLightbox)).toHaveLength(0);
  await act(async () => tree.unmount());
});
