import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import { Animated, PanResponder, Text, View } from 'react-native';
import { HorizontalScrollGestureContext } from '../ScrollGestureContext';

export function SwipeToReply({
  children,
  onReply,
}: {
  readonly children: ReactNode;
  readonly onReply?: () => void;
}) {
  const offset = useRef(new Animated.Value(0)).current;
  const horizontalTouch = useRef(false);
  const claimHorizontalTouch = useCallback(() => {
    horizontalTouch.current = true;
  }, []);
  const replyRef = useRef(onReply);
  replyRef.current = onReply;
  const responder = useMemo(() => {
    const reset = () =>
      Animated.spring(offset, {
        toValue: 0,
        useNativeDriver: true,
        speed: 28,
        bounciness: 0,
      }).start();
    return PanResponder.create({
      onMoveShouldSetPanResponderCapture: (
        _,
        { dx, dy, numberActiveTouches },
      ) =>
        !horizontalTouch.current &&
        Boolean(replyRef.current) &&
        numberActiveTouches === 1 &&
        dx > 12 &&
        dx > Math.abs(dy) * 1.8,
      onPanResponderMove: (_, { dx }) =>
        offset.setValue(Math.max(0, Math.min(dx, 80))),
      onPanResponderRelease: (_, { dx, dy }) => {
        reset();
        if (dx >= 56 && dx > Math.abs(dy) * 1.8) {
          replyRef.current?.();
        }
      },
      onPanResponderTerminate: reset,
    });
  }, [offset]);

  return (
    <HorizontalScrollGestureContext.Provider value={claimHorizontalTouch}>
      <View
        {...responder.panHandlers}
        onTouchStartCapture={() => {
          horizontalTouch.current = false;
        }}
      >
        <Animated.View
          pointerEvents="none"
          style={{
            opacity: offset.interpolate({
              inputRange: [0, 56],
              outputRange: [0, 1],
              extrapolate: 'clamp',
            }),
          }}
          className="absolute inset-y-0 left-3 justify-center"
        >
          <Text className="text-xl text-emerald-600">↩</Text>
        </Animated.View>
        <Animated.View style={{ transform: [{ translateX: offset }] }}>
          {children}
        </Animated.View>
      </View>
    </HorizontalScrollGestureContext.Provider>
  );
}
