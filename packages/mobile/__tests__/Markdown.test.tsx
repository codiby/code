import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import {
  PanResponder,
  ScrollView,
  type GestureResponderEvent,
  type PanResponderGestureState,
} from 'react-native';
import { Markdown } from '../src/components/Markdown/Markdown';
import { SwipeToReply } from '../src/components/Chat/SwipeToReply';

jest.mock('react-native-gesture-handler', () => ({
  ScrollView: require('react-native').ScrollView,
}));
jest.mock('@react-native-clipboard/clipboard', () => ({
  setString: jest.fn(),
}));

const table =
  '| Columna A | Columna B | Columna C |\n|---|---|---|\n| Uno | Dos | Tres |';

test('la tabla no añade botones ni instrucciones para desplazarse', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<Markdown text={table} />);
  });
  expect(
    tree.root.findAll(node =>
      String(node.props.accessibilityLabel ?? '').startsWith('Desplazar tabla'),
    ),
  ).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).not.toContain(
    'Desliza o usa las flechas',
  );
  await act(async () => tree.unmount());
});

test('arrastrar una tabla no captura responder; el siguiente gesto fuera de ella sí', async () => {
  const spy = jest.spyOn(PanResponder, 'create');
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <SwipeToReply onReply={jest.fn()}>
        <Markdown text={table} />
      </SwipeToReply>,
    );
  });
  const handlers = spy.mock.calls[0]![0];
  const event = {} as GestureResponderEvent;
  const gesture = {
    dx: 70,
    dy: 5,
    numberActiveTouches: 1,
  } as PanResponderGestureState;
  const capture = () =>
    handlers.onMoveShouldSetPanResponderCapture!(event, gesture);
  const scroll = tree.root.findByType(ScrollView);
  // La captura de touchStart recorre primero el contenedor y después la tabla.
  const starts = tree.root.findAll(
    node => typeof node.props.onTouchStartCapture === 'function',
    { deep: false },
  );
  expect(starts.length).toBeGreaterThan(0);
  starts[0]!.props.onTouchStartCapture(event);
  expect(capture()).toBe(true);
  scroll.props.onTouchStartCapture(event);
  expect(capture()).toBe(false);
  // La tabla mantiene el gesto incluso si el dedo sale de sus límites.
  expect(capture()).toBe(false);
  starts[0]!.props.onTouchStartCapture(event);
  expect(capture()).toBe(true);
  await act(async () => tree.unmount());
  spy.mockRestore();
});
