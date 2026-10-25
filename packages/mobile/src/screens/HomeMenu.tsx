import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface HomeMenuProps {
  readonly visible: boolean;
  readonly isWorking: boolean;
  /** Cuántas sueltas se moverían; en 0 la opción se ve pero no responde. */
  readonly loose: number;
  readonly onClose: () => void;
  readonly onAutoGroup: () => void;
}

/**
 * Menú de los tres puntos del encabezado.
 *
 * Va anclado arriba a la derecha en vez de subir desde abajo como las otras
 * hojas: sale de un botón que está ahí, y aparecer en el extremo contrario
 * rompería la relación con lo que se tocó.
 */
export function HomeMenu({
  visible,
  isWorking,
  loose,
  onClose,
  onAutoGroup,
}: HomeMenuProps) {
  const insets = useSafeAreaInsets();
  const enabled = loose > 0 && !isWorking;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cerrar menú"
        onPress={onClose}
        className="flex-1"
      />
      <View
        // El desplazamiento deja el panel justo bajo la fila del título, que en
        // este estado tiene altura fija.
        style={{ top: insets.top + 58 }}
        className="absolute right-3 w-64 rounded-2xl bg-white py-1.5 shadow-lg"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !enabled }}
          onPress={onAutoGroup}
          disabled={!enabled}
          className="flex-row items-center gap-3 px-4 py-3 active:bg-slate-50"
        >
          <View className="flex-1">
            <Text
              className={`text-[14.5px] font-semibold ${
                enabled ? 'text-slate-900' : 'text-slate-400'
              }`}
            >
              Auto agrupar
            </Text>
            <Text className="mt-0.5 text-[11.5px] leading-4 text-slate-400">
              {loose === 0
                ? 'No hay sesiones sueltas'
                : `Ordena ${loose} ${
                    loose === 1 ? 'sesión suelta' : 'sesiones sueltas'
                  } por su carpeta`}
            </Text>
          </View>
          {isWorking ? <ActivityIndicator size="small" color="#64748b" /> : null}
        </Pressable>
      </View>
    </Modal>
  );
}
