import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import type { NewSessionSuggestion } from '../../lib/newSessionSuggestion';
import { useInk } from '../../theme';

export interface NewSessionCardProps {
  readonly suggestion: NewSessionSuggestion;
  readonly onCreate: () => void;
  readonly onContinue: () => void;
  readonly isBusy?: boolean;
  readonly error?: string | null;
}

/**
 * La oferta de abrir el trabajo en otra sesión. Misma forma que la tarjeta
 * de permisos, con el verde de acento: no pide permiso, propone.
 */
export function NewSessionCard({
  suggestion,
  onCreate,
  onContinue,
  isBusy = false,
  error = null,
}: NewSessionCardProps) {
  const ink = useInk();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <View className="items-start px-3 py-1">
      <View className="w-[88%] rounded-2xl rounded-bl-md border border-emerald-300 bg-white px-3 py-2.5">
        <View className="flex-row items-center gap-1.5">
          <View className="h-1.5 w-1.5 rounded-full bg-accent" />
          <Text className="text-[9.5px] font-bold uppercase tracking-wide text-accent">
            New session
          </Text>
        </View>

        <Text className="mt-1.5 text-[13.5px] font-semibold text-slate-900">
          {suggestion.title}
        </Text>
        {suggestion.reason.length > 0 ? (
          <Text className="mt-0.5 text-[12.5px] leading-[18px] text-slate-500">
            {suggestion.reason}
          </Text>
        ) : null}

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
            {suggestion.prompt}
          </Text>
        </Pressable>

        {error !== null ? (
          <Text className="mt-1.5 text-[11.5px] text-rose-600">{error}</Text>
        ) : null}

        <View className="mt-3 flex-row items-center justify-end gap-1">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Continue here"
            onPress={onContinue}
            disabled={isBusy}
            className="rounded-lg px-3.5 py-2 active:bg-slate-100"
          >
            <Text className="text-[12.5px] font-semibold text-slate-500">
              Continue here
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create session"
            onPress={onCreate}
            disabled={isBusy}
            className="min-w-[118px] items-center rounded-lg bg-accent px-3.5 py-2 active:opacity-80"
          >
            {isBusy ? (
              <ActivityIndicator size="small" color={ink('#ffffff')} />
            ) : (
              <Text className="text-[12.5px] font-semibold text-on-accent">
                Create session
              </Text>
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}
