import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Markdown } from '../src/components/Markdown/Markdown';
import { SendMessageContext } from '../src/components/Markdown/SendMessageContext';
import { parseUiBlock } from '../src/lib/uiBlock';

jest.mock('react-native-gesture-handler', () => ({
  ScrollView: require('react-native').ScrollView,
}));
jest.mock('@react-native-clipboard/clipboard', () => ({
  setString: jest.fn(),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
}));
jest.mock('react-native-webview', () => {
  const { View } = require('react-native');
  return { WebView: (props: object) => <View testID="cx-html" {...props} /> };
});

const block = [
  'Antes',
  '```ui',
  'Texto **en negrita**',
  '<cx-stats><stat label="CPU" value="38%" delta="→ 1.1%" good/></cx-stats>',
  '<cx-choice label="Ignore list"><choice title="Hard-coded" recommended>Five lines.</choice><choice title="Gitignore">Parser.</choice></cx-choice>',
  '<cx-html><div>hola</div></cx-html>',
  '```',
].join('\n');

test('el parser es el mismo del escritorio', () => {
  expect(
    parseUiBlock('<cx-bars views="A,B" unit="%"><bar label="X" tone="red" values="63,2"/></cx-bars>'),
  ).toEqual([
    {
      kind: 'bars',
      label: '',
      views: ['A', 'B'],
      unit: '%',
      bars: [{ label: 'X', tone: 'red', values: [63, 2] }],
    },
  ]);
});

test('un bloque ```ui se dibuja como componentes, no como código', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<Markdown text={block} />);
  });
  const json = JSON.stringify(tree.toJSON());
  expect(json).toContain('38%');
  expect(json).toContain('Recommended');
  expect(json).not.toContain('cx-stats');
  expect(tree.root.findAllByProps({ testID: 'cx-html' }).length).toBeGreaterThan(0);
  await act(async () => tree.unmount());
});

test('elegir una opción y mandarla la envía como mensaje del usuario', async () => {
  const send = jest.fn();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <SendMessageContext.Provider value={send}>
        <Markdown text={block} />
      </SendMessageContext.Provider>,
    );
  });
  const radios = tree.root.findAll(
    node => node.props.accessibilityRole === 'radio' && typeof node.props.onPress === 'function',
  );
  await act(async () => radios[0]!.props.onPress());
  const button = tree.root.findAll(
    node =>
      node.props.accessibilityLabel === 'Send choice' &&
      typeof node.props.onPress === 'function',
  );
  expect(button.length).toBeGreaterThan(0);
  await act(async () => button[0]!.props.onPress());
  expect(send).toHaveBeenCalledWith('Ignore list: Hard-coded');
  await act(async () => tree.unmount());
});
