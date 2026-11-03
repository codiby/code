import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  DIRECT_TTL_MS,
  directHandoff,
  directPrompt,
  loadDirectContext,
  parseDirectRecommendation,
  type DirectContext,
  type DirectRecommendation,
} from '../api/directChat';
import { invalidateHome } from '../api/home';
import { sendMessage } from '../api/messages';
import { PROVIDERS } from '../api/providers';
import { createSession, setSessionStatus } from '../api/sessions';
import type { ChatMessage, MessageImage, SessionSummary } from '../api/types';
import { BackIcon, Composer, SparkIcon } from '../components/Chat';
import { useServers } from '../config/ServerConfigContext';
import { NewSessionSheet, type NewSessionSheetProps } from './NewSessionSheet';
import { SessionChatScreen } from './SessionChatScreen';

interface ChatScreenProps {
  readonly onOpenSession: (session: SessionSummary) => void;
  readonly onBack: () => void;
}

interface StartedChat {
  readonly session: SessionSummary;
  readonly context: DirectContext;
}

/** El agente recomienda; solo un toque del usuario transfiere la petición. */
function Destination({
  messages,
  context,
  busy,
  onContinue,
  onNew,
}: {
  messages: ChatMessage[];
  context: DirectContext;
  busy: boolean;
  onContinue: (
    session: SessionSummary,
    messages: ChatMessage[],
  ) => Promise<void>;
  onNew: (
    recommendation: DirectRecommendation | null,
    messages: ChatMessage[],
  ) => void;
}) {
  const [showOthers, setShowOthers] = useState(false);
  const [query, setQuery] = useState('');
  // Una nueva respuesta invalida la propuesta anterior, incluso si no trae ruta.
  const last = [...messages]
    .reverse()
    .find(
      m =>
        m.role === 'assistant' &&
        !m.toolName &&
        !m.isToolResult &&
        !m.isThinking,
    );
  if (!last) {
    return null;
  }
  const recommendation = parseDirectRecommendation(last.content, context);
  const serverId =
    recommendation?.kind === 'continue'
      ? recommendation.session.serverId
      : recommendation?.serverId;
  const host = context.hosts.find(h => h.id === serverId);
  const title =
    recommendation?.kind === 'continue'
      ? recommendation.session.name
      : recommendation?.title;
  return (
    <View className="mx-4 my-2.5">
      {recommendation ? (
        <View className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <View className="flex-row items-center gap-2 bg-slate-50 px-3 py-2.5">
            <SparkIcon size={14} color="#475569" />
            <Text className="flex-1 text-[11px] font-semibold text-slate-600">
              {recommendation.kind === 'continue'
                ? 'Continue conversation'
                : 'New conversation'}
            </Text>
            <Text className="text-[10px] text-slate-400">Recommended</Text>
          </View>
          <View className="p-[13px]">
            <Text className="text-[13px] font-semibold text-slate-900">
              {title}
            </Text>
            <Text className="mt-2 text-[11px] text-slate-500">
              {host?.name} ·{' '}
              {recommendation.kind === 'continue'
                ? recommendation.session.folder
                : recommendation.cwd}
            </Text>
            <Text className="my-3 text-[12px] leading-[18px] text-slate-500">
              {recommendation.reason}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() =>
                recommendation.kind === 'continue'
                  ? onContinue(recommendation.session, messages)
                  : onNew(recommendation, messages)
              }
              className="min-h-11 flex-row items-center justify-center gap-2 rounded-xl bg-slate-900 px-3 py-3 active:opacity-70"
            >
              {busy ? <ActivityIndicator size="small" color="#ffffff" /> : null}
              <Text className="text-[12px] font-semibold text-white">
                {recommendation.kind === 'continue'
                  ? 'Continue here →'
                  : `Create on ${host?.name ?? 'this host'} →`}
              </Text>
            </Pressable>
            {recommendation.kind === 'continue' ? (
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => onNew(recommendation, messages)}
                className="mt-2 min-h-11 items-center justify-center rounded-xl border border-slate-200 p-3"
              >
                <Text className="text-[12px] font-medium text-slate-600">
                  ＋ Create a new conversation
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => onNew(null, messages)}
          className="rounded-xl border border-slate-200 bg-white p-3"
        >
          <Text className="text-center text-[12px] font-medium text-slate-600">
            Create a conversation with this request
          </Text>
        </Pressable>
      )}
      <Pressable
        accessibilityRole="button"
        onPress={() => setShowOthers(!showOthers)}
        className="min-h-11 items-center justify-center p-3"
      >
        <Text className="text-[11px] text-slate-500">
          {showOthers ? 'Hide conversations' : 'Choose another conversation'}
        </Text>
      </Pressable>
      {showOthers ? (
        <View className="rounded-2xl border border-slate-200 bg-white p-3">
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search conversations or projects"
            placeholderTextColor="#94a3b8"
            accessibilityLabel="Search for another conversation"
            className="mb-2 rounded-xl bg-slate-100 px-3 py-2 text-[12px] text-slate-900"
          />
          {context.sessions
            .filter(s =>
              `${s.name} ${s.cwd}`.toLowerCase().includes(query.toLowerCase()),
            )
            .slice(0, 15)
            .map(s => (
              <Pressable
                key={s.key}
                accessibilityRole="button"
                disabled={busy}
                onPress={() => onContinue(s, messages)}
                className="border-b border-slate-100 py-3"
              >
                <Text className="text-[12px] font-semibold text-slate-700">
                  {s.name}
                </Text>
                <Text className="mt-1 text-[10px] text-slate-400">
                  {context.hosts.find(h => h.id === s.serverId)?.name} ·{' '}
                  {s.folder}
                </Text>
              </Pressable>
            ))}
        </View>
      ) : null}
      <Text className="mt-2 text-center text-[10px] leading-4 text-slate-400">
        This chat is temporary. Your request will be taken to the conversation
        you choose.
      </Text>
    </View>
  );
}

export function ChatScreen({ onOpenSession, onBack }: ChatScreenProps) {
  const insets = useSafeAreaInsets();
  const [headerHeight, setHeaderHeight] = useState(insets.top + 72);
  const { servers, routes, isLoaded } = useServers();
  const [chat, setChat] = useState<StartedChat | null>(null);
  // Se retiene si el primer envío falla: reintentar no crea otra sesión.
  const started = useRef<StartedChat | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [serverId, setServerId] = useState('');
  const [showHosts, setShowHosts] = useState(false);
  const [initial, setInitial] = useState<NewSessionSheetProps['initial']>();
  const reachable = servers.filter(s => !!routes[s.id]?.baseUrl);
  const selected = reachable.find(s => s.id === serverId) ?? reachable[0];

  const start = async (text: string, images: MessageImage[]) => {
    if (busyRef.current) {
      throw new Error('Wait for the current send to finish');
    }
    if (!selected) {
      throw new Error(
        'No host is responding. Check the connections in Settings.',
      );
    }
    busyRef.current = true;
    setBusy(true);
    try {
      let pending = started.current;
      if (!pending) {
        setStage('Searching your hosts for context…');
        const targets = reachable.map(s => ({
          id: s.id,
          name: s.name,
          baseUrl: routes[s.id]!.baseUrl,
          token: routes[s.id]!.token,
        }));
        const context = await loadDirectContext(targets, text);
        const host = context.hosts.find(h => h.id === selected.id);
        if (!host?.home) {
          throw new Error(
            "Could not read the host's folder. Try again.",
          );
        }
        const saved = await AsyncStorage.getItem(
          'codiby.new-session-provider',
        ).catch(() => null);
        const provider = PROVIDERS.find(p => p === saved) ?? 'claude';
        setStage('Opening your temporary agent…');
        const session = await createSession(host.baseUrl, host.token, host.id, {
          cwd: host.home,
          name: 'Direct chat',
          provider,
          model: null,
          disposableTtlMs: DIRECT_TTL_MS,
        });
        pending = { session, context };
        started.current = pending;
        invalidateHome();
      }
      const route = routes[pending.session.serverId];
      if (!route?.baseUrl) {
        throw new Error("The temporary chat's host isn't responding");
      }
      setStage('Sending your request…');
      await sendMessage(
        route.baseUrl,
        pending.session.id,
        route.token,
        directPrompt(text, pending.context),
        images,
      );
      setChat(pending);
    } finally {
      busyRef.current = false;
      setBusy(false);
      setStage('');
    }
  };

  const finish = (session: SessionSummary) => {
    const pending = started.current;
    // El destino ya recibió la petición. Un fallo al archivar no debe repetirla.
    if (pending) {
      const route = routes[pending.session.serverId];
      if (route?.baseUrl) {
        setSessionStatus(
          route.baseUrl,
          route.token,
          pending.session.id,
          'archived',
        ).catch(() => undefined);
      }
    }
    started.current = null;
    setChat(null);
    setInitial(undefined);
    invalidateHome();
    onOpenSession(session);
  };

  const continueIn = async (
    session: SessionSummary,
    messages: ChatMessage[],
  ) => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const route = routes[session.serverId];
      if (!route?.baseUrl) {
        throw new Error("The conversation's host isn't responding");
      }
      const handoff = directHandoff(messages);
      if (!session.isOpen) {
        await setSessionStatus(route.baseUrl, route.token, session.id, 'open');
      }
      await sendMessage(
        route.baseUrl,
        session.id,
        route.token,
        handoff.text,
        handoff.images,
      );
      finish({ ...session, isOpen: true });
    } catch (error) {
      Alert.alert(
        'Could not continue',
        error instanceof Error ? error.message : 'Try again',
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const newConversation = (
    recommendation: DirectRecommendation | null,
    messages: ChatMessage[],
  ) => {
    if (busyRef.current || !chat) {
      return;
    }
    const session =
      recommendation?.kind === 'continue' ? recommendation.session : null;
    const id =
      recommendation?.kind === 'new'
        ? recommendation.serverId
        : session?.serverId ?? chat.session.serverId;
    const home = chat.context.hosts.find(h => h.id === id)?.home ?? '';
    const handoff = directHandoff(messages);
    setInitial({
      serverId: id,
      cwd:
        recommendation?.kind === 'new'
          ? recommendation.cwd
          : session?.cwd ?? home,
      name: recommendation?.kind === 'new' ? recommendation.title : '',
      ...handoff,
    });
  };

  const hostName = servers.find(s => s.id === chat?.session.serverId)?.name;
  const hostControl = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Choose the temporary chat's host"
      disabled={busy || !!started.current}
      onPress={() => setShowHosts(true)}
      className="min-h-10 flex-row items-center gap-1"
    >
      <SparkIcon size={13} color="#64748b" />
      <Text
        numberOfLines={1}
        className="flex-shrink text-[11px] text-slate-500"
      >
        {chat
          ? hostName
          : serverId
          ? selected?.name
          : `Automatic · ${reachable.length} hosts`}{' '}
        {chat ? '' : '⌄'}
      </Text>
    </Pressable>
  );
  const header = (
    <View
      style={{ paddingTop: insets.top + 8 }}
      onLayout={event => setHeaderHeight(event.nativeEvent.layout.height)}
      className="flex-row items-center gap-2.5 border-b border-slate-200 bg-white px-2 pb-2.5"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to conversations"
        onPress={onBack}
        className="h-10 w-10 items-center justify-center rounded-full active:bg-slate-100"
      >
        <BackIcon size={24} color="#0f172a" />
      </Pressable>
      <View className="h-[34px] w-[34px] items-center justify-center rounded-full bg-slate-900">
        <SparkIcon size={20} color="#ffffff" />
      </View>
      <View className="flex-1">
        <Text className="text-[14px] font-semibold text-slate-900">
          Direct chat
        </Text>
        <Text className="mt-1 text-[11px] text-slate-500">
          Temporary agent · ends after 1 h idle
        </Text>
      </View>
    </View>
  );

  return (
    <View className="flex-1 bg-slate-100">
      {chat ? (
        <SessionChatScreen
          key={chat.session.key}
          session={chat.session}
          onClose={onBack}
          directChat={{
            header,
            busy,
            context: hostControl,
            renderDestination: messages => (
              <Destination
                messages={messages}
                context={chat.context}
                busy={busy}
                onContinue={continueIn}
                onNew={newConversation}
              />
            ),
          }}
        />
      ) : (
        <>
          {header}
          <View className="flex-1" style={{ paddingBottom: insets.bottom }}>
            <KeyboardAvoidingView
              behavior="padding"
              keyboardVerticalOffset={headerHeight}
              className="flex-1"
            >
              <ScrollView
                keyboardShouldPersistTaps="handled"
                contentContainerClassName="grow px-[21px] pt-[34px] pb-5"
              >
                <View className="mb-[19px] h-10 w-10 items-center justify-center rounded-[14px] border border-slate-200 bg-white">
                  <SparkIcon size={21} color="#475569" />
                </View>
                <Text className="text-[26px] font-bold leading-8 tracking-tight text-slate-900">
                  What are we doing today?
                </Text>
                <Text className="mt-3 text-[13px] leading-[22px] text-slate-500">
                  Tell me your idea. I'll check whether there's already a
                  conversation worth continuing, and on which host.
                </Text>
                <Text className="mt-[18px] text-[11px] leading-[18px] text-slate-400">
                  Conversations you open or create are saved on their host.
                  This chat is disposable.
                </Text>
                {busy ? (
                  <View className="mt-7 flex-row items-center gap-3">
                    <ActivityIndicator color="#64748b" />
                    <Text className="flex-1 text-[12px] text-slate-500">
                      {stage}
                    </Text>
                  </View>
                ) : null}
                {isLoaded && !reachable.length ? (
                  <Text className="mt-6 text-[12px] leading-5 text-amber-700">
                    No host is responding. Check the connections in Settings.
                  </Text>
                ) : null}
              </ScrollView>
              <Composer
                onSend={start}
                disabled={busy || !isLoaded || !reachable.length}
                placeholder="What do you want to do?"
                context={hostControl}
              />
            </KeyboardAvoidingView>
          </View>
        </>
      )}
      <Modal
        visible={showHosts}
        transparent
        animationType="slide"
        onRequestClose={() => setShowHosts(false)}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close host picker"
          onPress={() => setShowHosts(false)}
          className="flex-1 bg-slate-900/40"
        />
        <View
          style={{ paddingBottom: insets.bottom + 24 }}
          className="rounded-t-3xl bg-white p-5"
        >
          <Text className="mb-4 text-lg font-bold text-slate-900">
            Temporary agent host
          </Text>
          <Text className="mb-4 text-[12px] leading-5 text-slate-500">
            Context will be gathered from every available host. Where your work
            goes is decided afterwards.
          </Text>
          {[{ id: '', name: 'Automatic' }, ...reachable].map(s => (
            <Pressable
              key={s.id}
              accessibilityRole="button"
              accessibilityState={{ selected: serverId === s.id }}
              onPress={() => {
                setServerId(s.id);
                setShowHosts(false);
              }}
              className="mb-2 flex-row items-center justify-between rounded-xl border border-slate-200 p-4"
            >
              <Text className="text-[13px] text-slate-700">{s.name}</Text>
              <Text className="text-slate-500">
                {serverId === s.id ? '✓' : ''}
              </Text>
            </Pressable>
          ))}
        </View>
      </Modal>
      <NewSessionSheet
        visible={initial !== undefined}
        sessions={chat?.context.sessions ?? []}
        initial={initial}
        onCancel={() => setInitial(undefined)}
        onCreated={finish}
      />
    </View>
  );
}
