import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { PermissionRequest } from '../../api/types';
import { shortToolName } from '../../lib/chatItems';

export interface PermissionCardProps {
  readonly request: PermissionRequest;
  readonly onRespond: (allow: boolean) => void;
  readonly isBusy?: boolean;
}

/** Argumentos como `clave  valor`, alineados en monoespaciado. */
function formatInput(input: Record<string, unknown>): string[] {
  return Object.entries(input)
    .slice(0, 6)
    .map(([key, value]) => {
      const text =
        typeof value === 'string' ? value : JSON.stringify(value ?? null);
      return `${key}  ${text.length > 90 ? `${text.slice(0, 90)}…` : text}`;
    });
}

/**
 * Misma forma que una burbuja del asistente; solo cambia el color del borde y
 * la etiqueta. La descripción va cerrada, con el mismo gesto que el bloque de
 * razonamiento — suele ser el prompt entero de la skill.
 */
export function PermissionCard({
  request,
  onRespond,
  isBusy = false,
}: PermissionCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const args = formatInput(request.input);

  return (
    <View className="items-start px-3 py-1">
      <View className="max-w-[88%] rounded-2xl rounded-bl-md border border-amber-300 bg-white px-3 py-2.5">
        <View className="flex-row items-center gap-1.5">
          <View className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          <Text className="text-[9.5px] font-bold uppercase tracking-wide text-amber-700">
            Pide permiso
          </Text>
        </View>

        <Text className="mt-1.5 text-[13px] font-semibold text-slate-900">
          {shortToolName(request.toolName)}
        </Text>

        {args.length > 0 ? (
          <View className="mt-1.5 rounded-lg bg-slate-50 px-2 py-1.5">
            {args.map(line => (
              <Text
                key={line}
                className="font-mono text-[10px] leading-4 text-slate-600"
              >
                {line}
              </Text>
            ))}
          </View>
        ) : null}

        {request.description !== null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: isOpen }}
            onPress={() => setIsOpen(current => !current)}
            className="mt-2 flex-row items-start gap-1.5 active:opacity-60"
          >
            <Text className="mt-0.5 text-[9px] text-slate-300">
              {isOpen ? '▾' : '▸'}
            </Text>
            <Text
              numberOfLines={isOpen ? undefined : 1}
              className="flex-1 text-[11.5px] leading-[17px] text-slate-400"
            >
              {request.description}
            </Text>
          </Pressable>
        ) : null}

        <View className="mt-3 flex-row items-center justify-end gap-1">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Denegar"
            onPress={() => onRespond(false)}
            disabled={isBusy}
            className="rounded-lg px-3.5 py-2 active:bg-slate-100"
          >
            <Text className="text-[12.5px] font-semibold text-slate-600">
              Denegar
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Permitir"
            onPress={() => onRespond(true)}
            disabled={isBusy}
            className={`rounded-lg px-3.5 py-2 ${
              isBusy ? 'bg-slate-400' : 'bg-slate-900 active:opacity-70'
            }`}
          >
            <Text className="text-[12.5px] font-semibold text-white">
              Permitir
            </Text>
          </Pressable>
        </View>

        {/* No es «salta esta herramienta»: el bridge llama a interrupt(). */}
        <Text className="mt-1 text-right text-[9.5px] text-slate-300">
          denegar interrumpe el turno
        </Text>
      </View>
    </View>
  );
}
