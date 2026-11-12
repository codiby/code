import { Pressable, Text, View } from 'react-native';

import type { SessionSummary } from '../../api/types';
import {
  avatarColorFor,
  formatChatTimestamp,
  initialsOf,
} from '../../lib/format';
import { PinIcon } from './icons';
import { useInk } from '../../theme';

/** Gris del texto cuando el servidor de esa sesión no responde. */
const OFFLINE_LABEL = '#cbd5e1';

export interface SessionRowProps {
  readonly session: SessionSummary;
  readonly onPress?: (session: SessionSummary) => void;
  readonly onLongPress?: (session: SessionSummary) => void;
  readonly isPinned?: boolean;
  readonly isSelected?: boolean;
  /** Texto sin enviar; tiene prioridad sobre todo, como en WhatsApp. */
  readonly draft?: string;
  /** Resumen del último mensaje legible de la conversación. */
  readonly preview?: string;
  /** Herramienta que espera aprobación; manda sobre todo lo demás. */
  readonly pendingTool?: string;
  /** El agente está respondiendo ahora mismo. */
  readonly isStreaming?: boolean;
  /** Herramienta que corre en este momento, si se sabe cuál. */
  readonly activity?: string | null;
  /** Nombre del grupo del escritorio al que pertenece. */
  readonly groupName?: string | null;
  /** Servidor del que viene, para la etiqueta bajo la hora. */
  readonly serverName?: string | null;
  readonly serverColor?: string;
  /** Su servidor no responde: la fila se apaga pero no se va. */
  readonly isOffline?: boolean;
  /** Suscrita al socket compartido: recibe cambios sin recargar. */
  readonly isLive?: boolean;
}

export function SessionRow({
  session,
  onPress,
  onLongPress,
  isPinned = false,
  isSelected = false,
  draft,
  preview,
  pendingTool,
  isStreaming = false,
  activity = null,
  groupName = null,
  serverName = null,
  serverColor = '#64748b',
  isOffline = false,
  isLive = false,
}: SessionRowProps) {
  const ink = useInk();
  const isWaiting =
    !isOffline && pendingTool !== undefined && pendingTool.length > 0;
  const hasDraft = draft !== undefined && draft.trim().length > 0;
  const hasPreview = preview !== undefined && preview.trim().length > 0;

  // Orden de prioridad: lo que tú dejaste a medias, luego lo último que se
  // dijo, y solo si no hay nada de eso, de dónde es la sesión.
  const subtitle = hasPreview
    ? preview
    : session.provider !== null
    ? `${session.folder} · ${session.provider}`
    : session.folder;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Session ${session.name}`}
      accessibilityState={{ selected: isSelected }}
      accessibilityHint={
        onLongPress ? 'Long-press for more actions' : undefined
      }
      onPress={() => onPress?.(session)}
      onLongPress={() => onLongPress?.(session)}
      delayLongPress={350}
      className={`flex-row items-center gap-[11px] px-4 py-2 ${
        isSelected ? 'bg-slate-100' : 'bg-white active:bg-slate-100'
      }`}
    >
      <View className="relative">
        {/* Color estable por sesión, como los contactos de la app de chats. */}
        <View
          style={{ backgroundColor: avatarColorFor(session.id) }}
          className={`h-11 w-11 items-center justify-center rounded-full ${
            isOffline ? 'opacity-40' : ''
          }`}
        >
          <Text className="text-[13px] font-semibold text-white">
            {initialsOf(session.name)}
          </Text>
        </View>
        {/* Ámbar en vez de verde: es la señal que se lee sin leer nada. */}
        {isWaiting ? (
          <View className="absolute bottom-0 right-0 h-[13px] w-[13px] rounded-full border-2 border-white bg-amber-500" />
        ) : !isOffline && (isStreaming || session.isRunning) ? (
          <View className="absolute bottom-0 right-0 h-[13px] w-[13px] rounded-full border-2 border-white bg-[#19c37d]" />
        ) : null}
      </View>

      <View className="flex-1">
        <View className="flex-row items-center justify-between">
          <Text
            numberOfLines={1}
            className={`mr-2 flex-1 text-[14.5px] font-medium leading-5 tracking-[-0.3px] ${
              isOffline ? 'text-slate-400' : 'text-slate-900'
            }`}
          >
            {session.name}
          </Text>
          <View className="flex-row items-center gap-1">
            {isPinned ? <PinIcon size={12} color={ink('#94a3b8')} /> : null}
            <Text
              className={`text-[11px] ${
                isStreaming && !isOffline
                  ? 'font-semibold text-accent'
                  : 'text-slate-400'
              }`}
            >
              {formatChatTimestamp(session.updatedAt)}
            </Text>
          </View>
        </View>

        <View className="mt-0.5 flex-row items-center justify-between">
          {isOffline ? (
            <Text
              numberOfLines={1}
              className="mr-2 flex-1 text-[12.8px] leading-[18px] text-slate-300"
            >
              {`Can't reach ${serverName ?? 'the server'}`}
            </Text>
          ) : isWaiting ? (
            <Text
              numberOfLines={1}
              className="mr-2 flex-1 text-[12.8px] font-medium leading-[18px] text-amber-700"
            >
              {`Needs permission · ${pendingTool}`}
            </Text>
          ) : isStreaming ? (
            // Lo que está pasando ahora pesa más que un borrador tuyo o que
            // lo último que se dijo: es lo único que puede cambiar solo.
            <Text
              numberOfLines={1}
              className="mr-2 flex-1 text-[12.8px] font-medium leading-[18px] text-accent"
            >
              {activity !== null ? `Working · ${activity}` : 'Working…'}
            </Text>
          ) : hasDraft ? (
            <Text
              numberOfLines={1}
              className="mr-2 flex-1 text-[12.8px] leading-[18px]"
            >
              <Text className="font-medium text-orange-700">Draft: </Text>
              <Text className="text-slate-500">
                {draft.replace(/\n/g, ' ')}
              </Text>
            </Text>
          ) : (
            <Text
              numberOfLines={1}
              className="mr-2 flex-1 text-[12.8px] leading-[18px] text-slate-500"
            >
              {subtitle}
            </Text>
          )}

          {/* El servidor manda sobre el grupo: con varias máquinas, saber de
              cuál viene importa más que a qué carpeta pertenece. */}
          {serverName !== null ? (
            <View className="flex-row items-center gap-1">
              {/* Enganchada al socket: sus cambios llegan solos. Va aquí y no
                  en el avatar porque ahí el verde ya significa «trabajando»,
                  y son cosas distintas. */}
              {isLive && !isOffline ? (
                <View className="h-1.5 w-1.5 rounded-full bg-[#19c37d]" />
              ) : null}
              <Text
                style={{ color: ink(isOffline ? OFFLINE_LABEL : serverColor) }}
                className="text-[10.5px] font-medium"
              >
                {serverName}
              </Text>
            </View>
          ) : groupName !== null ? (
            <Text className="text-[10.5px] text-slate-400">
              {groupName}
            </Text>
          ) : session.isOpen ? null : (
            <Text className="text-[10.5px] text-slate-400">
              archived
            </Text>
          )}
        </View>
      </View>
    </Pressable>
  );
}

/** Separador compartido con el inicio y el selector de imágenes. */
export function SessionRowSeparator() {
  // Empieza donde termina el avatar (16 + 44 + 11), como en la app de chats.
  return <View className="ml-[71px] h-px bg-slate-200" />;
}
