import { Pressable, Text, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

export interface MockupCardProps {
  readonly name: string;
  /** Ausente en una pantalla que no puede abrir el visor: la fila se queda,
   *  pero sin botón — decir que hay un mockup sigue valiendo. */
  readonly onOpen?: (name: string) => void;
}

/** Ventana con una barra arriba: lo que hay detrás es una pantalla. */
function ScreenIcon({ color }: { readonly color: string }) {
  return (
    <Svg width={15} height={15} viewBox="0 0 24 24">
      <Rect
        x={3}
        y={4.5}
        width={18}
        height={15}
        rx={2.5}
        stroke={color}
        strokeWidth={1.9}
        fill="none"
      />
      <Path d="M3 9h18" stroke={color} strokeWidth={1.9} fill="none" />
    </Svg>
  );
}

/**
 * Fila propia para un mockup del hilo.
 *
 * Fuera del acordeón de herramientas a propósito: el resto del grupo son
 * resultados que se leen si hacen falta, y esto es lo único que hay que
 * abrir. Plegado tras «7 herramientas» obligaba a desplegar y buscar la fila
 * correcta para encontrar el botón.
 */
export function MockupCard({ name, onOpen }: MockupCardProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Abrir el mockup ${name}`}
      onPress={() => onOpen?.(name)}
      disabled={onOpen === undefined}
      className="my-1 flex-row items-center gap-2.5 self-start rounded-2xl border border-slate-200 bg-white px-3 py-2 active:bg-slate-50"
    >
      <ScreenIcon color="#7c3aed" />
      <View>
        <Text className="text-[9.5px] font-bold uppercase tracking-widest text-violet-500">
          Mockup
        </Text>
        <Text className="text-[13px] font-semibold text-slate-900">{name}</Text>
      </View>
      {onOpen !== undefined ? (
        <View className="ml-1 rounded-full bg-slate-900 px-2.5 py-1">
          <Text className="text-[10px] font-bold text-white">Ver</Text>
        </View>
      ) : null}
    </Pressable>
  );
}
