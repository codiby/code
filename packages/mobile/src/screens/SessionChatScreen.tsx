import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  View,
} from 'react-native';
import Animated, {
  useAnimatedKeyboard,
  useAnimatedStyle,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  LATEST_SEQ,
  fetchMessages,
  fetchNewerMessages,
  sendMessage,
} from '../api/messages';
import type {
  ChatMessage,
  MessageImage,
  PermissionRequest,
  SessionSummary,
} from '../api/types';
import {
  lastSeqOf,
  mergeNewer,
  readMessages,
  whenHydrated,
  subscribeMessages,
  writeMessages,
} from '../api/messageStore';
import { fetchSuggestions, type Suggestion } from '../api/suggestions';
import { directMessageText } from '../api/directChat';
import { useSessionSocket } from '../api/useSessionSocket';
import {
  BackIcon,
  Composer,
  MessageBubble,
  MockupCard,
  AskQuestionCard,
  isAskQuestion,
  PermissionCard,
  StreamingPreview,
  SuggestionRow,
  ToolGroup,
} from '../components/Chat';
import { buildChatItems } from '../lib/chatItems';
import {
  replyFromMessage,
  withReply,
  type MessageReply,
} from '../lib/messageReply';
import { useRouteFor } from '../config/ServerConfigContext';
import { avatarColorFor, initialsOf } from '../lib/format';

const OPTIMISTIC_PREFIX = 'local-';

/** Alto inicial del compositor, hasta que `onLayout` mida el real. */
const COMPOSER_CLEARANCE = 64;

export interface SessionChatScreenProps {
  readonly session: SessionSummary;
  /** Reutiliza streaming, permisos, adjuntos y reintentos en el chat temporal. */
  readonly directChat?: {
    readonly header: ReactNode;
    readonly busy?: boolean;
    readonly context: ReactNode;
    readonly renderDestination: (messages: ChatMessage[]) => ReactNode;
  };
  readonly onClose: () => void;
  /** false mientras la pantalla entra: pospone el trabajo pesado. */
  readonly isReady?: boolean;
  /** Texto sin enviar de la visita anterior. */
  readonly draft?: string;
  /** Se persiste al salir, no en cada tecla. */
  readonly onDraftChange?: (sessionId: string, text: string) => void;
  /** Lo monta App: el visor es otra capa de la pila, y el back es suyo. */
  readonly onOpenMockup?: (name: string) => void;
  /** Abre la ficha de la sesión. */
  readonly onOpenInfo?: () => void;
  /** Del `session_state`; lo necesita la ficha y aquí ya llega. */
  readonly onTotalMessages?: (total: number) => void;
}

export function SessionChatScreen({
  session,
  directChat,
  onClose,
  isReady = true,
  draft = '',
  onDraftChange,
  onOpenMockup,
  onOpenInfo,
  onTotalMessages,
}: SessionChatScreenProps) {
  // El borrador se guarda al desmontar, no en cada tecla: escribir no debería
  // provocar una escritura en disco por carácter.
  const draftRef = useRef(draft);
  useEffect(
    // Por clave compuesta, igual que la lista: si no, el borrador de una
    // `main-session` aparecería en la de la otra máquina.
    () => () => onDraftChange?.(session.key, draftRef.current),
    [session.key, onDraftChange],
  );

  const { baseUrl, token } = useRouteFor(session.serverId);
  const insets = useSafeAreaInsets();
  const keyboard = useAnimatedKeyboard();

  /**
   * Se mueve todo el bloque con `translateY`, no con `paddingBottom`: animar
   * una propiedad de layout obliga a re-medir la lista completa en cada frame
   * del teclado, y con burbujas de salida de terminal eso se ve trabado.
   * Un transform no toca layout — lo resuelve el compositor.
   */
  const keyboardShift = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: -Math.max(keyboard.height.value - insets.bottom, 0),
      },
    ],
  }));

  /**
   * Lo que ya se había cargado de esta conversación, si se visitó antes.
   *
   * Se lee en el primer render, no en un efecto: el objetivo es que la
   * conversación esté pintada desde el primer fotograma, y un efecto llega un
   * fotograma tarde — que es exactamente el parpadeo que se quiere quitar.
   */
  const cached = readMessages(session.key);

  const [messages, setMessages] = useState<ChatMessage[]>(
    () => cached?.messages ?? [],
  );
  const [hasMore, setHasMore] = useState(cached?.hasMore ?? false);
  const [isLoading, setIsLoading] = useState(cached === null);
  const [isStreaming, setIsStreaming] = useState(false);
  /**
   * El nombre se sigue en estado propio porque puede cambiar desde el
   * escritorio mientras miras el chat. El `prop` es solo la semilla: viene del
   * objeto que la lista tenía al abrir y ese ya no se vuelve a leer.
   */
  const [name, setName] = useState(session.name);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [hasDraftText, setHasDraftText] = useState(false);
  const [insert, setInsert] = useState({ text: '', nonce: 0 });
  const [partialText, setPartialText] = useState('');
  const [partialThinking, setPartialThinking] = useState('');
  // Un solo mensaje puede enseñar su hora, así que el id vive aquí y no en
  // cada burbuja: es lo que hace que abrir uno cierre el anterior.
  const [stampedId, setStampedId] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<MessageReply | null>(null);
  const selectReply = useCallback((message: ChatMessage) => {
    setReplyTo(replyFromMessage(message));
  }, []);
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [isResponding, setIsResponding] = useState(false);
  const [composerHeight, setComposerHeight] = useState(COMPOSER_CLEARANCE);
  const [error, setError] = useState<string | null>(null);
  /** Poniéndose al día con el bridge en segundo plano: lo dice el header. */
  const [isSyncing, setIsSyncing] = useState(false);
  const isFetchingRef = useRef(false);
  const isSyncingRef = useRef(false);

  const loadPage = useCallback(
    async (beforeSeq: number) => {
      if (isFetchingRef.current) {
        return;
      }
      isFetchingRef.current = true;
      try {
        const page = await fetchMessages(baseUrl, session.id, token, beforeSeq);
        // Prepend: la página nueva siempre es más vieja que lo ya cargado.
        setMessages(current => {
          const next =
            beforeSeq === LATEST_SEQ
              ? page.messages
              : [...page.messages, ...current];
          writeMessages(session.key, next, page.hasMore);
          return next;
        });
        setHasMore(page.hasMore);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Error desconocido');
      } finally {
        isFetchingRef.current = false;
        setIsLoading(false);
      }
    },
    [baseUrl, session.id, session.key, token],
  );

  /**
   * Ponerse al día: pide solo lo que llegó después del último mensaje que ya
   * está en el teléfono. Lo guardado se queda en pantalla mientras tanto; el
   * header dice «sincronizando…» y nada más se mueve.
   *
   * Sin nada guardado no hay de dónde partir y se pide la última página, que
   * es lo único que de verdad justifica el cargador.
   */
  const sync = useCallback(async () => {
    const current = readMessages(session.key);
    const afterSeq = current === null ? 0 : lastSeqOf(current.messages);
    if (current === null || afterSeq === 0) {
      await loadPage(LATEST_SEQ);
      return;
    }
    if (isSyncingRef.current) {
      return;
    }
    isSyncingRef.current = true;
    setIsSyncing(true);
    try {
      const page = await fetchNewerMessages(
        baseUrl,
        session.id,
        token,
        afterSeq,
      );
      const latest = readMessages(session.key) ?? current;
      const oldestNew = page.messages[0]?.seq ?? Infinity;
      // Se reemplaza si lo nuevo no se puede pegar a lo que había: porque el
      // bridge avisó del hueco, o porque es uno viejo sin `after_seq` y su
      // última página empieza después de lo que tenemos.
      const replace =
        page.gap === true || (page.gap === null && oldestNew > afterSeq + 1);
      const next = replace
        ? page.messages
        : mergeNewer(
            latest.messages,
            page.messages.filter(message => message.seq > afterSeq),
          );
      const hasMoreNext = replace ? page.hasMore : latest.hasMore;
      if (next !== latest.messages) {
        writeMessages(session.key, next, hasMoreNext);
        setMessages(next);
        setHasMore(hasMoreNext);
      }
      setError(null);
    } catch (cause) {
      // Lo guardado sigue en pantalla: el fallo solo se avisa.
      setError(cause instanceof Error ? cause.message : 'Error desconocido');
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [baseUrl, session.id, session.key, token, loadPage]);

  /**
   * Con algo guardado se sincroniza desde ya: la conversación ya está pintada
   * y lo que traiga la red suele ser nada o un par de mensajes.
   *
   * Sin nada guardado, la primera página espera a que termine la transición de
   * entrada: maquetar decenas de burbujas —con su markdown— a media animación
   * es lo que se ve como un tirón. Antes se mira el disco, por si la app acaba
   * de arrancar y todavía no terminaba de leerlo.
   */
  const hasStartedRef = useRef(false);
  useEffect(() => {
    if (hasStartedRef.current) {
      return;
    }
    if (cached !== null) {
      hasStartedRef.current = true;
      sync();
      return;
    }
    let cancelled = false;
    whenHydrated().then(() => {
      if (cancelled) {
        return;
      }
      const stored = readMessages(session.key);
      if (stored !== null || isReady) {
        hasStartedRef.current = true;
      }
      if (stored !== null) {
        setMessages(stored.messages);
        setHasMore(stored.hasMore);
        setIsLoading(false);
        sync();
      } else if (isReady) {
        setIsLoading(true);
        loadPage(LATEST_SEQ);
      }
    });
    return () => {
      cancelled = true;
    };
    // `cached` se lee una vez al montar; volver a evaluarlo aquí reharía la
    // carga cada vez que el socket toca la caché.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady]);

  /**
   * La caché la alimenta el socket compartido aunque esta pantalla no exista,
   * así que hay que escucharla: si no, un mensaje que llegó mientras mirabas
   * el Home no aparecería hasta la siguiente recarga.
   */
  useEffect(
    () =>
      subscribeMessages(session.key, () => {
        const page = readMessages(session.key);
        if (page !== null) {
          setMessages(page.messages);
        }
      }),
    [session.key],
  );

  /**
   * Un mensaje puede llegar dos veces: como burbuja optimista y como eco del
   * servidor. Se descarta por id ya visto, y se retira la optimista que el
   * eco viene a reemplazar.
   */
  const appendLive = useCallback((incoming: ChatMessage) => {
    // El mensaje definitivo reemplaza a la vista previa: si no se limpia aquí,
    // el texto se vería duplicado durante el hueco hasta que llegue el `''`.
    setPartialText('');
    setPartialThinking('');

    setMessages(current => {
      if (current.some(message => message.id === incoming.id)) {
        return current;
      }
      const withoutOptimistic = current.filter(
        message =>
          !(
            message.id.startsWith(OPTIMISTIC_PREFIX) &&
            message.role === incoming.role &&
            message.content === incoming.content
          ),
      );
      return [...withoutOptimistic, incoming];
    });
  }, []);

  const {
    status: socketStatus,
    respondPermission,
    isLive,
  } = useSessionSocket({
    serverId: session.serverId,
    sessionId: session.id,
    // Ya no espera a la primera página: la conexión está viva desde el Home,
    // así que suscribirse cuesta un mensaje, no un apretón de manos.
    enabled: true,
    onMessage: appendLive,
    // Al reconectar se relee la última página: lo que llegó mientras el
    // teléfono estuvo bloqueado no se reenvía por el socket.
    onResync: () => {
      sync();
    },
    onMeta: meta => setName(meta.name),
    onStatus: status => {
      // Solo apagan los estados que de verdad cierran el turno. `connected`
      // NO es uno: el bridge lo manda ~100 ms DESPUÉS de `streaming` —medido:
      // streaming a +819 ms, connected a +921 ms— y apagar con él hacía que
      // las luces del composer se encendieran y murieran al instante.
      if (status === 'streaming') {
        setIsStreaming(true);
      } else if (
        status === 'turn_complete' ||
        status === 'interrupted' ||
        status === 'disconnected'
      ) {
        setIsStreaming(false);
      }

      // Se piden al cerrar el turno y solo entonces: es cuando existe un
      // mensaje al que responder y cuando la pelota vuelve a tu lado.
      if (status === 'turn_complete' && !directChat) {
        fetchSuggestions(baseUrl, token, session.id).then(setSuggestions);
      } else if (status === 'streaming') {
        // Quedaron obsoletas en cuanto el agente volvió a hablar.
        setSuggestions([]);
      }

      // Pero solo los estados que de verdad cierran el turno limpian la vista
      // previa. `connected` llega justo DESPUÉS de `session_state`, que es
      // quien siembra los parciales al abrir una sesión a media respuesta:
      // limpiar ahí borraría lo que se acaba de recibir.
      if (
        status === 'turn_complete' ||
        status === 'interrupted' ||
        status === 'disconnected'
      ) {
        setPartialText('');
        setPartialThinking('');
      }
    },
    onPartialText: setPartialText,
    onPartialThinking: setPartialThinking,
    onPermission: request => {
      setPermission(request);
      setIsResponding(false);
    },
    onTotalMessages,
  });

  const answerPermission = useCallback(
    (allow: boolean) => {
      if (permission === null) {
        return;
      }
      setIsResponding(true);
      // El bridge confirma con `permission_cancelled`, que limpia el estado.
      if (!respondPermission(permission.requestId, allow)) {
        setIsResponding(false);
      }
    },
    [permission, respondPermission],
  );

  /**
   * `AskUserQuestion` se aprueba siempre: lo que decide no es si la herramienta
   * corre, sino qué contesta. La elección viaja en `updatedInput`, que el bridge
   * guarda como resultado de la herramienta — de ahí que haya que reenviar el
   * input original entero y no solo las respuestas.
   */
  const answerQuestions = useCallback(
    (answers: Record<string, string>) => {
      if (permission === null) {
        return;
      }
      setIsResponding(true);
      if (
        !respondPermission(permission.requestId, true, {
          ...permission.input,
          answers,
        })
      ) {
        setIsResponding(false);
      }
    },
    [permission, respondPermission],
  );

  /**
   * Los envíos van en fila: dos mensajes seguidos por una red lenta no pueden
   * llegar al revés. Cada uno espera al anterior, salga bien o mal.
   */
  const sendQueueRef = useRef<Promise<void>>(Promise.resolve());

  const setSendState = useCallback(
    (id: string, sendState: ChatMessage['sendState']) =>
      setMessages(current =>
        current.map(message =>
          message.id === id ? { ...message, sendState } : message,
        ),
      ),
    [],
  );

  /**
   * Manda sin hacer esperar al compositor.
   *
   * Antes el compositor esperaba al POST y, si pasaban 8 s, daba el envío por
   * fallido y devolvía el texto al campo — aunque el bridge sí lo hubiera
   * recibido. Con una red lenta eso dejaba el mensaje mandado Y en el campo,
   * listo para mandarse otra vez. Ahora el texto se va del campo para siempre
   * y el estado vive en la burbuja: «enviando…», o «No se envió · Reintentar».
   * Si en realidad sí llegó, el eco (socket o sincronización) la reemplaza.
   */
  const handleSend = useCallback(
    (
      text: string,
      images: MessageImage[],
      reply: MessageReply | null = replyTo,
    ): Promise<void> => {
      const outgoing = withReply(text, reply);
      if (reply !== null && reply === replyTo) {
        setReplyTo(null);
      }
      const optimistic: ChatMessage = {
        id: `${OPTIMISTIC_PREFIX}${Date.now()}`,
        role: 'user',
        content: outgoing,
        timestamp: Date.now(),
        seq: 0,
        toolName: null,
        toolInput: null,
        images,
        isThinking: false,
        thinkingRedacted: false,
        sendState: 'sending',
      };
      setMessages(current => [...current, optimistic]);

      // También optimista, por la misma razón que la burbuja: esperar a que el
      // bridge difunda `status: streaming` cuesta el POST más el viaje de
      // vuelta por el socket, y ese hueco es el que se veía como que las luces
      // del composer tardaban en encenderse. El socket confirma o corrige.
      setIsStreaming(true);

      sendQueueRef.current = sendQueueRef.current.then(async () => {
        try {
          await sendMessage(baseUrl, session.id, token, outgoing, images);
        } catch {
          // Si el envío no salió, nadie va a mandar `turn_complete` y las luces
          // se quedarían encendidas para siempre.
          setIsStreaming(false);
          setSendState(optimistic.id, 'failed');
          return;
        }
        // Confirmado por el bridge: ya no está «enviando», aunque el eco que
        // la reemplaza todavía no haya llegado.
        setSendState(optimistic.id, undefined);
        // Con el socket abierto el eco y la respuesta llegan solos; releer
        // sería redundante y podría pisar lo que ya entró por el stream.
        if (socketStatus !== 'open') {
          await sync();
        }
      });
      return Promise.resolve();
    },
    [baseUrl, session.id, token, sync, socketStatus, setSendState, replyTo],
  );

  /** Quita la burbuja fallida y la vuelve a mandar tal cual. */
  const retrySend = useCallback(
    (message: ChatMessage) => {
      setMessages(current => current.filter(item => item.id !== message.id));
      handleSend(message.content, message.images, null);
    },
    [handleSend],
  );

  const toggleStamp = useCallback((id: string) => {
    setStampedId(current => (current === id ? null : id));
  }, []);

  const showStamp = useCallback((id: string) => setStampedId(id), []);

  const loadOlder = useCallback(() => {
    const oldest = messages[0];
    if (hasMore && oldest !== undefined) {
      loadPage(oldest.seq);
    }
  }, [hasMore, messages, loadPage]);

  // Cada herramienta absorbe su salida, así que la lista tiene menos filas que
  // mensajes. FlatList invertida: el índice 0 es lo más nuevo, así arranca
  // abajo sin necesidad de scrollToEnd.
  const inverted = useMemo(
    () => buildChatItems(messages).reverse(),
    [messages],
  );

  return (
    <View className="flex-1 bg-slate-100">
      {directChat ? (
        directChat.header
      ) : (
        <View
          style={{ paddingTop: insets.top + 8 }}
          className="flex-row items-center gap-2.5 border-b border-slate-200 bg-white px-2 pb-2.5"
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Volver"
            onPress={onClose}
            className="h-10 w-10 items-center justify-center rounded-full active:bg-slate-100"
          >
            <BackIcon size={24} color="#0f172a" />
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Ver la info de la sesión"
            onPress={onOpenInfo}
            className="flex-1 flex-row items-center gap-2.5 rounded-xl active:bg-slate-100"
          >
            <View
              style={{ backgroundColor: avatarColorFor(session.id) }}
              className="h-[34px] w-[34px] items-center justify-center rounded-full"
            >
              <Text className="text-xs font-semibold text-white">
                {initialsOf(session.name)}
              </Text>
            </View>

            <View className="flex-1">
              <Text
                numberOfLines={1}
                className="text-[14px] font-semibold text-slate-900"
              >
                {name}
              </Text>
              <View className="flex-row items-center gap-1.5">
                {/* «En vivo» es estar SUSCRITO, no que el socket del servidor
                exista: con la conexión compartida está abierta desde el Home,
                y decir en vivo antes de la suscripción sería mentir. */}
                {permission !== null ? (
                  <View className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                ) : isLive ? (
                  <View className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                ) : null}
                <Text
                  numberOfLines={1}
                  className={`flex-1 text-[11px] ${
                    permission !== null ? 'text-amber-700' : 'text-slate-500'
                  }`}
                >
                  {permission !== null
                    ? 'esperando permiso'
                    : isStreaming
                    ? 'escribiendo…'
                    : isSyncing
                    ? 'sincronizando…'
                    : isLive
                    ? `en vivo · ${session.folder}`
                    : socketStatus === 'closed'
                    ? session.folder
                    : 'conectando…'}
                </Text>
              </View>
            </View>

            <Text className="text-[13px] text-slate-300">›</Text>
          </Pressable>
        </View>
      )}

      {error !== null ? (
        <View className="bg-rose-50 px-4 py-3">
          <Text className="text-sm text-rose-700">{error}</Text>
        </View>
      ) : null}

      {/* Recorta lo que se sale por arriba al subir el bloque. */}
      <View className="flex-1 overflow-hidden">
        <Animated.View className="flex-1" style={keyboardShift}>
          {isLoading ? (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator color="#64748b" />
            </View>
          ) : (
            <FlatList
              inverted
              data={inverted}
              keyExtractor={item => item.key}
              renderItem={({ item }) =>
                item.kind === 'mockup' ? (
                  <View className="px-3">
                    <MockupCard name={item.name} onOpen={onOpenMockup} />
                  </View>
                ) : item.kind === 'group' ? (
                  <ToolGroup entries={item.entries} />
                ) : (
                  <MessageBubble
                    message={
                      (directChat ||
                        item.message.content.includes(
                          '<codiby-direct-context>',
                        ) ||
                        (item.message.role === 'assistant' &&
                          item.message.content.includes('```codiby-route'))) &&
                      !item.message.toolName &&
                      !item.message.isToolResult
                        ? {
                            ...item.message,
                            content: directMessageText(item.message.content),
                          }
                        : item.message
                    }
                    group={item.group}
                    isSelected={stampedId === item.message.id}
                    onSelect={toggleStamp}
                    onShowStamp={showStamp}
                    onRetry={retrySend}
                    onReply={selectReply}
                  />
                )
              }
              contentContainerClassName="py-3"
              onEndReached={loadOlder}
              onEndReachedThreshold={0.4}
              initialNumToRender={12}
              maxToRenderPerBatch={8}
              windowSize={7}
              removeClippedSubviews
              // En una lista invertida el header se dibuja abajo, que es
              // donde debe aparecer lo que se está escribiendo ahora.
              ListHeaderComponent={
                <>
                  {permission !== null && isAskQuestion(permission) ? (
                    <AskQuestionCard
                      request={permission}
                      onSubmit={answerQuestions}
                      isBusy={isResponding}
                    />
                  ) : permission !== null ? (
                    <PermissionCard
                      request={permission}
                      onRespond={answerPermission}
                      isBusy={isResponding}
                    />
                  ) : (
                    <StreamingPreview
                      text={
                        directChat
                          ? directMessageText(partialText)
                          : partialText
                      }
                      thinking={partialThinking}
                      isStreaming={isStreaming}
                    />
                  )}
                  {/* Deja libre lo que ocupa el compositor flotante. Se mide
                      en vez de fijarse: al escribir varias líneas crece, y con
                      una altura fija taparía los últimos mensajes. */}
                  {!isStreaming
                    ? directChat?.renderDestination(messages)
                    : null}
                  <View style={{ height: composerHeight }} />
                </>
              }
              ListFooterComponent={
                hasMore ? (
                  <View className="py-4">
                    <ActivityIndicator size="small" color="#94a3b8" />
                  </View>
                ) : undefined
              }
              ListEmptyComponent={
                <View className="items-center px-6 py-16">
                  <Text className="text-sm text-slate-500">
                    Esta sesión no tiene mensajes.
                  </Text>
                </View>
              }
            />
          )}

          {/* Flotante sobre la lista: el hilo corre por debajo. El hueco al
              final lo reserva el ListHeaderComponent, que en una lista
              invertida se dibuja abajo. */}
          <View
            pointerEvents="box-none"
            style={{ paddingBottom: insets.bottom }}
            className="absolute inset-x-0 bottom-0"
            onLayout={event =>
              setComposerHeight(event.nativeEvent.layout.height)
            }
          >
            {/* Se esconde mientras escribes: con el teclado abierto la
                pantalla ya está apretada y los chips empujarían el hilo. */}
            {!directChat && !hasDraftText && !isStreaming && !replyTo ? (
              <SuggestionRow
                suggestions={suggestions}
                onSend={text => {
                  setSuggestions([]);
                  handleSend(text, []);
                }}
                onEdit={text =>
                  setInsert(current => ({ text, nonce: current.nonce + 1 }))
                }
              />
            ) : null}

            <Composer
              onSend={handleSend}
              replyTo={replyTo}
              onCancelReply={() => setReplyTo(null)}
              context={
                directChat?.context ?? (
                  <Text
                    numberOfLines={1}
                    className="text-[11px] text-slate-500"
                  >
                    {session.folder}
                  </Text>
                )
              }
              placeholder={directChat ? '¿Qué quieres hacer?' : undefined}
              disabled={isLoading || baseUrl.length === 0 || directChat?.busy}
              // Misma condición que el escritorio: respondiendo y sin permiso
              // pendiente. Con permiso hay una tarjeta ámbar que ya lo dice, y
              // dos señales a la vez compiten.
              isStreaming={isStreaming && permission === null}
              initialText={draft}
              insertText={insert.text}
              insertNonce={insert.nonce}
              onTextChange={next => {
                draftRef.current = next;
                setHasDraftText(next.trim().length > 0);
              }}
            />
          </View>
        </Animated.View>
      </View>
    </View>
  );
}
