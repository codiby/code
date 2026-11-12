import { useEffect, useRef, useState } from 'react';
import { Alert, Keyboard, Pressable, Text, View } from 'react-native';

import { HostCard } from '../components/HostCard';
import {
  loadThemePreference,
  saveThemePreference,
  type ThemePreference,
} from '../themePreference';
import { useServers } from '../config/ServerConfigContext';
import { emptyServer, normalizeUrl, type ServerEntry } from '../config/servers';
import { HostEditorSheet } from './HostEditorSheet';
import { ScreenLayout } from './ScreenLayout';

const THEMES: [ThemePreference, string][] = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

export function SettingsScreen() {
  const { servers, routes, upsertServer, removeServer, refreshRoutes } =
    useServers();
  const [editing, setEditing] = useState<ServerEntry | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const [theme, setTheme] = useState<ThemePreference>('system');
  useEffect(() => {
    loadThemePreference().then(setTheme);
  }, []);
  const chooseTheme = (value: ThemePreference) => {
    setTheme(value);
    saveThemePreference(value);
  };
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
      setError('Could not save the settings. Try again.');
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
      'Remove host',
      `${
        server.name || 'This host'
      } will be removed from the app. Its conversations stay on the machine.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
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
              setError('Could not remove the host. Try again.');
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
      <ScreenLayout title="Settings">
        <Text className="mb-4 text-xs leading-5 text-slate-500">
          All your machines in one place. Tap a host to configure its
          connection.
        </Text>
        <View className="mb-2 flex-row items-center justify-between">
          <Text className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">
            Hosts
          </Text>
          <Text className="text-[11px] text-slate-400">
            {connected} of {servers.length} connected
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
          accessibilityLabel="Add host"
          onPress={() => openEditor(emptyServer(servers.length))}
          className="mb-3 h-11 items-center justify-center rounded-[22px] border border-dashed border-slate-300 px-3 active:bg-slate-100"
        >
          <Text className="text-xs font-semibold text-slate-600">
            ＋ Add host
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={refreshRoutes}
          className="h-11 items-center justify-center rounded-[22px] bg-slate-100 px-3 active:opacity-70"
        >
          <Text className="text-xs font-semibold text-slate-600">
            Test connections
          </Text>
        </Pressable>
        <Text className="mb-2 mt-7 text-[11px] font-semibold uppercase tracking-widest text-slate-500">
          Appearance
        </Text>
        <View className="flex-row rounded-[22px] bg-slate-100 p-1">
          {THEMES.map(([value, label]) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: theme === value }}
              accessibilityLabel={`${label} theme`}
              onPress={() => chooseTheme(value)}
              className={`h-9 flex-1 items-center justify-center rounded-[18px] ${
                theme === value ? 'bg-tint' : ''
              }`}
            >
              <Text
                className={`text-[12.5px] font-semibold ${
                  theme === value ? 'text-accent' : 'text-slate-500'
                }`}
              >
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
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
