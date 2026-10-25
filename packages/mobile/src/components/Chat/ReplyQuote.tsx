import { Pressable, Text, View } from 'react-native';
import type { MessageReply } from '../../lib/messageReply';
import { CloseIcon } from './icons';

export function ReplyQuote({
  reply,
  onCancel,
}: {
  readonly reply: MessageReply;
  readonly onCancel?: () => void;
}) {
  return (
    <View className="flex-row items-center rounded-lg border-l-[3px] border-emerald-600 bg-slate-100 px-2.5 py-2">
      <View className="flex-1">
        <Text className="text-[11px] font-semibold text-emerald-700">
          {reply.role === 'user' ? 'Tú' : 'Codiby'}
        </Text>
        <Text
          numberOfLines={2}
          className="mt-0.5 text-[12px] leading-4 text-slate-600"
        >
          {reply.text}
        </Text>
      </View>
      {onCancel ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancelar respuesta"
          onPress={onCancel}
          className="h-11 w-11 items-center justify-center"
        >
          <CloseIcon size={16} color="#64748b" />
        </Pressable>
      ) : null}
    </View>
  );
}
