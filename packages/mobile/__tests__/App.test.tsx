import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { BackHandler } from 'react-native';

// La prueba de navegación no necesita motores nativos, red ni disco.
jest.mock('../src/global.css', () => ({}));
jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: require('react-native').View,
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: require('react-native').View,
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  Easing: { bezier: () => undefined },
  runOnJS: (fn: unknown) => fn,
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withTiming: (value: unknown) => value,
}));
jest.mock('../src/config/ServerConfigContext', () => ({
  ServerConfigProvider: require('react-native').View,
  useRouteFor: () => ({ baseUrl: '', token: '' }),
}));
jest.mock('../src/api/SocketProvider', () => ({
  SocketProvider: require('react-native').View,
}));
jest.mock('../src/api/useMessageCacheSync', () => ({
  useMessageCacheSync: () => undefined,
}));
jest.mock('../src/lib/drafts', () => ({
  loadDrafts: async () => ({}),
  saveDraft: async () => ({}),
}));
jest.mock('../src/screens', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return {
    ChatScreen: () =>
      R.createElement(Text, { testID: 'direct-screen' }, 'Chat directo'),
    HomeScreen: () =>
      R.createElement(
        Text,
        { testID: 'conversations-screen' },
        'Conversaciones',
      ),
    SettingsScreen: () =>
      R.createElement(Text, { testID: 'settings-screen' }, 'Ajustes'),
  };
});

import App from '../src/App';
import { ChatScreen } from '../src/screens';
import { DEFAULT_TAB_ITEMS } from '../src/components/GlassTabBar/GlassTabBar';

test('volver abre conversaciones y el primer icono abre un chat directo nuevo', async () => {
  expect(DEFAULT_TAB_ITEMS.map(t => t.label)).toEqual([
    'Nuevo chat',
    'Conversaciones',
    'Ajustes',
  ]);
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  const tabs = () =>
    tree.root.findAll(
      node =>
        node.props.accessibilityRole === 'tab' &&
        typeof node.props.onPress === 'function',
      { deep: false },
    );
  expect(tabs()).toHaveLength(0);
  const direct = tree.root.findByProps({ testID: 'direct-screen' });
  await act(async () => {
    tree.root.findByType(ChatScreen).props.onBack();
  });
  expect(tabs().map(t => t.props.accessibilityState.selected)).toEqual([
    false,
    true,
    false,
  ]);
  expect(tree.root.findAllByType(ChatScreen)).toHaveLength(0);
  await act(async () => {
    tabs()[2]!.props.onPress();
  });
  expect(tree.root.findByProps({ testID: 'settings-screen' })).toBeDefined();
  await act(async () => {
    tabs()[0]!.props.onPress();
  });
  expect(tabs()).toHaveLength(0);
  expect(tree.root.findByProps({ testID: 'direct-screen' })).not.toBe(direct);
  await act(async () => {
    tree.unmount();
  });
});

test.each(['chat', 'settings'])(
  'Atrás desde %s vuelve a conversaciones',
  async target => {
    const listener = jest.spyOn(BackHandler, 'addEventListener');
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(<App />);
    });
    if (target === 'settings') {
      await act(async () => {
        tree.root.findByType(ChatScreen).props.onBack();
      });
      await act(async () => {
        tree.root
          .findAll(
            node =>
              node.props.accessibilityRole === 'tab' &&
              typeof node.props.onPress === 'function',
            { deep: false },
          )[2]!
          .props.onPress();
      });
      expect(
        tree.root.findByProps({ testID: 'settings-screen' }),
      ).toBeDefined();
    }
    const back = [...listener.mock.calls]
      .reverse()
      .find(([name]) => name === 'hardwareBackPress')?.[1];
    expect(back).toBeDefined();
    await act(async () => {
      expect(back!({ type: 'hardwareBackPress', timeStamp: 0 })).toBe(true);
    });
    expect(tree.root.findAllByType(ChatScreen)).toHaveLength(0);
    expect(
      tree.root.findAllByProps({ testID: 'settings-screen' }),
    ).toHaveLength(0);
    expect(
      tree.root.findByProps({ testID: 'conversations-screen' }),
    ).toBeDefined();
    await act(async () => {
      tree.unmount();
    });
    listener.mockRestore();
  },
);
