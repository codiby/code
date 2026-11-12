import Clipboard from '@react-native-clipboard/clipboard';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { ChatMessage } from '../../api/types';
import { formatFullTimestamp } from '../../lib/format';
import type { GroupEntry } from '../../lib/chatItems';
import { readReply } from '../../lib/messageReply';
import { Markdown } from '../Markdown';
import { ChatImages } from './ChatImage';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolGroup } from './ToolGroup';
import { ReplyQuote } from './ReplyQuote';
import { SwipeToReply } from './SwipeToReply';

export interface MessageBubbleProps {
  readonly message: ChatMessage;
  /** Herramientas que provocó este mensaje, si las hubo. */
  readonly group?: GroupEntry[] | null;
  /** Solo uno a la vez; la selección la lleva la pantalla. */
  readonly isSelected?: boolean;
  /** Alterna la selección: es lo que hace el toque simple. */
  readonly onSelect?: (id: string) => void;
  /** Fuerza la selección, sin alternar. Lo usa la pulsación larga. */
  readonly onShowStamp?: (id: string) => void;
  /** Reintenta un mensaje propio que no llegó al bridge. */
  readonly onRetry?: (message: ChatMessage) => void;
  readonly onReply?: (message: ChatMessage) => void;
}

/** Recorte de seguridad: sin él, un blob base64 monta miles de nodos de texto. */
const MAX_CHARS = 6000;

export function MessageBubble({
  message,
  group = null,
  isSelected = false,
  onSelect,
  onShowStamp,
  onRetry,
  onReply,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const hasGroup = group !== null && group.length > 0;
  const [justCopied, setJustCopied] = useState(false);

  // Al deseleccionar, el aviso no debe quedar colgado para la próxima vez.
  useEffect(() => {
    if (!isSelected) {
      setJustCopied(false);
    }
  }, [isSelected]);

  // El razonamiento no es un turno de la conversación: va colapsado, igual
  // que en la app de escritorio.
  if (message.isThinking) {
    return (
      <ThinkingBlock
        text={message.content}
        redacted={message.thinkingRedacted}
      />
    );
  }

  const parsed = isUser
    ? readReply(message.content)
    : { text: message.content, reply: null };
  const content = parsed.text.trim();
  const hasImages = message.images.length > 0;
  // Un mensaje vacío que sí trajo herramientas no se descarta: la burbuja es
  // el ancla de la que cuelgan.
  if (content.length === 0 && !hasImages && !hasGroup) {
    return null;
  }

  const isClipped = content.length > MAX_CHARS;
  const text = isClipped ? content.slice(0, MAX_CHARS) : content;
  const canReply =
    Boolean(onReply) && message.role !== 'system' && !message.sendState;

  /**
   * Copia con pulsación larga. Se copia el contenido íntegro, no el recortado
   * para pintar: el recorte es una decisión de layout y no debería llegar al
   * portapapeles.
   */
  const copy = () => {
    if (content.length === 0) {
      return;
    }
    Clipboard.setString(parsed.text);
    // Se fuerza la selección para que haya dónde enseñar el aviso.
    onShowStamp?.(message.id);
    setJustCopied(true);
    setTimeout(() => setJustCopied(false), 1600);
  };

  return (
    <SwipeToReply onReply={canReply ? () => onReply?.(message) : undefined}>
      <View
        className={`py-1.5 ${isUser ? 'items-end px-3' : 'items-start px-[18px]'}`}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            isSelected ? 'Hide the time' : 'Show the message time'
          }
          accessibilityHint="Swipe right to reply. Long-press to copy"
          accessibilityActions={
            canReply
              ? [{ name: 'reply', label: 'Reply to message' }]
              : undefined
          }
          onAccessibilityAction={event => {
            if (canReply && event.nativeEvent.actionName === 'reply') {
              onReply?.(message);
            }
          }}
          onPress={() => onSelect?.(message.id)}
          onLongPress={copy}
          delayLongPress={350}
          // Solo lo tuyo va en burbuja: la respuesta del agente se lee sobre
          // la página, como un documento, sin una columna de tarjetas.
          className={
            isUser
              ? 'max-w-[80%] rounded-[18px] rounded-br-md bg-bubble px-3.5 py-2'
              : 'w-full'
          }
        >
          {parsed.reply ? (
            <View className="mb-2">
              <ReplyQuote reply={parsed.reply} />
            </View>
          ) : null}
          <ChatImages images={message.images} />

          {content.length === 0 ? null : isUser ? (
            // Lo que escribe el usuario se muestra literal: si escribió
            // asteriscos, quiso asteriscos.
            <Text className="text-[14.5px] leading-[21px] text-on-bubble">
              {text}
            </Text>
          ) : (
            <Markdown text={text} />
          )}

          {isClipped ? (
            <Text className="mt-1 text-[11px] italic text-slate-400">
              … truncated
            </Text>
          ) : null}
          {hasGroup ? <ToolGroup entries={group} variant="footer" /> : null}
        </Pressable>

        {message.sendState === 'sending' ? (
          <Text className="mt-0.5 px-1 text-[10px] text-slate-400">
            sending…
          </Text>
        ) : message.sendState === 'failed' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry sending"
            onPress={() => onRetry?.(message)}
            hitSlop={8}
            className="mt-0.5 px-1 active:opacity-60"
          >
            <Text className="text-[11px] font-semibold text-rose-600">
              Not sent · Retry
            </Text>
          </Pressable>
        ) : null}

        {/* Fuera de la tarjeta y solo a petición: la hora casi nunca importa,
          pero cuando importa se quiere exacta. */}
        {isSelected ? (
          <View className="mt-0.5 flex-row items-center gap-1.5 px-1">
            <Text className="text-[10px] text-slate-400">
              {formatFullTimestamp(message.timestamp)}
            </Text>
            {justCopied ? (
              <Text className="text-[10px] font-semibold text-emerald-600">
                Copied
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </SwipeToReply>
  );
}
