import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { SparkIcon } from './icons';

export interface ThinkingBlockProps {
  readonly text: string;
  /** true mientras el bloque se está escribiendo. */
  readonly streaming?: boolean;
  /** El proveedor cifró el razonamiento. */
  readonly redacted?: boolean;
  /** Sin margen horizontal: dentro de un grupo ya lo pone el contenedor. */
  readonly compact?: boolean;
}

const PREVIEW_CHARS = 90;

/**
 * Mientras razona, el resumen sigue el borde de avance (la última línea), así
 * el bloque se ve vivo. Ya asentado se queda con la primera, que describe de
 * qué iba. Es la misma regla que usa la app de escritorio.
 */
function previewOf(text: string, streaming: boolean): string {
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  const source = (streaming ? lines[lines.length - 1] : lines[0]) ?? '';
  return source.length > PREVIEW_CHARS
    ? `${source.slice(0, PREVIEW_CHARS - 1)}…`
    : source;
}

/**
 * Razonamiento colapsado: una sola línea que se despliega al tocarla. No es
 * una burbuja de chat — el razonamiento no es un turno de la conversación.
 */
export function ThinkingBlock({
  text,
  streaming = false,
  redacted = false,
  compact = false,
}: ThinkingBlockProps) {
  const [isOpen, setIsOpen] = useState(false);

  const label = streaming
    ? 'Pensando'
    : redacted
      ? 'Pensamiento cifrado'
      : 'Pensó';
  const preview = previewOf(text, streaming);

  return (
    <View className={compact ? 'py-0.5' : 'px-3 py-1'}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}. ${isOpen ? 'Contraer' : 'Expandir'}`}
        accessibilityState={{ expanded: isOpen }}
        onPress={() => setIsOpen(current => !current)}
        className="flex-row items-start gap-1.5 py-0.5 active:opacity-60"
      >
        <View className="mt-0.5">
          <SparkIcon size={12} color={streaming ? '#a78bfa' : '#94a3b8'} />
        </View>
        <Text className="mt-px shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          {label}
        </Text>
        {!isOpen && preview.length > 0 ? (
          <Text
            numberOfLines={1}
            className="ml-1 min-w-0 flex-1 text-[12px] italic text-slate-400"
          >
            {preview}
          </Text>
        ) : null}
      </Pressable>

      {isOpen ? (
        <View className="ml-[18px] mt-1 border-l border-slate-300 pl-2.5">
          <Text className="text-[12px] italic leading-5 text-slate-500">
            {text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
