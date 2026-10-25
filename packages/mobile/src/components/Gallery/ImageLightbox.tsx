import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CloseIcon } from '../SessionList';

export interface LightboxItem {
  readonly id: string;
  readonly uri: string;
  readonly name: string;
}

export interface ImageLightboxProps {
  readonly items: LightboxItem[];
  readonly initialIndex: number;
  readonly onClose: () => void;
}

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;

/** Deja el desplazamiento dentro de ±`limit`. */
function clamp(value: number, limit: number): number {
  'worklet';
  return Math.min(Math.max(value, -limit), limit);
}

/**
 * Una imagen con pellizco y arrastre.
 *
 * El zoom se implementa aquí en vez de con una librería: las cuatro que hay
 * llevan dos años sin publicarse, y la más completa pide `reanimated ^3.2`
 * cuando este proyecto usa la 4.6 — justo el salto donde los worklets se
 * movieron a su propio paquete.
 */
function ZoomableImage({
  item,
  onZoomChange,
  onToggleChrome,
}: {
  readonly item: LightboxItem;
  readonly onZoomChange: (zoomed: boolean) => void;
  readonly onToggleChrome: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const [isZoomed, setIsZoomed] = useState(false);

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);

  const report = useCallback(
    (zoomed: boolean) => {
      setIsZoomed(zoomed);
      onZoomChange(zoomed);
    },
    [onZoomChange],
  );

  /**
   * Cuánto se puede correr la imagen sin descubrir un borde.
   *
   * El `transform` lleva la escala después del desplazamiento, así que este
   * vive en píxeles de pantalla: la mitad de lo que sobresale del marco.
   */
  const limits = (value: number) => {
    'worklet';
    return {
      x: Math.max((width * value - width) / 2, 0),
      y: Math.max((height * value - height) / 2, 0),
    };
  };

  const reset = () => {
    'worklet';
    scale.value = withTiming(1);
    savedScale.value = 1;
    translateX.value = withTiming(0);
    translateY.value = withTiming(0);
    savedX.value = 0;
    savedY.value = 0;
  };

  const pinch = Gesture.Pinch()
    .onUpdate(event => {
      scale.value = Math.min(
        Math.max(savedScale.value * event.scale, 0.8),
        MAX_SCALE,
      );
    })
    .onEnd(() => {
      if (scale.value <= 1) {
        reset();
      } else {
        savedScale.value = scale.value;
        // Al cerrar el zoom el margen se encoge, y lo que ya estaba corrido
        // puede quedar fuera: se reencuadra en lugar de dejar un borde negro.
        const max = limits(scale.value);
        translateX.value = withTiming(clamp(translateX.value, max.x));
        translateY.value = withTiming(clamp(translateY.value, max.y));
        savedX.value = clamp(translateX.value, max.x);
        savedY.value = clamp(translateY.value, max.y);
      }
      // Es un setState de React: llamarlo directo desde el worklet revienta
      // con «Tried to synchronously call a Remote Function».
      runOnJS(report)(scale.value > 1);
    });

  /**
   * Deshabilitado sin zoom, no solo inerte.
   *
   * Con `.enabled(false)` el gesto ni siquiera compite por el toque, y el
   * arrastre horizontal llega a la lista. Antes salía temprano dentro del
   * `onUpdate`, pero para entonces ya había reclamado el evento — por eso no
   * se podía deslizar entre imágenes.
   */
  const pan = Gesture.Pan()
    .enabled(isZoomed)
    .onUpdate(event => {
      const max = limits(scale.value);
      translateX.value = clamp(savedX.value + event.translationX, max.x);
      translateY.value = clamp(savedY.value + event.translationY, max.y);
    })
    .onEnd(() => {
      savedX.value = translateX.value;
      savedY.value = translateY.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    // Sin un límite de distancia el toque solo se rinde al agotar sus 500 ms,
    // y el arrastre —que espera a que falle— sale muerto medio segundo. Con
    // esto se descarta en cuanto el dedo se mueve doce píxeles.
    .maxDistance(12)
    .onEnd(() => {
      if (scale.value > 1) {
        reset();
        runOnJS(report)(false);
      } else {
        scale.value = withTiming(DOUBLE_TAP_SCALE);
        savedScale.value = DOUBLE_TAP_SCALE;
        runOnJS(report)(true);
      }
    });

  /**
   * El toque simple espera a que el doble falle, si no cada doble toque
   * apagaría la barra de paso. Ese retraso —los 500 ms de `maxDelayMs`— es el
   * mismo que se siente en WhatsApp al ocultar la barra.
   */
  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .maxDistance(12)
    .onEnd(() => {
      runOnJS(onToggleChrome)();
    });

  const gesture = Gesture.Simultaneous(
    pinch,
    Gesture.Exclusive(doubleTap, singleTap, pan),
  );

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View style={{ width, height }} className="items-center justify-center">
        <Animated.Image
          source={{ uri: item.uri }}
          resizeMode="contain"
          style={[{ width, height }, style]}
        />
      </View>
    </GestureDetector>
  );
}

/** Visor a pantalla completa: se desliza entre imágenes y cada una hace zoom. */
export function ImageLightbox({
  items,
  initialIndex,
  onClose,
}: ImageLightboxProps) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const [index, setIndex] = useState(initialIndex);
  const [isZoomed, setIsZoomed] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const pagerRef = useRef<FlatList<LightboxItem>>(null);

  const onScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      setIndex(Math.round(event.nativeEvent.contentOffset.x / width));
    },
    [width],
  );

  const chrome = useSharedValue(1);
  const toggleChrome = useCallback(() => setChromeVisible(shown => !shown), []);

  useEffect(() => {
    chrome.value = withTiming(chromeVisible ? 1 : 0, { duration: 180 });
  }, [chrome, chromeVisible]);

  const chromeStyle = useAnimatedStyle(() => ({ opacity: chrome.value }));

  return (
    <View className="absolute inset-0 bg-black">
      <FlatList
        ref={pagerRef}
        data={items}
        keyExtractor={item => item.id}
        horizontal
        pagingEnabled
        scrollEnabled={!isZoomed}
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={initialIndex}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        onMomentumScrollEnd={onScrollEnd}
        renderItem={({ item }) => (
          <ZoomableImage
            item={item}
            onZoomChange={setIsZoomed}
            onToggleChrome={toggleChrome}
          />
        )}
      />

      {/* `pointerEvents` importa: sin él, el botón de cerrar sigue recibiendo
          toques mientras está invisible y se sale del visor sin querer. */}
      <Animated.View
        pointerEvents={chromeVisible ? 'auto' : 'none'}
        style={[chromeStyle, { paddingTop: insets.top + 8 }]}
        className="absolute inset-x-0 top-0 flex-row items-center gap-2 bg-black/55 px-2 pb-3"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cerrar"
          onPress={onClose}
          className="h-9 w-9 items-center justify-center rounded-full active:bg-white/15"
        >
          <CloseIcon size={20} color="#ffffff" />
        </Pressable>
        <Text numberOfLines={1} className="flex-1 text-[13px] text-white/80">
          {items[index]?.name ?? ''}
        </Text>
        {items.length > 1 ? (
          <Text className="text-[12px] text-white/60">
            {`${index + 1}/${items.length}`}
          </Text>
        ) : null}
      </Animated.View>
    </View>
  );
}
