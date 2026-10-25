import { useEffect, useRef } from 'react';
import { Animated, Easing, Text, View } from 'react-native';

import { ThinkingBlock } from './ThinkingBlock';

export interface StreamingPreviewProps {
  /** Texto acumulado de la respuesta en curso. */
  readonly text: string;
  /** Razonamiento en curso, si el proveedor lo emite. */
  readonly thinking: string;
  /** El turno sigue abierto aunque no haya nada parcial que enseñar. */
  readonly isStreaming?: boolean;
}

/**
 * Se muestra la cola y no el principio: en un texto que crece, lo último
 * escrito es lo que interesa, y recortar acota el costo de layout.
 */
const TAIL_CHARS = 600;

function tail(text: string): string {
  return text.length <= TAIL_CHARS ? text : `…${text.slice(-TAIL_CHARS)}`;
}

/** Punto que late mientras el modelo escribe. */
function Pulse() {
  const opacity = useRef(new Animated.Value(0.25)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.25,
          duration: 600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={{ opacity }}
      className="h-1.5 w-1.5 rounded-full bg-slate-400"
    />
  );
}

export function StreamingPreview({
  text,
  thinking,
  isStreaming = false,
}: StreamingPreviewProps) {
  const hasThinking = thinking.trim().length > 0;
  const hasText = text.trim().length > 0;

  if (!hasThinking && !hasText) {
    // Mientras corre una herramienta no hay texto parcial: el turno sigue
    // abierto pero no hay nada que previsualizar. Sin esta señal la pantalla
    // se ve detenida justo cuando más está pasando.
    return isStreaming ? (
      <View className="flex-row items-center gap-1.5 px-4 py-1.5">
        <Pulse />
        <Text className="text-[11px] text-slate-400">trabajando…</Text>
      </View>
    ) : null;
  }

  return (
    <View>
      {/* Mismo componente que el razonamiento ya guardado: la única
          diferencia es la etiqueta y que el resumen sigue la última línea. */}
      {hasThinking ? <ThinkingBlock text={thinking} streaming /> : null}

      {hasText ? (
        <View className="px-3 py-1">
          <View className="max-w-[85%] self-start rounded-2xl rounded-bl-md border border-slate-200 bg-white px-3 py-2">
            <Text className="text-[13px] leading-5 text-slate-800">
              {tail(text)}
            </Text>
            <View className="mt-1 flex-row items-center gap-1.5">
              <Pulse />
              <Text className="text-[10px] text-slate-400">escribiendo</Text>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}
