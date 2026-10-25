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

export interface ComposerProps {
  /**
   * La sesión está respondiendo. Enciende las luces del marco, igual que en el
   * escritorio — y como allá, NO bloquea el envío: se puede seguir escribiendo
   * y encolar el siguiente mensaje.
   */
  readonly isStreaming?: boolean;
  readonly onSend: (text: string, images: MessageImage[]) => Promise<void>;
  readonly disabled?: boolean;
  /** Solo bloquea Enviar; el mensaje se puede preparar antes de elegir chat. */
  readonly sendDisabled?: boolean;
  readonly initialImages?: MessageImage[];
  readonly allowAttachments?: boolean;
  readonly placeholder?: string;
  /** Host o modo del chat, dentro de la fila de acciones. */
  readonly context?: ReactNode;
  readonly replyTo?: MessageReply | null;
  readonly onCancelReply?: () => void;
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
  placeholder = 'Escribe un mensaje…',
  context,
  replyTo,
  onCancelReply,
  initialText = '',
  onTextChange,
  insertText,
  insertNonce = 0,
  isStreaming = false,
}: ComposerProps) {
  const [text, setText] = useState(initialText);
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  useEffect(() => {
    if (replyTo) {
      inputRef.current?.focus();
    }
  }, [replyTo]);

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
  const [frameHeight, setFrameHeight] = useState(44);
  const [error, setError] = useState<string | null>(null);

  const trimmed = text.trim();
  const canSend =
    (trimmed.length > 0 || images.length > 0) &&
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
      .catch(() => setError('No se pudo abrir la galería'));
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
        setError(cause instanceof Error ? cause.message : 'No se pudo enviar');
      })
      .finally(() => {
        sendingRef.current = false;
        setIsSending(false);
      });
  };

  // Las animaciones del chat se cargan solo cuando se necesitan; compartir no las monta.
  const Spots = isStreaming
    ? (require('./ComposerSpots') as typeof import('./ComposerSpots'))
        .ComposerSpots
    : null;
  return (
    <View pointerEvents="box-none" className="px-3 pb-2 pt-1">
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
                accessibilityLabel="Quitar adjunto"
                onPress={() => removeImage(index)}
                className="absolute -right-1.5 -top-1.5 h-5 w-5 items-center justify-center rounded-full bg-slate-900 active:opacity-70"
              >
                <CloseIcon size={11} color="#ffffff" />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}

      <View
        onLayout={event => setFrameHeight(event.nativeEvent.layout.height)}
        className="overflow-hidden rounded-[20px] border border-slate-200 bg-white"
      >
        {Spots ? <Spots height={frameHeight} /> : null}
        {replyTo ? (
          <View className="mx-2 mt-2">
            <ReplyQuote reply={replyTo} onCancel={onCancelReply} />
          </View>
        ) : null}
        <TextInput
          ref={inputRef}
          value={text}
          onChangeText={next => {
            setText(next);
            onTextChange?.(next);
          }}
          placeholder={placeholder}
          accessibilityLabel="Mensaje"
          placeholderTextColor="#94a3b8"
          multiline
          maxLength={8000}
          editable={!disabled && !isSending}
          className="max-h-32 min-h-10 bg-transparent px-3.5 pb-1.5 pt-2.5 text-[14px] leading-5 text-slate-900"
        />
        <View className="flex-row items-center gap-2 px-2 pb-2">
          {allowAttachments ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Adjuntar imagen"
              onPress={pickImages}
              disabled={disabled || isSending}
              className="h-10 w-10 items-center justify-center rounded-full active:bg-slate-100"
            >
              <AttachIcon size={20} color="#64748b" />
            </Pressable>
          ) : null}
          <View className="flex-1">{context}</View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Enviar"
            accessibilityState={{ disabled: !canSend }}
            onPress={submit}
            disabled={!canSend}
            className={`h-10 w-10 items-center justify-center rounded-xl ${
              canSend ? 'bg-slate-900 active:opacity-70' : 'bg-slate-200'
            }`}
          >
            {isSending ? (
              <ActivityIndicator size="small" color="#64748b" />
            ) : (
              <SendIcon size={19} color={canSend ? '#ffffff' : '#94a3b8'} />
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}
