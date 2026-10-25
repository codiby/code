import { Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useServers } from '../config/ServerConfigContext';
import { colorHex, ROUTE_DOT, routeState, shortUrl } from '../config/servers';

export interface ServerSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly onRetry: () => void;
}

/**
 * Hoja de servidores: dice por dónde entra cada uno y deja reintentar.
 *
 * No filtra la lista a propósito. Si al tocar un servidor se ocultaran los
 * demás, volveríamos a los chips — que es justo lo que se quitó para poder
 * verlo todo junto.
 */
export function ServerSheet({ visible, onClose, onRetry }: ServerSheetProps) {
  const { servers, routes } = useServers();
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cerrar"
        onPress={onClose}
        className="flex-1 bg-slate-900/45"
      />
      <View
        style={{ paddingBottom: insets.bottom + 18 }}
        className="rounded-t-3xl bg-white pt-2"
      >
        <View className="mx-auto mb-3 h-1 w-9 rounded-full bg-slate-300" />
        <Text className="px-5 text-[15px] font-bold text-slate-900">
          Servidores
        </Text>
        <Text className="px-5 pb-3 pt-1 text-[11.5px] leading-4 text-slate-500">
          Todos se consultan a la vez. Aquí solo se ve por dónde entra cada uno;
          la lista no se filtra.
        </Text>

        {servers.map(server => {
          const route = routes[server.id];
          const isUp = route !== undefined && route.baseUrl.length > 0;
          const state = routeState(isUp, route?.path ?? null, route?.isProbing ?? false);
          // En la hoja se dice «respaldo» en vez de «internet»: aquí se está
          // hablando de la configuración, no de por dónde sale el tráfico.
          const label = state.dot === 'remote' ? 'respaldo' : state.label;
          return (
            <View
              key={server.id}
              className="flex-row items-center gap-3 border-t border-slate-100 px-5 py-3"
            >
              <View style={ROUTE_DOT[state.dot]} className="h-2 w-2 rounded-full" />
              <View className="flex-1">
                <Text
                  style={{ color: colorHex(server.color) }}
                  className="text-sm font-semibold"
                >
                  {server.name.length > 0 ? server.name : 'Sin nombre'}
                </Text>
                <Text numberOfLines={1} className="mt-0.5 text-[10.5px] text-slate-400">
                  {isUp
                    ? `${shortUrl(route!.baseUrl)}${
                        route!.latencyMs !== null ? ` · ${route!.latencyMs} ms` : ''
                      }`
                    : 'ninguna ruta responde'}
                </Text>
              </View>
              <Text
                className={`rounded-md px-2 py-1 text-[9px] font-bold uppercase tracking-wider ${
                  state.dot === 'down'
                    ? 'bg-rose-50 text-rose-700'
                    : state.dot === 'remote'
                      ? 'bg-blue-50 text-blue-700'
                      : 'bg-emerald-50 text-emerald-700'
                }`}
              >
                {label}
              </Text>
            </View>
          );
        })}

        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          className="mt-1 border-t border-slate-100 px-5 py-3 active:bg-slate-50"
        >
          <Text className="text-[13px] font-semibold text-slate-600">
            Volver a probar todas las rutas
          </Text>
        </Pressable>
      </View>
    </Modal>
  );
}
