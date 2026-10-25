import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedKeyboard,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

export interface RenameDialogProps {
  readonly visible: boolean;
  readonly initialName: string;
  readonly isWorking?: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (name: string) => void;
}

const MAX_NAME = 80;

const APPEAR = {
  duration: 180,
  easing: Easing.bezier(0.05, 0.7, 0.1, 1),
} as const;

/**
 * Diálogo propio, montado dentro del árbol de la app.
 *
 * No usa el `Modal` de React Native a propósito: en Android abre una ventana
 * nativa aparte, con sus propios insets y su propio manejo del teclado — que
 * es justo lo que costó trabajo domar en el chat. Una capa absoluta comparte
 * el layout de la pantalla y se comporta igual que el resto.
 */
export function RenameDialog({
  visible,
  initialName,
  isWorking = false,
  onCancel,
  onSubmit,
}: RenameDialogProps) {
  const [name, setName] = useState(initialName);
  const appear = useSharedValue(0);
  const keyboard = useAnimatedKeyboard();

  useEffect(() => {
    if (visible) {
      setName(initialName);
      appear.value = 0;
      appear.value = withTiming(1, APPEAR);
    }
  }, [visible, initialName, appear]);

  const scrimStyle = useAnimatedStyle(() => ({ opacity: appear.value * 0.45 }));

  const cardStyle = useAnimatedStyle(() => ({
    opacity: appear.value,
    transform: [
      { translateY: (1 - appear.value) * 16 - keyboard.height.value / 2 },
      { scale: 0.96 + appear.value * 0.04 },
    ],
  }));

  if (!visible) {
    return null;
  }

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== initialName && !isWorking;

  return (
    <View className="absolute inset-0 items-center justify-center px-8">
      <Animated.View style={scrimStyle} className="absolute inset-0 bg-black">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cerrar"
          onPress={onCancel}
          className="flex-1"
        />
      </Animated.View>

      <Animated.View
        style={cardStyle}
        className="w-full rounded-2xl bg-white p-5 shadow-lg shadow-black/40"
      >
        <Text className="text-base font-semibold text-slate-900">
          Renombrar sesión
        </Text>

        <TextInput
          value={name}
          onChangeText={setName}
          autoFocus
          selectTextOnFocus
          maxLength={MAX_NAME}
          returnKeyType="done"
          onSubmitEditing={() => canSubmit && onSubmit(trimmed)}
          editable={!isWorking}
          className="mt-4 rounded-xl border border-slate-300 bg-slate-50 px-3 py-2.5 text-base text-slate-900"
        />

        <Text className="mt-1.5 text-[11px] text-slate-400">
          {`${name.length}/${MAX_NAME}`}
        </Text>

        <View className="mt-5 flex-row justify-end gap-2">
          <Pressable
            accessibilityRole="button"
            onPress={onCancel}
            disabled={isWorking}
            className="rounded-xl px-4 py-2.5 active:bg-slate-100"
          >
            <Text className="text-sm font-semibold text-slate-600">
              Cancelar
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSubmit }}
            onPress={() => onSubmit(trimmed)}
            disabled={!canSubmit}
            className={`rounded-xl px-4 py-2.5 ${
              canSubmit ? 'bg-slate-900 active:opacity-70' : 'bg-slate-300'
            }`}
          >
            <Text className="text-sm font-semibold text-white">Guardar</Text>
          </Pressable>
        </View>
      </Animated.View>
    </View>
  );
}
