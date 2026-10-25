import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import {
  PanResponder,
  Text,
  type GestureResponderEvent,
  type PanResponderGestureState,
} from 'react-native';
import { SwipeToReply } from '../src/components/Chat/SwipeToReply';

test('solo un deslizamiento horizontal suficiente activa responder; cancelar y scroll no', async () => {
  const spy = jest.spyOn(PanResponder, 'create');
  const onReply = jest.fn();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <SwipeToReply onReply={onReply}>
        <Text>Mensaje</Text>
      </SwipeToReply>,
    );
  });
  const handlers = spy.mock.calls[0]![0];
  const event = {} as GestureResponderEvent;
  const gesture = (dx: number, dy = 0) =>
    ({ dx, dy, numberActiveTouches: 1 } as PanResponderGestureState);
  expect(
    handlers.onMoveShouldSetPanResponderCapture!(event, gesture(2, 60)),
  ).toBe(false);
  expect(
    handlers.onMoveShouldSetPanResponderCapture!(event, gesture(-80)),
  ).toBe(false);
  expect(handlers.onMoveShouldSetPanResponderCapture!(event, gesture(60))).toBe(
    true,
  );
  await act(async () => {
    handlers.onPanResponderRelease!(event, gesture(30));
    handlers.onPanResponderTerminate!(event, gesture(90));
    handlers.onPanResponderRelease!(event, gesture(60, 90));
  });
  expect(onReply).not.toHaveBeenCalled();
  await act(async () => {
    handlers.onPanResponderRelease!(event, gesture(70));
  });
  expect(onReply).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
  spy.mockRestore();
});
