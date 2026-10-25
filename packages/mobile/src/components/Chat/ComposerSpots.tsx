import { useEffect } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

/**
 * Luces de ambiente en el composer mientras la sesión responde.
 *
 * Es el equivalente de `.composer-spot` del escritorio, que ahí son cuatro
 * puntos difuminados rebotando en pares. Dos diferencias obligadas: en React
 * Native no existe `mix-blend-mode: plus-lighter`, así que no se pueden sumar
 * las luces donde se cruzan; y no hay filtro de desenfoque sobre una vista, así
 * que la caída suave se dibuja con un degradado radial en SVG en vez de
 * emborronar un círculo sólido.
 */
/** Fuera del JSX: un literal ahí dentro dispara `no-inline-styles`. */
const ABSOLUTE = { position: 'absolute' } as const;

const SPOTS = [
  { color: '#38bdf8', size: 96, top: 0.3, from: -0.15, to: 0.55, ms: 12_000 },
  { color: '#a855f7', size: 88, top: 0.7, from: 0.5, to: 1.05, ms: 15_000 },
  { color: '#22d3ee', size: 72, top: 0.55, from: 0.15, to: 0.85, ms: 9_500 },
] as const;

function Spot({
  spot,
  width,
  height,
}: {
  readonly spot: (typeof SPOTS)[number];
  readonly width: number;
  readonly height: number;
}) {
  const progress = useSharedValue(0);

  useEffect(() => {
    // `-1` es repetir sin fin y `true` invertir en cada vuelta: sin eso el
    // punto saltaría de vuelta al inicio en vez de rebotar.
    progress.value = withRepeat(
      withTiming(1, { duration: spot.ms, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [progress, spot.ms]);

  const style = useAnimatedStyle(() => ({
    transform: [
      {
        translateX:
          (spot.from + (spot.to - spot.from) * progress.value) * width -
          spot.size / 2,
      },
    ],
  }));

  return (
    <Animated.View
      style={[
        style,
        ABSOLUTE,
        {
          top: spot.top * height - spot.size / 2,
          width: spot.size,
          height: spot.size,
        },
      ]}
    >
      <Svg width={spot.size} height={spot.size}>
        <Defs>
          <RadialGradient id={`s${spot.color}`} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={spot.color} stopOpacity={0.55} />
            <Stop offset="0.45" stopColor={spot.color} stopOpacity={0.22} />
            <Stop offset="1" stopColor={spot.color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle
          cx={spot.size / 2}
          cy={spot.size / 2}
          r={spot.size / 2}
          fill={`url(#s${spot.color})`}
        />
      </Svg>
    </Animated.View>
  );
}

export function ComposerSpots({ height }: { readonly height: number }) {
  const { width } = useWindowDimensions();

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {SPOTS.map(spot => (
        <Spot key={spot.color} spot={spot} width={width} height={height} />
      ))}
    </View>
  );
}
