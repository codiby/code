import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { TabGroup } from '../api/preferences';
import type { SessionSummary } from '../api/types';
import { CheckIcon } from '../components/Chat';
import { SERVER_COLORS, colorHex } from '../config/servers';

export interface MoveToGroupSheetProps {
  readonly visible: boolean;
  readonly sessions: SessionSummary[];
  readonly groups: TabGroup[];
  /** clave de sesión → clave de grupo, para contar cuántas tiene cada uno. */
  readonly groupBySession: Record<string, string>;
  /** Nombre visible de cada servidor, para decir de dónde salen las sesiones. */
  readonly serverNames: Record<string, string>;
  readonly isWorking: boolean;
  readonly onCancel: () => void;
  /** `name` en `null` las saca del grupo. */
  readonly onConfirm: (name: string | null, color: string) => void;
}

/** Iniciales del recuadro del grupo, como en el escritorio. */
function tag(name: string): string {
  return name.trim().slice(0, 2).toLowerCase();
}

/**
 * Elegir a qué grupo van las sesiones seleccionadas.
 *
 * Radio y no casillas: una sesión pertenece a un grupo o a ninguno, así que
 * poder marcar dos sería contradictorio.
 */
export function MoveToGroupSheet({
  visible,
  sessions,
  groups,
  groupBySession,
  serverNames,
  isWorking,
  onCancel,
  onConfirm,
}: MoveToGroupSheetProps) {
  const insets = useSafeAreaInsets();
  /**
   * `undefined` es «no has elegido», distinto de `null`, que es «sin grupo».
   *
   * Sin esa distinción la hoja abría con «Sin grupo» marcado y el botón activo:
   * un toque distraído sacaba la sesión de su grupo sin que nadie lo pidiera.
   */
  const [choice, setChoice] = useState<string | null | undefined>(undefined);
  const [isNew, setIsNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<string>(SERVER_COLORS[1]!);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const key of Object.values(groupBySession)) {
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  }, [groupBySession]);

  /** Los que más sesiones tienen primero: es donde más probable que vaya. */
  const ordered = useMemo(
    () =>
      [...groups].sort(
        (a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0),
      ),
    [groups, counts],
  );

  /** «1 de mac, 1 de ryzen9»: de dónde saldrán las escrituras. */
  const origin = useMemo(() => {
    const byServer = new Map<string, number>();
    for (const session of sessions) {
      byServer.set(session.serverId, (byServer.get(session.serverId) ?? 0) + 1);
    }
    return [...byServer.entries()]
      .map(([id, count]) => `${count} de ${serverNames[id] ?? 'servidor'}`)
      .join(', ');
  }, [sessions, serverNames]);

  const close = () => {
    setChoice(undefined);
    setIsNew(false);
    setNewName('');
    onCancel();
  };

  const canConfirm = isNew
    ? newName.trim().length > 0
    : choice !== undefined;
  const confirmLabel = isNew
    ? `Crear y mover ${sessions.length}`
    : `Mover ${sessions.length}`;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancelar"
        onPress={close}
        className="flex-1 bg-slate-900/40"
      />
      <View
        style={{ paddingBottom: insets.bottom + 12 }}
        className="rounded-t-[26px] bg-white pt-2"
      >
        <View className="mx-auto mb-4 h-1 w-9 rounded-full bg-slate-200" />
        <Text className="px-5 text-[17px] font-bold text-slate-900">
          Mover a un grupo
        </Text>
        <Text className="px-5 pt-1 text-[12px] leading-5 text-slate-500">
          {`${sessions.length} ${sessions.length === 1 ? 'sesión' : 'sesiones'} · ${origin}`}
        </Text>

        <Text className="px-5 pb-1.5 pt-4 text-[9.5px] font-bold uppercase tracking-widest text-slate-400">
          Grupos
        </Text>

        <ScrollView className="max-h-64" keyboardShouldPersistTaps="handled">
          {ordered.map(group => {
            const isPicked = !isNew && choice === group.name;
            return (
              <Pressable
                key={group.id}
                accessibilityRole="button"
                accessibilityState={{ selected: isPicked }}
                onPress={() => {
                  setIsNew(false);
                  setChoice(group.name);
                }}
                className={`flex-row items-center gap-3 px-5 py-2.5 ${
                  isPicked ? 'bg-slate-50' : 'active:bg-slate-50'
                }`}
              >
                <View
                  style={{ backgroundColor: colorHex(group.color) }}
                  className="h-[30px] w-[30px] items-center justify-center rounded-[10px]"
                >
                  <Text className="text-[10.5px] font-bold text-white">
                    {tag(group.name)}
                  </Text>
                </View>
                <View className="flex-1">
                  <Text className="text-[14.5px] font-semibold text-slate-900">
                    {group.name}
                  </Text>
                  <Text className="mt-0.5 text-[10.5px] text-slate-400">
                    {`${counts[group.id] ?? 0} ${
                      (counts[group.id] ?? 0) === 1 ? 'sesión' : 'sesiones'
                    }`}
                  </Text>
                </View>
                {isPicked ? (
                  <View
                    style={{ backgroundColor: colorHex(group.color) }}
                    className="h-[19px] w-[19px] items-center justify-center rounded-full"
                  >
                    <CheckIcon size={11} color="#ffffff" />
                  </View>
                ) : (
                  <View className="h-[19px] w-[19px] rounded-full border-[1.75px] border-slate-300" />
                )}
              </Pressable>
            );
          })}
        </ScrollView>

        <View className="mx-5 my-2 h-px bg-slate-100" />

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: !isNew && choice === null }}
          onPress={() => {
            setIsNew(false);
            setChoice(null);
          }}
          className="flex-row items-center gap-3 px-5 py-2.5 active:bg-slate-50"
        >
          <View className="h-[30px] w-[30px] items-center justify-center rounded-[10px] border-[1.5px] border-dashed border-slate-300 bg-slate-100">
            <Text className="text-[10.5px] font-bold text-slate-400">—</Text>
          </View>
          <View className="flex-1">
            <Text className="text-[14.5px] font-semibold text-slate-900">
              Sin grupo
            </Text>
            <Text className="mt-0.5 text-[10.5px] text-slate-400">
              Las saca de donde estén
            </Text>
          </View>
          {!isNew && choice === null ? (
            <View className="h-[19px] w-[19px] items-center justify-center rounded-full bg-slate-900">
              <CheckIcon size={11} color="#ffffff" />
            </View>
          ) : (
            <View className="h-[19px] w-[19px] rounded-full border-[1.75px] border-slate-300" />
          )}
        </Pressable>

        <Pressable
          accessibilityRole="button"
          onPress={() => setIsNew(true)}
          className="flex-row items-center gap-3 px-5 py-2.5"
        >
          <View
            style={isNew ? { backgroundColor: colorHex(newColor) } : undefined}
            className={`h-[30px] w-[30px] items-center justify-center rounded-[10px] ${
              isNew
                ? ''
                : 'border-[1.5px] border-dashed border-slate-300 bg-slate-100'
            }`}
          >
            <Text
              className={`text-[10.5px] font-bold ${
                isNew ? 'text-white' : 'text-slate-400'
              }`}
            >
              {isNew && newName.trim().length > 0 ? tag(newName) : '+'}
            </Text>
          </View>
          <TextInput
            value={newName}
            onChangeText={text => {
              setIsNew(true);
              setNewName(text);
            }}
            onFocus={() => setIsNew(true)}
            placeholder="Nuevo grupo…"
            placeholderTextColor="#a3aec0"
            className={`flex-1 rounded-xl px-3 py-2 text-[14px] text-slate-900 ${
              isNew
                ? 'border-[1.5px] border-slate-900'
                : 'border-[1.5px] border-dashed border-slate-200'
            }`}
          />
        </Pressable>

        {isNew ? (
          <View className="flex-row gap-2.5 px-5 pb-1 pl-[62px] pt-2">
            {SERVER_COLORS.map(color => (
              <Pressable
                key={color}
                accessibilityRole="button"
                accessibilityLabel={`Color ${color}`}
                onPress={() => setNewColor(color)}
                className="p-0.5"
              >
                <View
                  style={{ backgroundColor: colorHex(color) }}
                  className={`h-[22px] w-[22px] rounded-full ${
                    newColor === color ? 'opacity-100' : 'opacity-30'
                  }`}
                />
              </Pressable>
            ))}
          </View>
        ) : null}

        <Text className="px-5 pt-3 text-[11px] leading-[17px] text-slate-400">
          Cada máquina guarda sus grupos aparte. Si el elegido no existe en
          alguna, se crea ahí con el mismo nombre.
        </Text>

        <View className="flex-row gap-2.5 px-5 pt-4">
          <Pressable
            accessibilityRole="button"
            onPress={close}
            disabled={isWorking}
            className="flex-1 items-center rounded-2xl py-3 active:bg-slate-50"
          >
            <Text className="text-[14.5px] font-semibold text-slate-500">
              Cancelar
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !canConfirm || isWorking }}
            onPress={() =>
              onConfirm(
                isNew ? newName.trim() : (choice ?? null),
                isNew ? newColor : 'slate',
              )
            }
            disabled={!canConfirm || isWorking}
            className={`flex-[2.2] items-center rounded-2xl py-3 ${
              canConfirm && !isWorking ? 'bg-slate-900 active:opacity-80' : 'bg-slate-300'
            }`}
          >
            {isWorking ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <Text className="text-[14.5px] font-semibold text-white">
                {confirmLabel}
              </Text>
            )}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
