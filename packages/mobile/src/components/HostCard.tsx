import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import type { ServerRoute } from '../api/useServerRoutes';
import { colorHex, shortUrl, type ServerEntry } from '../config/servers';

export function HostCard({
  server,
  route,
  onPress,
}: {
  readonly server: ServerEntry;
  readonly route?: ServerRoute;
  readonly onPress: () => void;
}) {
  const isUp = Boolean(route?.baseUrl);
  const isProbing = !isUp && route?.isProbing;
  const name = server.name.trim() || 'Sin nombre';
  const status = isUp ? 'En línea' : isProbing ? 'Conectando' : 'Sin conexión';
  const address = isUp ? route!.baseUrl : server.localUrl || server.remoteUrl;
  const path = isUp
    ? route?.path === 'remote'
      ? 'Internet'
      : 'Local'
    : 'Host';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Configurar host ${name}`}
      accessibilityHint={`${status}. Abrir configuración`}
      onPress={onPress}
      className="mb-2 flex-row items-center gap-2.5 rounded-[14px] border border-slate-200 bg-white p-3 active:opacity-70"
    >
      <View className="h-[35px] w-[35px] items-center justify-center rounded-[11px] bg-slate-100">
        <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
          <Rect
            x={3}
            y={4}
            width={18}
            height={13}
            rx={2}
            stroke={colorHex(server.color)}
            strokeWidth={1.7}
          />
          <Path
            d="M8 21h8m-4-4v4"
            stroke={colorHex(server.color)}
            strokeWidth={1.7}
            strokeLinecap="round"
          />
        </Svg>
      </View>
      <View className="flex-1">
        <Text
          numberOfLines={1}
          className="text-[13px] font-semibold text-slate-900"
        >
          {name}
        </Text>
        <Text numberOfLines={1} className="mt-[5px] text-[10px] text-slate-400">
          {address
            ? `${path} · ${shortUrl(address)}`
            : 'Sin dirección configurada'}
        </Text>
      </View>
      <View className="items-end gap-1">
        <View className="flex-row items-center gap-1.5">
          {isProbing ? (
            <ActivityIndicator size="small" color="#94a3b8" />
          ) : (
            <View
              className={`h-1.5 w-1.5 rounded-full ${
                isUp ? 'bg-emerald-500' : 'bg-rose-400'
              }`}
            />
          )}
          <Text
            className={`text-[10px] font-medium ${
              isUp ? 'text-emerald-700' : 'text-slate-500'
            }`}
          >
            {status}
          </Text>
        </View>
        {isUp && route?.latencyMs != null ? (
          <Text className="text-[10px] text-slate-400">
            {route.latencyMs} ms
          </Text>
        ) : null}
      </View>
      <Text className="text-base text-slate-300">›</Text>
    </Pressable>
  );
}
