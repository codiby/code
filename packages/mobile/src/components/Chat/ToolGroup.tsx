import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { truncate } from '../../lib/ansi';
import {
  summarizeGroup,
  summarizeResult,
  summarizeTool,
  type GroupEntry,
  type ResultTone,
} from '../../lib/chatItems';
import Svg, { Path } from 'react-native-svg';

import { useInk } from '../../theme';
import { ChatImages } from './ChatImage';
import { ThinkingBlock } from './ThinkingBlock';

export interface ToolGroupProps {
  readonly entries: GroupEntry[];
  /**
   * `footer` cuelga del mensaje que provocó las herramientas: sin margen
   * propio y con una línea fina que lo separa del texto de la burbuja.
   */
  readonly variant?: 'standalone' | 'footer';
}

const TONE_CLASS: Record<ResultTone, string> = {
  ok: 'text-emerald-600',
  bad: 'text-rose-600',
  muted: 'text-slate-400',
};

/** Un solo icono gris: el color se reserva para lo que de verdad importa. */
function ToolsIcon({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      <Path
        d="M2.5 4.5 6 7.5l-3.5 3M8 11.5h5.5"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

function ToolRow({
  entry,
}: {
  readonly entry: Extract<GroupEntry, { kind: 'tool' }>;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const { title, detail } = summarizeTool(entry.call);
  const result = summarizeResult(entry.call, entry.output);
  const output = entry.output?.content.trim() ?? '';
  const images = entry.output?.images ?? [];

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: isOpen }}
        onPress={() => setIsOpen(current => !current)}
        className="flex-row items-center gap-2 py-1 active:opacity-60"
      >
        <View className="h-1 w-1 rounded-full bg-slate-400" />
        <Text numberOfLines={1} className="min-w-0 flex-1 text-[12px] text-slate-500">
          {title}
        </Text>
        {result !== null ? (
          <Text className={`text-[10px] font-semibold ${TONE_CLASS[result.tone]}`}>
            {result.label}
          </Text>
        ) : null}
      </Pressable>

      {isOpen ? (
        <View className="pb-1.5 pl-4">
          {detail !== null ? (
            <Text className="rounded-md bg-slate-100 px-2 py-1 font-mono text-[10px] leading-4 text-slate-600">
              {detail}
            </Text>
          ) : null}

          <ChatImages images={images} />

          {output.length > 0 ? (
            <Text className="mt-1 border-l-2 border-slate-200 pl-2 font-mono text-[10px] leading-[15px] text-slate-500">
              {truncate(output, 4000, 200).text}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Resumen de una línea sobre el fondo del hilo — sin tarjeta ni borde, para
 * que pese lo mismo que el razonamiento y no compita con lo que el agente
 * dice. Los nombres, en vez de un conteo, permiten saltárselo sin abrirlo.
 */
export function ToolGroup({ entries, variant = 'standalone' }: ToolGroupProps) {
  const ink = useInk();
  const [isOpen, setIsOpen] = useState(false);
  const { label, phrase, elapsed, failures } = summarizeGroup(entries);

  const meta = [elapsed, failures > 0 ? `${failures} failed` : null].filter(
    (part): part is string => part !== null,
  );

  return (
    <View
      className={
        variant === 'footer' ? 'mt-1.5' : 'px-[18px] py-1'
      }
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: isOpen }}
        onPress={() => setIsOpen(current => !current)}
        className="flex-row items-center gap-2 py-1 active:opacity-60"
      >
        <ToolsIcon size={14} color={ink('#94a3b8')} />
        <Text
          numberOfLines={1}
          className="min-w-0 flex-1 text-[12.5px] text-slate-500"
        >
          {phrase}
        </Text>

        {meta.length > 0 ? (
          <Text
            className={`text-[11.5px] ${
              failures > 0 ? 'text-rose-600' : 'text-slate-400'
            }`}
          >
            {meta.join(' · ')}
          </Text>
        ) : null}
      </Pressable>

      {isOpen ? (
        <View className="ml-[6px] border-l border-slate-200 pl-3">
          {entries.map((entry, index) =>
            entry.kind === 'thinking' ? (
              <ThinkingBlock
                key={entry.message.id}
                text={entry.message.content}
                redacted={entry.message.thinkingRedacted}
                compact
              />
            ) : (
              <ToolRow key={`${entry.call.id}-${index}`} entry={entry} />
            ),
          )}
        </View>
      ) : null}
    </View>
  );
}
