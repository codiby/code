import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
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
import { LATEST_SEQ, fetchMessages, sendMessage } from '../api/messages';
import { readMessages, writeMessages } from '../api/messageStore';
import { PROVIDERS } from '../api/providers';
import {
  createSession,
  deleteSession,
  fetchSessions,
  keepSession,
  setSessionStatus,
} from '../api/sessions';
import type { ChatMessage, MessageImage, SessionSummary } from '../api/types';
import { BackIcon, Composer, SparkIcon } from '../components/Chat';
import { useServers } from '../config/ServerConfigContext';
import { useInk } from '../theme';
import { NewSessionSheet, type NewSessionSheetProps } from './NewSessionSheet';
import { SessionChatScreen } from './SessionChatScreen';
import type { OpenSessionOptions } from '../App';

/** Cuánto se espera la precarga del destino antes de animar sin ella. */
const PREFETCH_TIMEOUT_MS = 1_500;
/** Encabezado y tarjeta se transforman; luego `App` funde el destino encima. */
const MORPH_MS = 220;

const sleep = (ms: number) => new Promise<null>(resolve => setTimeout(() => resolve(null), ms));

interface ChatScreenProps {
  readonly onOpenSession: (
    session: SessionSummary,
    options?: OpenSessionOptions,
  ) => void;
  readonly onBack: () => void;
}

async function savedProvider() {
  const saved = await AsyncStorage.getItem('codiby.new-session-provider').catch(
    () => null,
  );
  return PROVIDERS.find(p => p === saved) ?? 'claude';
}

interface StartedChat {
  readonly session: SessionSummary;
  readonly context: DirectContext;
}

/**
 * El agente decide y la app ejecuta: una ruta válida al cerrar el turno se
 * aplica sola. La tarjeta solo queda como respaldo si ese envío falla.
 */
function Destination({
  messages,
  context,
  busy,
  failed,
  hereServerId,
  morph,
  onAuto,
  onDeliver,
  onContinue,
  onNew,
}: {
  /** 0 → 1 mientras el chat se funde en el destino: la tarjeta se desvanece. */
  morph: Animated.Value;
  onDeliver: (
    recommendation: DirectRecommendation,
    messages: ChatMessage[],
  ) => Promise<boolean>;
  messages: ChatMessage[];
  context: DirectContext;
  busy: boolean;
  /** IDs de respuestas cuya ruta automática ya falló una vez. */
  failed: ReadonlySet<string>;
  /** Host del chat temporal: donde se queda una ruta «here». */
  hereServerId: string;
  onAuto: (
    messageId: string,
    recommendation: DirectRecommendation,
    messages: ChatMessage[],
  ) => void;
  onContinue: (
    session: SessionSummary,
    messages: ChatMessage[],
  ) => Promise<void>;
  onNew: (
    recommendation: DirectRecommendation | null,
    messages: ChatMessage[],
  ) => void;
}) {
  const ink = useInk();
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
  const recommendation = last
    ? parseDirectRecommendation(last.content, context)
    : null;
  const autoId = recommendation && last ? last.id : null;
  useEffect(() => {
    if (autoId && recommendation) {
      onAuto(autoId, recommendation, messages);
    }
    // Solo una respuesta nueva dispara el ruteo; `onAuto` evita repetirlo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoId]);
  if (!last) {
    return null;
  }
  const routing = !!autoId && !failed.has(autoId);
  const serverId =
    recommendation?.kind === 'continue'
      ? recommendation.session.serverId
      : recommendation?.kind === 'new'
      ? recommendation.serverId
      : hereServerId;
  const host = context.hosts.find(h => h.id === serverId);
  const title =
    recommendation?.kind === 'continue'
      ? recommendation.session.name
      : recommendation?.title;
  return (
    <Animated.View
      style={{
        opacity: morph.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
        transform: [
          {
            scale: morph.interpolate({
              inputRange: [0, 1],
              outputRange: [1, 0.97],
            }),
          },
        ],
      }}
      className="mx-4 my-3"
    >
      {recommendation ? (
        <View className="overflow-hidden rounded-[20px] bg-slate-100">
          <View className="flex-row items-center gap-2 px-3.5 pt-3">
            <SparkIcon size={14} color={ink('#475569')} />
            <Text className="flex-1 text-[11px] font-semibold text-slate-500">
              {recommendation.kind === 'continue'
                ? 'Continue conversation'
                : recommendation.kind === 'here'
                ? 'Keep this conversation'
                : 'New conversation'}
            </Text>
            <Text className="text-[11px] font-semibold text-accent">
              {routing ? 'Moving your request…' : 'Could not move it'}
            </Text>
          </View>
          <View className="px-3.5 pb-3.5 pt-2">
            <Text className="text-[14.5px] font-semibold tracking-[-0.3px] text-slate-900">
              {title}
            </Text>
            <Text className="mt-0.5 text-[12px] text-slate-500">
              {host?.name}
              {recommendation.kind === 'continue'
                ? ` · ${recommendation.session.folder}`
                : recommendation.kind === 'new'
                ? ` · ${recommendation.cwd}`
                : ''}
            </Text>
            <Text className="my-2.5 text-[12.8px] leading-[18px] text-slate-500">
              {recommendation.reason}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => onDeliver(recommendation, messages)}
              className="h-11 flex-row items-center justify-center gap-2 rounded-[22px] bg-accent px-4 active:opacity-80"
            >
              {busy ? <ActivityIndicator size="small" color={ink('#ffffff')} /> : null}
              <Text className="text-[13px] font-semibold text-on-accent">
                {routing
                  ? recommendation.kind === 'continue'
                    ? 'Continuing here…'
                    : recommendation.kind === 'here'
                    ? 'Saving this conversation…'
                    : `Creating on ${host?.name ?? 'this host'}…`
                  : recommendation.kind === 'new'
                  ? `Create on ${host?.name ?? 'this host'} →`
                  : 'Try again →'}
              </Text>
            </Pressable>
            {recommendation.kind === 'continue' ? (
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => onNew(recommendation, messages)}
                className="mt-2 h-11 items-center justify-center rounded-[22px] bg-white"
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
          className="h-11 items-center justify-center rounded-[22px] bg-slate-100"
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
        <View className="rounded-[20px] bg-slate-100 p-3">
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search conversations or projects"
            placeholderTextColor={ink('#94a3b8')}
            accessibilityLabel="Search for another conversation"
            className="mb-2 rounded-[20px] bg-white px-3.5 py-2.5 text-[13.5px] text-slate-900"
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
                className="border-b border-slate-200 py-3"
              >
                <Text className="text-[14px] font-medium tracking-[-0.2px] text-slate-900">
                  {s.name}
                </Text>
                <Text className="mt-0.5 text-[11.5px] text-slate-500">
                  {context.hosts.find(h => h.id === s.serverId)?.name} ·{' '}
                  {s.folder}
                </Text>
              </Pressable>
            ))}
        </View>
      ) : null}
      <Text className="mt-2 text-center text-[10px] leading-4 text-slate-400">
        The agent decides: it moves your request to another conversation, or
        keeps this one.
      </Text>
    </Animated.View>
  );
}

export function ChatScreen({ onOpenSession, onBack }: ChatScreenProps) {
  const ink = useInk();
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
  const attempted = useRef(new Set<string>());
  const createdNew = useRef(new Map<string, SessionSummary>());
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  /** El destino al que se está fundiendo el chat; cambia el encabezado. */
  const [fusing, setFusing] = useState<SessionSummary | null>(null);
  const morph = useRef(new Animated.Value(0)).current;
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
        setStage('Opening your temporary agent…');
        const session = await createSession(host.baseUrl, host.token, host.id, {
          cwd: host.home,
          name: 'Direct chat',
          provider: await savedProvider(),
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
        directPrompt(text, pending.context, pending.session.serverId),
        images,
      );
      setChat(pending);
    } finally {
      busyRef.current = false;
      setBusy(false);
      setStage('');
    }
  };

  /**
   * El chat temporal ya entregó su petición: se elimina, no se archiva —todo
   * lo que tenía viaja al destino—. Va en segundo plano; un fallo al borrarlo
   * no debe repetir el envío, y de todos modos caduca solo en 1 h.
   */
  const dropTemporary = () => {
    const pending = started.current;
    started.current = null;
    if (!pending) {
      return;
    }
    const route = routes[pending.session.serverId];
    if (route?.baseUrl) {
      deleteSession(route.baseUrl, route.token, pending.session.id)
        .catch(() => undefined)
        .finally(invalidateHome);
    }
  };

  const finish = (session: SessionSummary) => {
    dropTemporary();
    setChat(null);
    setInitial(undefined);
    invalidateHome();
    onOpenSession(session);
  };

  /**
   * «Fusión en sitio»: el historial del destino queda en caché antes de
   * animar, el encabezado y la tarjeta se transforman, y `App` funde el
   * destino encima sin deslizarlo. El destino envía la petición él mismo,
   * así que la animación nunca espera a la red y un fallo se reintenta con
   * la burbuja de siempre.
   *
   * El chat directo no se limpia aquí: seguiría pintándose debajo del
   * fundido. Se desmonta cuando `App` cambia de pestaña al terminar.
   */
  const fuseInto = async (
    session: SessionSummary,
    route: { baseUrl: string; token: string },
    handoff: { text: string; images: MessageImage[] },
  ) => {
    if (readMessages(session.key) === null) {
      const page = await Promise.race([
        fetchMessages(route.baseUrl, session.id, route.token, LATEST_SEQ).catch(
          () => null,
        ),
        sleep(PREFETCH_TIMEOUT_MS),
      ]);
      if (page !== null) {
        writeMessages(session.key, page.messages, page.hasMore);
      }
    }
    setFusing(session);
    await new Promise<void>(resolve =>
      Animated.timing(morph, {
        toValue: 1,
        duration: MORPH_MS,
        useNativeDriver: true,
      }).start(() => resolve()),
    );
    dropTemporary();
    invalidateHome();
    onOpenSession(session, {
      inPlace: true,
      handoff: { ...handoff, note: 'Moved here from Direct chat' },
    });
  };

  /**
   * El chat temporal ya hizo el trabajo: se conserva tal cual —mismo agente,
   * mismo historial— y se abre como una sesión normal, sin archivarlo.
   */
  const keepHere = async (temp: SessionSummary, title: string) => {
    const route = routes[temp.serverId];
    if (!route?.baseUrl) {
      throw new Error("The conversation's host isn't responding");
    }
    await keepSession(route.baseUrl, route.token, temp.id, title);
    // El agente pudo cambiar de carpeta con `ui_set_working_directory`.
    const fresh = await fetchSessions(route.baseUrl, route.token, temp.serverId)
      .then(list => list.find(s => s.id === temp.id))
      .catch(() => undefined);
    started.current = null;
    finish(fresh ?? { ...temp, name: title, disposableTtlMs: null });
  };

  /** Lleva la petición al destino. Sin chat temporal vivo no hay qué mover. */
  const deliver = async (
    recommendation: DirectRecommendation,
    messages: ChatMessage[],
  ): Promise<boolean> => {
    if (busyRef.current || !started.current) {
      return false;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      if (recommendation.kind === 'here') {
        await keepHere(started.current.session, recommendation.title);
        return true;
      }
      const destinationId =
        recommendation.kind === 'continue'
          ? recommendation.session.serverId
          : recommendation.serverId;
      const route = routes[destinationId];
      if (!route?.baseUrl) {
        throw new Error("The destination's host isn't responding");
      }
      const handoff = directHandoff(messages);
      let session: SessionSummary;
      if (recommendation.kind === 'continue') {
        session = { ...recommendation.session, isOpen: true };
        if (!recommendation.session.isOpen) {
          await setSessionStatus(
            route.baseUrl,
            route.token,
            session.id,
            'open',
          );
        }
      } else {
        // Si el primer envío falla, el reintento reusa la sesión ya creada.
        const key = `${destinationId}\n${recommendation.cwd}\n${recommendation.title}`;
        session =
          createdNew.current.get(key) ??
          (await createSession(route.baseUrl, route.token, destinationId, {
            cwd: recommendation.cwd,
            name: recommendation.title,
            provider: await savedProvider(),
            model: null,
          }));
        createdNew.current.set(key, session);
      }
      createdNew.current.clear();
      await fuseInto(session, route, {
        text: handoff.text,
        images: handoff.images ?? [],
      });
      return true;
    } catch (error) {
      Alert.alert(
        recommendation.kind === 'continue'
          ? 'Could not continue'
          : recommendation.kind === 'here'
          ? 'Could not keep the conversation'
          : 'Could not create the conversation',
        error instanceof Error ? error.message : 'Try again',
      );
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  /** La decisión del agente se ejecuta una sola vez por respuesta. */
  const autoRoute = (
    messageId: string,
    recommendation: DirectRecommendation,
    messages: ChatMessage[],
  ) => {
    if (attempted.current.has(messageId)) {
      return;
    }
    attempted.current.add(messageId);
    deliver(recommendation, messages).then(ok => {
      if (!ok) {
        setFailed(current => new Set(current).add(messageId));
      }
    });
  };

  const continueIn = async (
    session: SessionSummary,
    messages: ChatMessage[],
  ) => {
    await deliver({ kind: 'continue', session, reason: '' }, messages);
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
      <SparkIcon size={13} color={ink('#64748b')} />
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
      style={{ paddingTop: insets.top + 4 }}
      onLayout={event => setHeaderHeight(event.nativeEvent.layout.height)}
      className="flex-row items-center gap-1 border-b border-slate-200 bg-white pb-1.5 pl-1.5 pr-4"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to conversations"
        onPress={onBack}
        className="h-10 w-10 items-center justify-center rounded-full active:bg-slate-100"
      >
        <BackIcon size={22} color={ink('#0f172a')} />
      </Pressable>
      <View className="h-12 flex-1 justify-center">
        <Animated.View
          style={{
            opacity: morph.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0, 0] }),
          }}
        >
          <Text className="text-[23px] font-bold leading-7 tracking-[-0.9px] text-slate-900">
            Direct
          </Text>
          <Text className="text-[11.5px] text-slate-500">
            Temporary agent · ends after 1 h idle
          </Text>
        </Animated.View>
        {fusing !== null ? (
          // El nombre del destino entra donde estaba «Direct»: es lo que hace
          // que el cambio se lea como la misma conversación que sigue.
          <Animated.View
            style={{
              opacity: morph.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 0, 1] }),
              transform: [
                {
                  translateY: morph.interpolate({
                    inputRange: [0.5, 1],
                    outputRange: [4, 0],
                    extrapolate: 'clamp',
                  }),
                },
              ],
            }}
            className="absolute inset-0 justify-center"
          >
            <Text
              numberOfLines={1}
              className="text-[15.5px] font-semibold tracking-[-0.3px] text-slate-900"
            >
              {fusing.name}
            </Text>
            <Text className="text-[11.5px] text-slate-500">
              {`Continuing · ${fusing.folder}`}
            </Text>
          </Animated.View>
        ) : null}
      </View>
    </View>
  );

  return (
    <View className="flex-1 bg-white">
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
                failed={failed}
                hereServerId={chat.session.serverId}
                morph={morph}
                onAuto={autoRoute}
                onDeliver={deliver}
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
                contentContainerClassName="grow px-5 pt-8 pb-5"
              >
                <View className="mb-4 h-11 w-11 items-center justify-center rounded-full bg-tint">
                  <SparkIcon size={20} color={ink('#0b7d5c')} />
                </View>
                <Text className="text-[23px] font-bold leading-7 tracking-[-0.9px] text-slate-900">
                  What are we doing today?
                </Text>
                <Text className="mt-2 text-[13.5px] leading-5 text-slate-500">
                  Tell me your idea. If a conversation already covers it, I'll
                  take it there; if it's new, I'll start on it right here.
                </Text>
                <Text className="mt-[18px] text-[11px] leading-[18px] text-slate-400">
                  New work stays in this chat and becomes a regular
                  conversation. Otherwise it expires after 1 h idle.
                </Text>
                {busy ? (
                  <View className="mt-7 flex-row items-center gap-3">
                    <ActivityIndicator color={ink('#64748b')} />
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
          className="flex-1 bg-black/40"
        />
        <View
          style={{ paddingBottom: insets.bottom + 24 }}
          className="rounded-t-[26px] bg-white p-5"
        >
          <Text className="mb-2 text-[20px] font-bold tracking-[-0.6px] text-slate-900">
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
              className="mb-2 h-12 flex-row items-center justify-between rounded-[22px] bg-slate-100 px-4"
            >
              <Text className="text-[14px] font-medium text-slate-900">{s.name}</Text>
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
