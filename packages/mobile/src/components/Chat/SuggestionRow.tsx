import { Pressable, ScrollView, Text, View } from 'react-native';

import type { Suggestion } from '../../api/suggestions';

export interface SuggestionRowProps {
  readonly suggestions: Suggestion[];
  /** Toque simple: se envía tal cual. */
  readonly onSend: (text: string) => void;
  /** Toque largo: se mete en el input para editarla antes. */
  readonly onEdit: (text: string) => void;
}

/**
 * Fila de respuestas sugeridas sobre el composer.
 *
 * El orden llega fijo desde el bridge —continuar, cuestionar, redirigir— y no
 * se reordena aquí: la posición es lo que permite tocar sin leer cuando ya te
 * acostumbraste.
 */
export function SuggestionRow({ suggestions, onSend, onEdit }: SuggestionRowProps) {
  if (suggestions.length === 0) {
    return null;
  }

  return (
    <View pointerEvents="box-none">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-2 px-3 pb-2"
      >
        {suggestions.map(suggestion => (
          <Pressable
            key={suggestion.kind}
            accessibilityRole="button"
            accessibilityLabel={`Enviar: ${suggestion.text}`}
            accessibilityHint="Mantén pulsado para editarla antes de enviar"
            onPress={() => onSend(suggestion.text)}
            onLongPress={() => onEdit(suggestion.text)}
            delayLongPress={300}
            className="rounded-full border border-slate-300 bg-white px-3.5 py-2 shadow-sm shadow-slate-900/5 active:bg-slate-100"
          >
            <Text className="text-[12.5px] font-semibold text-slate-700">
              {suggestion.text}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
