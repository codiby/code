import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useServers } from '../config/ServerConfigContext';
import {
  colorHex,
  routeState,
  SERVER_COLORS,
  type RouteMode,
  type ServerEntry,
} from '../config/servers';

/** Fuera del JSX: un literal ahí dentro dispara `no-inline-styles`. */
const MONO = { fontFamily: 'monospace' } as const;

const MODES: { readonly value: RouteMode; readonly label: string }[] = [
  { value: 'auto', label: 'Automático' },
  { value: 'local', label: 'Solo local' },
  { value: 'remote', label: 'Solo respaldo' },
];

interface FieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly placeholder: string;
  readonly hint?: string;
  readonly mono?: boolean;
  readonly secure?: boolean;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  mono,
  secure = false,
}: FieldProps) {
  return (
    <View className="mt-[13px]">
      <Text className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </Text>
      <TextInput
        value={value}
        accessibilityLabel={label}
        secureTextEntry={secure}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="#94a3b8"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={secure ? 'default' : 'url'}
        style={mono === true ? MONO : undefined}
        className="rounded-xl border border-slate-300 bg-slate-50 px-[11px] py-2.5 text-[13px] text-slate-900"
      />
      {hint !== undefined ? (
        <Text className="mt-1 text-[10px] leading-4 text-slate-400">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/** Campos de configuración; la lista de hosts solo muestra un resumen. */
function ServerEditor({
  server,
  onChange,
  onRemove,
  canRemove,
}: {
  readonly server: ServerEntry;
  readonly onChange: (next: ServerEntry) => void;
  readonly onRemove: () => void;
  readonly canRemove: boolean;
}) {
  const { routes } = useServers();
  const route = routes[server.id];
  const state = routeState(
    route !== undefined && route.baseUrl.length > 0,
    route?.path ?? null,
    route?.isProbing ?? false,
  );

  return (
    <View className="px-[18px] pb-4">
      <View className="flex-row items-center gap-2">
        <View
          style={{ backgroundColor: colorHex(server.color) }}
          className="h-2.5 w-2.5 rounded-full"
        />
        <TextInput
          value={server.name}
          accessibilityLabel="Nombre del host"
          onChangeText={name => onChange({ ...server, name })}
          placeholder="Nombre"
          placeholderTextColor="#cbd5e1"
          className="flex-1 text-[14px] font-semibold text-slate-900"
        />
        <Text
          className={`rounded-md px-2 py-1 text-[9px] font-bold uppercase tracking-wider ${
            state.dot === 'down'
              ? 'bg-rose-50 text-rose-700'
              : state.dot === 'remote'
              ? 'bg-blue-50 text-blue-700'
              : 'bg-emerald-50 text-emerald-700'
          }`}
        >
          {state.dot === 'remote' ? 'respaldo' : state.label}
        </Text>
      </View>

      <Field
        label="Dirección local"
        value={server.localUrl}
        onChange={localUrl => onChange({ ...server, localUrl })}
        placeholder="192.168.3.40:3111"
        hint="Se prueba primero. Es la rápida y no sale de tu red."
        mono
      />

      <Field
        label="Dirección de respaldo"
        value={server.remoteUrl}
        onChange={remoteUrl => onChange({ ...server, remoteUrl })}
        placeholder="https://algo.ts.net:10000"
        hint="Se usa solo si la local falla. Funciona desde datos móviles."
        mono
      />

      <Field
        label="Token"
        secure
        value={server.token}
        onChange={token => onChange({ ...server, token })}
        placeholder="64 caracteres hexadecimales"
        hint="El mismo para las dos direcciones: es del bridge, no de la ruta."
        mono
      />

      <Text className="mb-1.5 mt-3.5 text-[10.5px] font-semibold uppercase tracking-wide text-slate-500">
        Cuándo cambiar de ruta
      </Text>
      <View className="flex-row rounded-xl bg-slate-200 p-0.5">
        {MODES.map(mode => (
          <Pressable
            key={mode.value}
            accessibilityRole="button"
            accessibilityState={{ selected: server.mode === mode.value }}
            onPress={() => onChange({ ...server, mode: mode.value })}
            className={`flex-1 items-center rounded-[10px] py-1.5 ${
              server.mode === mode.value ? 'bg-white' : ''
            }`}
          >
            <Text
              className={`text-[11px] font-semibold ${
                server.mode === mode.value ? 'text-slate-900' : 'text-slate-500'
              }`}
            >
              {mode.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {server.mode === 'auto' ? (
        <Text className="mt-1 text-[10px] leading-4 text-slate-400">
          Reintenta la local cada 30 s y vuelve a ella en cuanto responda.
        </Text>
      ) : null}

      <View className="mt-3.5 flex-row items-center justify-between">
        <View className="flex-row gap-1.5">
          {SERVER_COLORS.map(color => (
            <Pressable
              key={color}
              accessibilityRole="button"
              accessibilityLabel={`Color ${color}`}
              onPress={() => onChange({ ...server, color })}
              className="p-0.5"
            >
              <View
                style={{ backgroundColor: colorHex(color) }}
                className={`h-5 w-5 rounded-full ${
                  server.color === color ? 'opacity-100' : 'opacity-30'
                }`}
              />
            </Pressable>
          ))}
        </View>
        {canRemove ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Quitar servidor"
            onPress={onRemove}
            className="rounded-lg px-2 py-1 active:bg-rose-50"
          >
            <Text className="text-[12px] font-semibold text-rose-600">
              Quitar
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export interface HostEditorSheetProps {
  readonly server: ServerEntry | null;
  readonly isNew: boolean;
  readonly isBusy: boolean;
  readonly error: string | null;
  readonly canRemove: boolean;
  readonly onChange: (server: ServerEntry) => void;
  readonly onSave: () => void;
  readonly onClose: () => void;
  readonly onRemove: () => void;
}

export function HostEditorSheet({
  server,
  isNew,
  isBusy,
  error,
  canRemove,
  onChange,
  onSave,
  onClose,
  onRemove,
}: HostEditorSheetProps) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const canSave =
    server !== null &&
    (server.localUrl.trim().length > 0 || server.remoteUrl.trim().length > 0) &&
    !isBusy;
  return (
    <Modal
      visible={server !== null}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior="padding"
        className="flex-1 justify-end bg-slate-900/40"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cerrar configuración del host"
          disabled={isBusy}
          onPress={onClose}
          className="absolute inset-0"
        />
        <View
          style={{
            maxHeight: height * 0.88,
            paddingBottom: insets.bottom + 12,
          }}
          className="shrink rounded-t-[28px] bg-white pt-3"
        >
          <View className="mx-auto mb-[18px] h-1 w-9 rounded-full bg-slate-200" />
          <Text className="px-[18px] text-[17px] font-bold text-slate-900">
            {isNew ? 'Añadir host' : 'Configurar host'}
          </Text>
          <Text className="px-[18px] pb-4 pt-1 text-xs leading-5 text-slate-500">
            {isNew
              ? 'Conecta otro equipo a tu espacio.'
              : 'Los cambios se aplican al guardar.'}
          </Text>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            pointerEvents={isBusy ? 'none' : 'auto'}
          >
            {server !== null ? (
              <ServerEditor
                server={server}
                onChange={onChange}
                onRemove={onRemove}
                canRemove={canRemove}
              />
            ) : null}
          </ScrollView>
          {error !== null ? (
            <Text
              accessibilityRole="alert"
              className="px-5 pb-2 text-xs leading-5 text-rose-600"
            >
              {error}
            </Text>
          ) : null}
          <View className="flex-row gap-3 border-t border-slate-100 px-[18px] pt-3">
            <Pressable
              accessibilityRole="button"
              disabled={isBusy}
              onPress={onClose}
              className="min-h-11 flex-1 items-center justify-center rounded-xl border border-slate-200 px-4"
            >
              <Text className="text-[13px] font-semibold text-slate-500">
                Cancelar
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Guardar host"
              accessibilityState={{ disabled: !canSave }}
              disabled={!canSave}
              onPress={onSave}
              className={`min-h-11 flex-[2] flex-row items-center justify-center gap-2 rounded-xl px-4 ${
                canSave || isBusy ? 'bg-slate-900' : 'bg-slate-200'
              }`}
            >
              {isBusy ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : null}
              <Text
                className={`text-[13px] font-semibold ${
                  canSave || isBusy ? 'text-white' : 'text-slate-400'
                }`}
              >
                {isBusy ? 'Guardando…' : 'Guardar'}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
