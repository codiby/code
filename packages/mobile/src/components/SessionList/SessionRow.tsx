import { Pressable, Text, View } from 'react-native';

import type { SessionSummary } from '../../api/types';
import { formatChatTimestamp, initialsOf } from '../../lib/format';
import { PinIcon } from './icons';

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
      accessibilityLabel={`Sesión ${session.name}`}
      accessibilityHint="Mantén pulsado para más acciones"
      onPress={() => onPress?.(session)}
      onLongPress={() => onLongPress?.(session)}
      delayLongPress={350}
      className={`flex-row items-center gap-2.5 px-[18px] py-3 ${
        isSelected ? 'bg-slate-200' : 'bg-white active:bg-slate-100'
      }`}
    >
      <View className="relative">
        {/* El host conserva su color en la etiqueta; el avatar queda neutro. */}
        <View
          className={`h-9 w-9 items-center justify-center rounded-full bg-slate-200 ${
            isOffline ? 'opacity-40' : ''
          }`}
        >
          <Text className="text-xs font-semibold text-slate-600">
            {initialsOf(session.name)}
          </Text>
        </View>
        {/* Ámbar en vez de verde: es la señal que se lee sin leer nada. */}
        {isWaiting ? (
          <View className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-amber-500" />
        ) : !isOffline && (isStreaming || session.isRunning) ? (
          <View className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-emerald-500" />
        ) : null}
      </View>

      <View className="flex-1">
        <View className="flex-row items-center justify-between">
          <Text
            numberOfLines={1}
            className={`mr-2 flex-1 text-[13px] font-semibold leading-[18px] ${
              isOffline ? 'text-slate-400' : 'text-slate-900'
            }`}
          >
            {session.name}
          </Text>
          <View className="flex-row items-center gap-1">
            {isPinned ? <PinIcon size={11} color="#94a3b8" /> : null}
            <Text className="text-[10px] text-slate-400">
              {formatChatTimestamp(session.updatedAt)}
            </Text>
          </View>
        </View>

        <View className="mt-0.5 flex-row items-center justify-between">
          {isOffline ? (
            <Text
              numberOfLines={1}
              className="mr-2 flex-1 text-[12px] leading-[18px] text-slate-300"
            >
              {`Sin conexión con ${serverName ?? 'el servidor'}`}
            </Text>
          ) : isWaiting ? (
            <Text
              numberOfLines={1}
              className="mr-2 flex-1 text-[12px] leading-[18px] font-semibold text-amber-700"
            >
              {`Pide permiso · ${pendingTool}`}
            </Text>
          ) : isStreaming ? (
            // Lo que está pasando ahora pesa más que un borrador tuyo o que
            // lo último que se dijo: es lo único que puede cambiar solo.
            <Text
              numberOfLines={1}
              className="mr-2 flex-1 text-[12px] leading-[18px] font-semibold text-emerald-700"
            >
              {activity !== null ? `Trabajando · ${activity}` : 'Trabajando…'}
            </Text>
          ) : hasDraft ? (
            <Text
              numberOfLines={1}
              className="mr-2 flex-1 text-[12px] leading-[18px]"
            >
              <Text className="text-rose-500">Borrador: </Text>
              <Text className="text-slate-500">
                {draft.replace(/\n/g, ' ')}
              </Text>
            </Text>
          ) : (
            <Text
              numberOfLines={1}
              className="mr-2 flex-1 text-[12px] leading-[18px] text-slate-500"
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
                <View className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              ) : null}
              <Text
                style={{ color: isOffline ? OFFLINE_LABEL : serverColor }}
                className="text-[10px] font-medium"
              >
                {serverName}
              </Text>
            </View>
          ) : groupName !== null ? (
            <Text className="text-[10px] uppercase tracking-wide text-slate-400">
              {groupName}
            </Text>
          ) : session.isOpen ? null : (
            <Text className="text-[10px] uppercase tracking-wide text-slate-400">
              archivada
            </Text>
          )}
        </View>
      </View>
    </Pressable>
  );
}
