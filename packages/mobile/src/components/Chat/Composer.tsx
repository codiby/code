import {
  useEffect,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
} from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { MessageImage } from '../../api/types';
import type { MessageReply } from '../../lib/messageReply';
import { ReplyQuote } from './ReplyQuote';
import { AttachIcon, CloseIcon, SendIcon } from './icons';
import { useInk } from '../../theme';

export interface ComposerProps {
  readonly onSend: (text: string, images: MessageImage[]) => Promise<void>;
  readonly disabled?: boolean;
  /** Solo bloquea Enviar; el mensaje se puede preparar antes de elegir chat. */
  readonly sendDisabled?: boolean;
  readonly initialImages?: MessageImage[];
  readonly allowAttachments?: boolean;
  readonly placeholder?: string;
  /** Host o modo del chat, dentro de la fila de acciones. */
  readonly context?: ReactNode;
  /** Citas pendientes; salen todas, cada una con su nota, en el próximo mensaje. */
  readonly replies?: readonly MessageReply[];
  readonly onChangeReplies?: (
    next: (prev: MessageReply[]) => MessageReply[],
  ) => void;
  /** Texto recuperado al volver a la sesión. */
  readonly initialText?: string;
  /** Se llama en cada cambio; la pantalla decide cuándo persistir. */
  readonly onTextChange?: (text: string) => void;
  /**
   * Texto que se vuelca en el input desde fuera, para el toque largo de una
   * sugerencia. Va emparejado con `insertNonce` porque volcar el mismo texto
   * dos veces seguidas es un caso legítimo y comparar el valor no lo
   * distinguiría.
   */
  readonly insertText?: string;
  readonly insertNonce?: number;
}

/**
 * El bridge acepta las imágenes como base64 dentro del mensaje, así que se
 * reescalan al elegirlas: una foto de 12 MP en base64 son varios MB de JSON
 * por adjunto.
 */
const PICKER_OPTIONS = {
  mediaType: 'photo',
  includeBase64: true,
  maxWidth: 1920,
  maxHeight: 1920,
  quality: 0.8,
  selectionLimit: 4,
} as const;

export function Composer({
  onSend,
  disabled = false,
  sendDisabled = false,
  initialImages = [],
  allowAttachments = true,
  placeholder = 'Write a message…',
  context,
  replies = [],
  onChangeReplies,
  initialText = '',
  onTextChange,
  insertText,
  insertNonce = 0,
}: ComposerProps) {
  const ink = useInk();
  const [text, setText] = useState(initialText);
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const replyCount = replies.length;
  useEffect(() => {
    if (replyCount > 0) {
      inputRef.current?.focus();
    }
  }, [replyCount]);
  // Una cita con nota ya es un mensaje, aunque el campo de texto esté vacío.
  const hasNotes = replies.some(r => r.note?.trim());

  // Solo el nonce está en las dependencias: si estuviera `insertText`, editar
  // el input después de volcar una sugerencia lo revertiría al siguiente
  // render.
  useEffect(() => {
    if (insertNonce > 0 && insertText !== undefined) {
      setText(insertText);
      onTextChange?.(insertText);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insertNonce]);
  const [images, setImages] = useState<MessageImage[]>(initialImages);
  const [isSending, setIsSending] = useState(false);
  const sendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = text.trim();
  const canSend =
    (trimmed.length > 0 || images.length > 0 || hasNotes) &&
    !isSending &&
    !disabled &&
    !sendDisabled;

  const pickImages = () => {
    setError(null);
    // La extensión no abre la galería ni carga sus módulos nativos.
    const { launchImageLibrary } =
      require('react-native-image-picker') as typeof import('react-native-image-picker');
    launchImageLibrary(PICKER_OPTIONS)
      .then(result => {
        if (result.didCancel === true) {
          return;
        }
        if (result.errorMessage !== undefined) {
          setError(result.errorMessage);
          return;
        }
        const picked = (result.assets ?? [])
          .filter(asset => typeof asset.base64 === 'string')
          .map(asset => ({
            mediaType: asset.type ?? 'image/jpeg',
            data: asset.base64!,
          }));
        setImages(current => [...current, ...picked].slice(0, 4));
      })
      .catch(() => setError('Could not open the gallery'));
  };

  const removeImage = (index: number) => {
    setImages(current => current.filter((_, i) => i !== index));
  };

  const submit = () => {
    if (!canSend || sendingRef.current) {
      return;
    }
    sendingRef.current = true;
    setIsSending(true);
    setError(null);
    // Se limpia de inmediato: si falla, todo vuelve al compositor.
    const queued = images;
    setText('');
    // Además del estado, el campo nativo: con una palabra a medio componer,
    // el teclado de Samsung devolvía el texto tras un `value=''`.
    inputRef.current?.clear();
    onTextChange?.('');
    setImages([]);
    onSend(trimmed, queued)
      .catch((cause: unknown) => {
        setText(trimmed);
        onTextChange?.(trimmed);
        setImages(queued);
        setError(cause instanceof Error ? cause.message : 'Could not send');
      })
      .finally(() => {
        sendingRef.current = false;
        setIsSending(false);
      });
  };

  return (
    <View pointerEvents="box-none" className="bg-white px-3 pb-3 pt-2">
      {error !== null ? (
        <View className="mb-1.5 self-start rounded-full bg-rose-100 px-3 py-1">
          <Text className="text-[11px] font-medium text-rose-700">{error}</Text>
        </View>
      ) : null}

      {images.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="mb-1.5 max-h-20 grow-0"
          contentContainerClassName="gap-2 pr-2"
        >
          {images.map((image, index) => (
            <View key={index} className="relative">
              <Image
                source={{ uri: `data:${image.mediaType};base64,${image.data}` }}
                className="h-16 w-16 rounded-xl border border-slate-200 bg-slate-100"
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove attachment"
                onPress={() => removeImage(index)}
                className="absolute -right-1.5 -top-1.5 h-5 w-5 items-center justify-center rounded-full bg-slate-900 active:opacity-70"
              >
                <CloseIcon size={11} color={ink('#f8fafc')} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}

      {/* Mismo lenguaje que la barra del visor en la app de chats: campo
          redondo de 44 px y un botón circular aparte para enviar. */}
      <View className="flex-row items-end gap-2">
        <View className="min-h-11 flex-1 overflow-hidden rounded-[22px] bg-slate-100">
          {replyCount > 0 ? (
            <ScrollView
              className="mx-2 mt-2 max-h-56"
              contentContainerClassName="gap-1.5"
              keyboardShouldPersistTaps="handled"
            >
              {replies.map((reply, i) => (
                <ReplyQuote
                  key={`${reply.id}:${reply.text}`}
                  reply={reply}
                  index={replyCount > 1 ? i : undefined}
                  onCancel={() =>
                    onChangeReplies?.(prev => prev.filter((_, j) => j !== i))
                  }
                  onNoteChange={note =>
                    onChangeReplies?.(prev =>
                      prev.map((r, j) => (j === i ? { ...r, note } : r)),
                    )
                  }
                />
              ))}
            </ScrollView>
          ) : null}
          <View className="flex-row items-end">
            {allowAttachments ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Attach image"
                onPress={pickImages}
                disabled={disabled || isSending}
                className="mb-1 ml-1 h-9 w-9 items-center justify-center rounded-full active:bg-slate-200"
              >
                <AttachIcon size={19} color={ink('#6a707a')} />
              </Pressable>
            ) : null}
            <TextInput
              ref={inputRef}
              value={text}
              onChangeText={next => {
                setText(next);
                onTextChange?.(next);
              }}
              placeholder={placeholder}
              accessibilityLabel="Message"
              placeholderTextColor={ink('#a2a8b2')}
              multiline
              maxLength={8000}
              editable={!disabled && !isSending}
              className={`max-h-32 min-h-11 flex-1 bg-transparent py-3 pr-3.5 text-[14.5px] leading-5 text-slate-900 ${
                allowAttachments ? 'pl-1' : 'pl-4'
              }`}
            />
          </View>
          {context ? <View className="px-3 pb-2">{context}</View> : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !canSend }}
          onPress={submit}
          disabled={!canSend}
          className={`h-11 w-11 items-center justify-center rounded-full ${
            canSend ? 'bg-accent active:opacity-80' : 'bg-slate-100'
          }`}
        >
          {isSending ? (
            <ActivityIndicator size="small" color={ink('#6a707a')} />
          ) : (
            <SendIcon
              size={19}
              color={canSend ? ink('#ffffff') : ink('#a2a8b2')}
            />
          )}
        </Pressable>
      </View>
    </View>
  );
}
