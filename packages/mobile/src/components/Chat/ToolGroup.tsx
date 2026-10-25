import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { truncate } from '../../lib/ansi';
import {
  summarizeGroup,
  summarizeResult,
  summarizeTool,
  THINKING_LABEL,
  type GroupEntry,
  type ResultTone,
} from '../../lib/chatItems';
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

/** Un color por familia. El razonamiento tiene el suyo, igual que el destello. */
const KIND_COLORS: Record<string, string> = {
  Bash: '#0f172a',
  Edit: '#7c3aed',
  Write: '#15803d',
  Read: '#0369a1',
  Grep: '#b45309',
  Glob: '#b45309',
  [THINKING_LABEL]: '#a78bfa',
};

const DEFAULT_COLOR = '#94a3b8';

const TONE_CLASS: Record<ResultTone, string> = {
  ok: 'text-emerald-600',
  bad: 'text-rose-600',
  muted: 'text-slate-400',
};

const MAX_DOTS = 5;

function colorFor(kind: string): string {
  return KIND_COLORS[kind] ?? DEFAULT_COLOR;
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
        <View
          style={{ backgroundColor: colorFor(entry.call.toolName ?? '') }}
          className="h-2 w-2 rounded-sm"
        />
        <Text numberOfLines={1} className="min-w-0 flex-1 text-[11.5px] text-slate-500">
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
  const [isOpen, setIsOpen] = useState(false);
  const { label, kinds, elapsed, failures } = summarizeGroup(entries);

  const meta = [elapsed, failures > 0 ? `${failures} falló` : null].filter(
    (part): part is string => part !== null,
  );

  return (
    <View
      className={
        variant === 'footer'
          ? 'mt-1.5 border-t border-slate-100 pt-0.5'
          : 'px-3 py-0.5'
      }
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: isOpen }}
        onPress={() => setIsOpen(current => !current)}
        className="flex-row items-center gap-1.5 py-1 active:opacity-60"
      >
        <View className="flex-row gap-[3px]">
          {kinds.slice(0, MAX_DOTS).map(kind => (
            <View
              key={kind}
              style={{ backgroundColor: colorFor(kind) }}
              className="h-2 w-2 rounded-sm opacity-80"
            />
          ))}
        </View>

        <Text numberOfLines={1} className="min-w-0 flex-1 text-[11px] text-slate-400">
          {label}
        </Text>

        {meta.length > 0 ? (
          <Text className="text-[10px] text-slate-300">{meta.join(' · ')}</Text>
        ) : null}
      </Pressable>

      {isOpen ? (
        <View className="border-l border-slate-200 pl-2.5">
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
