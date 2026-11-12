import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  KeyboardAvoidingView,
  Pressable,
  StatusBar,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import type { MessageImage } from './api/types';
import { Composer } from './components/Chat/Composer';
import { BackIcon } from './components/Chat/icons';
import { CloseIcon, SearchIcon } from './components/SessionList/icons';
import {
  SessionRow,
  SessionRowSeparator,
} from './components/SessionList/SessionRow';
import { colorHex } from './config/servers';
import {
  fetchShareHost,
  incomingShare,
  parseShareChats,
  sendIncomingShare,
  sortShareChats,
  type IncomingShare,
  type ShareChats,
} from './lib/incomingShare';
import './global.css';
import { useIsDark } from './theme';
import { applyThemePreference, loadThemePreference } from './themePreference';
import { useInk } from './theme';

loadThemePreference().then(applyThemePreference);

function ThemedStatusBar() {
  const dark = useIsDark();
  return <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />;
}

export default function ShareApp({ requestId = '' }: { requestId?: string }) {
  return (
    <View className="flex-1">
      <SafeAreaProvider>
        <ThemedStatusBar />
        <ShareScreen requestId={requestId} />
      </SafeAreaProvider>
    </View>
  );
}

export function ShareScreen({ requestId = '' }: { requestId?: string }) {
  const ink = useInk();
  const insets = useSafeAreaInsets();
  const [payload, setPayload] = useState<IncomingShare | null>(null);
  const [chats, setChats] = useState<ShareChats | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [manualRefresh, setManualRefresh] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const generation = useRef(0);

  const close = useCallback(() => {
    if (!busy.current) {
      incomingShare
        .finish(requestId, false)
        .catch(() => setError('Could not close. Try again.'));
    }
  }, [requestId]);
  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => back.remove();
  }, [close]);

  const refresh = useCallback(async (initial: ShareChats, manual = false) => {
    setManualRefresh(manual);
    const run = ++generation.current;
    setRefreshing(true);
    setFailed([]);
    await Promise.all(
      initial.hosts.map(async host => {
        try {
          const live = await fetchShareHost(host);
          if (generation.current !== run) {
            return;
          }
          setChats(
            current =>
              current && {
                ...current,
                sessions: [
                  ...current.sessions.filter(
                    session => session.serverId !== host.id,
                  ),
                  ...live.sessions,
                ],
              },
          );
        } catch {
          if (generation.current === run) {
            setFailed(current => [...current, host.name]);
          }
        }
      }),
    );
    if (generation.current === run) {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    incomingShare
      .read(requestId)
      .then(value => {
        if (!alive) {
          return;
        }
        const saved = parseShareChats(value);
        if (value.images.length < 1 || value.images.length > 4) {
          throw new Error('Share between 1 and 4 images.');
        }
        setPayload(value);
        setChats(saved);
        refresh(saved);
      })
      .catch(cause => {
        if (alive) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not read the images.',
          );
        }
      });
    const activeGeneration = generation;
    return () => {
      alive = false;
      activeGeneration.current++;
    };
  }, [refresh, requestId]);

  const sessions = chats
    ? sortShareChats(chats.sessions, chats.pinnedIds, query)
    : [];
  const chosen = chats?.sessions.find(
    session => session.key === selected && session.isOpen,
  );
  const send = async (text: string, images: MessageImage[]) => {
    if (!chosen || !chats || busy.current || sent) {
      return;
    }
    const host = chats.hosts.find(item => item.id === chosen.serverId);
    if (!host) {
      throw new Error('This host is no longer configured.');
    }
    busy.current = true;
    setSending(true);
    try {
      await sendIncomingShare(host, chosen, text, images);
      setSent(true);
      incomingShare.finish(requestId, true).catch(() => undefined);
    } finally {
      busy.current = false;
      setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-white">
      <View
        style={{ paddingTop: insets.top + 14 }}
        className="bg-white px-[18px] pb-[11px]"
      >
        <View className="flex-row items-center gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            onPress={close}
            disabled={sending}
            className="h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
          >
            <BackIcon size={20} color={ink('#475569')} />
          </Pressable>
          <Text className="flex-1 text-[23px] font-bold tracking-tight text-slate-900">
            Send to…
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              searching ? 'Close search' : 'Search sessions'
            }
            disabled={sending}
            onPress={() => {
              setSearching(!searching);
              setQuery('');
            }}
            className="h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
          >
            {searching ? (
              <CloseIcon size={18} color={ink('#475569')} />
            ) : (
              <SearchIcon size={20} color={ink('#475569')} />
            )}
          </Pressable>
        </View>
        {searching ? (
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search…"
            accessibilityLabel="Search chats"
            placeholderTextColor={ink('#94a3b8')}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] leading-5 text-slate-900"
          />
        ) : null}
        <Text className="mt-1 text-[11px] text-slate-500">
          {chosen ? chosen.name : 'Select a conversation from Home'}
        </Text>
      </View>
      {error ? (
        <View className="m-3 rounded-xl bg-rose-100 p-3">
          <Text className="text-sm text-rose-700">{error}</Text>
        </View>
      ) : null}
      {sent ? (
        <View className="flex-1 items-center justify-center gap-3">
          <Text className="text-slate-900">Image sent</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => incomingShare.finish(requestId, true)}
          >
            <Text className="font-semibold text-slate-700">Close</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <FlatList
            data={sessions}
            keyExtractor={session => session.key}
            keyboardShouldPersistTaps="handled"
            extraData={selected}
            ItemSeparatorComponent={SessionRowSeparator}
            renderItem={({ item }) => {
              const host = chats?.hosts.find(
                candidate => candidate.id === item.serverId,
              );
              return (
                <SessionRow
                  session={item}
                  onPress={() => {
                    if (!busy.current) {
                      setSelected(item.key === selected ? null : item.key);
                    }
                  }}
                  isSelected={selected === item.key}
                  isPinned={chats?.pinnedIds.includes(item.key)}
                  preview={chats?.previews[item.key]}
                  serverName={host?.name}
                  serverColor={colorHex(host?.color ?? 'green')}
                />
              );
            }}
            refreshing={refreshing && manualRefresh}
            onRefresh={() => {
              if (chats && !busy.current) {
                refresh(chats, true);
              }
            }}
            ListEmptyComponent={
              <View className="items-center gap-3 px-6 py-12">
                {!error && (!payload || refreshing) ? (
                  <ActivityIndicator color={ink('#64748b')} />
                ) : null}
                <Text className="text-center text-sm text-slate-500">
                  {error
                    ? 'Share the image again to retry.'
                    : !payload
                    ? 'Preparing images…'
                    : !chats?.hosts.length
                    ? 'Open Codiby Code Home to sync your chats.'
                    : refreshing
                    ? 'Loading conversations…'
                    : query
                    ? 'No matching conversations.'
                    : 'No chats available. Pull down to refresh.'}
                </Text>
              </View>
            }
          />
          {failed.length ? (
            <Text className="px-[18px] py-2 text-[11px] text-slate-500">
              Offline: {failed.join(', ')}. Your recent chats are kept.
            </Text>
          ) : null}
          <View style={{ paddingBottom: insets.bottom }}>
            {payload ? (
              <Composer
                initialImages={payload.images}
                initialText={payload.text}
                onSend={send}
                sendDisabled={!chosen}
                disabled={sending}
                allowAttachments={false}
                placeholder="Add a message…"
                context={
                  <Text
                    numberOfLines={1}
                    className="text-[11px] text-slate-500"
                  >
                    {chosen?.name ?? 'Choose a chat to send to'}
                  </Text>
                }
              />
            ) : null}
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  );
}
