import { useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { GlassTabBarItem } from './GlassTabBarItem';
import { NewChatIcon, ConversationsIcon, SettingsIcon } from './icons';
import type { GlassTabBarProps, TabItem } from './types';

export const DEFAULT_TAB_ITEMS: readonly TabItem[] = [
  { key: 'chat', label: 'Nuevo chat', Icon: NewChatIcon },
  { key: 'home', label: 'Conversaciones', Icon: ConversationsIcon },
  { key: 'settings', label: 'Ajustes', Icon: SettingsIcon },
];

/**
 * Radio de la píldora. Se repite en el recorte del blur porque la vista
 * nativa recorta su propia captura, no la hereda del padre.
 */
const RADIUS = 32;

/** Margen reservado alrededor de la barra para que el resplandor quepa. */
const GLOW = 14;

/**
 * El degradado del canto: encendido en las esquinas y casi apagado en medio.
 * Es lo que hace que se lea como luz reflejada y no como un borde pintado.
 */
const RIM_STOPS = [
  { offset: '0', color: '#22d3ee', opacity: 1 },
  { offset: '0.3', color: '#22d3ee', opacity: 0.14 },
  { offset: '0.5', color: '#94a3b8', opacity: 0.1 },
  { offset: '0.7', color: '#a855f7', opacity: 0.14 },
  { offset: '1', color: '#a855f7', opacity: 1 },
] as const;

interface RimProps {
  readonly width: number;
  readonly height: number;
  /** Los `<Defs>` son globales por documento: cada capa necesita el suyo. */
  readonly gradientId: string;
  readonly strokes: readonly {
    readonly width: number;
    readonly opacity: number;
  }[];
}

/** Contorno de la píldora, en una o varias pasadas. */
function Rim({ width, height, gradientId, strokes }: RimProps) {
  return (
    // El `pointerEvents` va en una `View` de RN y no en el `<Svg>`: la capa
    // del filo se dibuja encima de la barra, y si se quedara con los toques
    // los botones dejarían de responder.
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
            {RIM_STOPS.map(stop => (
              <Stop
                key={stop.offset}
                offset={stop.offset}
                stopColor={stop.color}
                stopOpacity={stop.opacity}
              />
            ))}
          </LinearGradient>
        </Defs>
        {strokes.map(stroke => (
          <Rect
            key={stroke.width}
            x={GLOW}
            y={GLOW}
            width={width - GLOW * 2}
            height={height - GLOW * 2}
            rx={RADIUS}
            ry={RADIUS}
            fill="none"
            stroke={`url(#${gradientId})`}
            strokeWidth={stroke.width}
            strokeOpacity={stroke.opacity}
          />
        ))}
      </Svg>
    </View>
  );
}

/**
 * Sin desenfoque gaussiano en SVG que rinda en Android, el resplandor se
 * aproxima apilando contornos: cada pasada es más ancha y más tenue, y juntas
 * se leen como una caída de luz.
 */
const GLOW_STROKES = [
  { width: 18, opacity: 0.05 },
  { width: 10, opacity: 0.09 },
  { width: 5, opacity: 0.14 },
] as const;

/** Una sola pasada fina y a plena opacidad: el filo de la píldora. */
const RIM_STROKES = [{ width: 1.6, opacity: 0.95 }] as const;

/**
 * Barra flotante negra con el canto encendido.
 *
 * Hubo dos intentos antes: translucidez por capas y luego desenfoque real del
 * fondo. Los dos dependían de un brillo en la mitad superior para fingir
 * volumen, y ese degradado de arriba clara a abajo oscura es exactamente lo
 * que fecha el diseño. Negro plano y toda la luz en el borde.
 *
 * El resplandor va debajo de la píldora y el filo encima: si ambos fueran
 * encima, la mitad interior del trazo ancho pintaría una banda dentro de la
 * barra en vez de quedarse en el borde.
 */
export function GlassTabBar({
  activeKey,
  onChange,
  items = DEFAULT_TAB_ITEMS,
}: GlassTabBarProps) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize(current =>
      current.width === width && current.height === height
        ? current
        : { width, height },
    );
  };

  const hasSize = size.width > 0 && size.height > 0;

  return (
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0 bottom-0 items-center pb-8"
    >
      {/* El relleno reserva sitio al resplandor dentro de los límites de esta
          vista: Android recorta lo que se dibuja fuera de su padre. */}
      <View style={{ padding: GLOW }} onLayout={onLayout}>
        {hasSize ? (
          <Rim
            width={size.width}
            height={size.height}
            gradientId="tabBarGlow"
            strokes={GLOW_STROKES}
          />
        ) : null}

        <View
          accessibilityRole="tablist"
          style={{ borderRadius: RADIUS }}
          className="overflow-hidden bg-black"
        >
          <View className="flex-row items-center gap-1 px-2.5 py-2">
            {items.map(item => (
              <GlassTabBarItem
                key={item.key}
                item={item}
                isActive={item.key === activeKey}
                onPress={() => onChange(item.key)}
              />
            ))}
          </View>
        </View>

        {hasSize ? (
          <Rim
            width={size.width}
            height={size.height}
            gradientId="tabBarRim"
            strokes={RIM_STROKES}
          />
        ) : null}
      </View>
    </View>
  );
}
