import { Pressable, Text, TextInput, View } from 'react-native';
import { MAX_NOTE, type MessageReply } from '../../lib/messageReply';
import { CloseIcon } from './icons';
import { useInk } from '../../theme';

/**
 * Una cita. En un mensaje enviado muestra la nota que la acompaña; en el
 * composer (`onNoteChange`) la nota se edita. `index` la numera cuando el
 * mensaje lleva varias.
 */
export function ReplyQuote({
  reply,
  index,
  onCancel,
  onNoteChange,
}: {
  readonly reply: MessageReply;
  readonly index?: number;
  readonly onCancel?: () => void;
  readonly onNoteChange?: (note: string) => void;
}) {
  const ink = useInk();
  return (
    <View className="flex-row items-start rounded-lg border-l-[3px] border-emerald-600 bg-slate-100 px-2.5 py-2">
      {index !== undefined ? (
        <View className="mr-2 mt-0.5 h-[18px] min-w-[18px] items-center justify-center rounded-full bg-emerald-600 px-1">
          <Text className="text-[10.5px] font-bold text-white">{index + 1}</Text>
        </View>
      ) : null}
      <View className="flex-1">
        <Text className="text-[11px] font-semibold text-emerald-700">
          {reply.role === 'user' ? 'You' : 'Codiby'}
        </Text>
        <Text
          numberOfLines={2}
          className="mt-0.5 text-[12px] leading-4 text-slate-600"
        >
          {reply.text}
        </Text>
        {onNoteChange ? (
          <TextInput
            value={reply.note ?? ''}
            onChangeText={onNoteChange}
            maxLength={MAX_NOTE}
            placeholder="Your comment on this part (optional)…"
            placeholderTextColor={ink('#94a3b8')}
            accessibilityLabel="Comment on this quote"
            className="mt-1 p-0 text-[14px] text-slate-900"
          />
        ) : reply.note ? (
          <Text className="mt-1 text-[14px] leading-5 text-slate-900">
            {reply.note}
          </Text>
        ) : null}
      </View>
      {onCancel ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel reply"
          onPress={onCancel}
          className="h-11 w-11 items-center justify-center"
        >
          <CloseIcon size={16} color={ink('#64748b')} />
        </Pressable>
      ) : null}
    </View>
  );
}
