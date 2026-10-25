import { useRef, useState } from 'react';
import { Alert, Keyboard, Pressable, Text, View } from 'react-native';

import { HostCard } from '../components/HostCard';
import { useServers } from '../config/ServerConfigContext';
import { emptyServer, normalizeUrl, type ServerEntry } from '../config/servers';
import { HostEditorSheet } from './HostEditorSheet';
import { ScreenLayout } from './ScreenLayout';

export function SettingsScreen() {
  const { servers, routes, upsertServer, removeServer, refreshRoutes } =
    useServers();
  const [editing, setEditing] = useState<ServerEntry | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const connected = servers.filter(server =>
    Boolean(routes[server.id]?.baseUrl),
  ).length;
  const isNew =
    editing !== null && !servers.some(server => server.id === editing.id);

  const openEditor = (server: ServerEntry) => {
    setError(null);
    setEditing({ ...server });
  };
  const closeEditor = () => {
    if (!busy.current) {
      setEditing(null);
      setError(null);
    }
  };

  const save = async () => {
    if (
      editing === null ||
      busy.current ||
      (!editing.localUrl.trim() && !editing.remoteUrl.trim())
    ) {
      return;
    }
    busy.current = true;
    setIsBusy(true);
    setError(null);
    Keyboard.dismiss();
    try {
      await upsertServer({
        ...editing,
        name: editing.name.trim(),
        localUrl: normalizeUrl(editing.localUrl),
        remoteUrl: normalizeUrl(editing.remoteUrl),
        token: editing.token.trim(),
      });
      setEditing(null);
      refreshRoutes();
    } catch {
      setError('No se pudo guardar la configuración. Vuelve a intentarlo.');
    } finally {
      busy.current = false;
      setIsBusy(false);
    }
  };

  const remove = () => {
    if (editing === null || busy.current || servers.length <= 1 || isNew) {
      return;
    }
    const server = editing;
    Alert.alert(
      'Quitar host',
      `${
        server.name || 'Este host'
      } desaparece de la app. Sus conversaciones siguen en el equipo.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Quitar',
          style: 'destructive',
          onPress: async () => {
            if (busy.current) {
              return;
            }
            busy.current = true;
            setIsBusy(true);
            setError(null);
            Keyboard.dismiss();
            try {
              await removeServer(server.id);
              setEditing(null);
            } catch {
              setError('No se pudo quitar el host. Vuelve a intentarlo.');
            } finally {
              busy.current = false;
              setIsBusy(false);
            }
          },
        },
      ],
    );
  };

  return (
    <>
      <ScreenLayout title="Ajustes">
        <Text className="mb-4 text-xs leading-5 text-slate-500">
          Todos tus equipos, en un solo lugar. Toca un host para configurar su
          conexión.
        </Text>
        <View className="mb-2 flex-row items-center justify-between">
          <Text className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">
            Hosts
          </Text>
          <Text className="text-[11px] text-slate-400">
            {connected} de {servers.length} conectados
          </Text>
        </View>
        {servers.map(server => (
          <HostCard
            key={server.id}
            server={server}
            route={routes[server.id]}
            onPress={() => openEditor(server)}
          />
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Añadir host"
          onPress={() => openEditor(emptyServer(servers.length))}
          className="mb-3 min-h-11 items-center justify-center rounded-[14px] border border-dashed border-slate-300 bg-white px-3 py-2.5 active:bg-slate-50"
        >
          <Text className="text-xs font-semibold text-slate-600">
            ＋ Añadir host
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={refreshRoutes}
          className="min-h-11 items-center justify-center rounded-xl border border-slate-200 px-3 py-2.5 active:bg-slate-50"
        >
          <Text className="text-xs font-semibold text-slate-600">
            Probar conexiones
          </Text>
        </Pressable>
      </ScreenLayout>
      <HostEditorSheet
        server={editing}
        isNew={isNew}
        isBusy={isBusy}
        error={error}
        canRemove={!isNew && servers.length > 1}
        onChange={setEditing}
        onSave={save}
        onClose={closeEditor}
        onRemove={remove}
      />
    </>
  );
}
