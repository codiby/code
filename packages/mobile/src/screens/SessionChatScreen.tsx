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
  Animated as RNAnimated,
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
  loadStoredMessages,
  mergeNewer,
  readMessages,
  subscribeMessages,
  writeMessages,
  type CachedPage,
} from '../api/messageStore';
import { fetchSuggestions, type Suggestion } from '../api/suggestions';
import { directMessageText } from '../api/directChat';
import { useSessionSocket } from '../api/useSessionSocket';
import { useTaskFeed } from '../api/subagents';
import { AgentsButton } from '../components/Subagents';
import {
  BackIcon,
  Composer,
  MessageBubble,
  MockupCard,
  AskQuestionCard,
  NewSessionCard,
  isAskQuestion,
  PermissionCard,
  StreamingPreview,
  SuggestionRow,
  ToolGroup,
} from '../components/Chat';
import { buildChatItems } from '../lib/chatItems';
import { OPTIMISTIC_PREFIX, keepPending } from '../lib/pendingMessages';
import {
  loadAnsweredSuggestions,
  pendingNewSessionSuggestion,
  saveAnsweredSuggestion,
  seededPrompt,
  type NewSessionSuggestion,
} from '../lib/newSessionSuggestion';
import { createSession } from '../api/sessions';
import {
  replyFromMessage,
  withReply,
  type MessageReply,
} from '../lib/messageReply';
import { useRouteFor } from '../config/ServerConfigContext';
import { avatarColorFor, initialsOf } from '../lib/format';
import { useInk } from '../theme';


/** Alto inicial del compositor, hasta que `onLayout` mida el real. */
const COMPOSER_CLEARANCE = 64;

/**
 * Al tapar un hueco se piden bloques de 60 —~50 KB con salidas de
 * herramientas— hasta 20 veces: alcanza para una tarde de trabajo del agente
 * sin bajar el historial entero de una sesión que lleva días.
 */
const GAP_FILL_LIMIT = 60;
const GAP_FILL_PAGES = 20;

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
  /** Abre otra sesión; la usa la tarjeta de «nueva sesión». */
  readonly onOpenSession?: (session: SessionSummary) => void;
  /**
   * Lo que el chat directo movió aquí: se envía una vez al montar, como un
   * mensaje propio — burbuja optimista y reintento incluidos — y `note` se
   * muestra un momento bajo el encabezado.
   */
  readonly handoff?: {
    readonly text: string;
    readonly images: MessageImage[];
    readonly note: string;
  };
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
  onOpenSession,
  handoff,
}: SessionChatScreenProps) {
  const ink = useInk();
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
  /** Ofertas de sesión nueva ya contestadas, de cualquier conversación. */
  const [answered, setAnswered] = useState<string[]>([]);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  useEffect(() => {
    loadAnsweredSuggestions().then(setAnswered);
  }, []);
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
          return keepPending(next, current);
        });
        setHasMore(page.hasMore);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Unknown error');
      } finally {
        isFetchingRef.current = false;
        setIsLoading(false);
      }
    },
    [baseUrl, session.id, session.key, token],
  );

  /**
   * Tapa el hueco entre lo guardado y lo último que trajo la red.
   *
   * Antes, si mientras no mirabas llegaron más de 30 mensajes —un turno largo
   * de herramientas los rebasa enseguida—, la conversación guardada se tiraba
   * y quedaban solo esos 30: casi todo burbujas de herramientas, y lo anterior
   * había que volver a bajarlo bloque a bloque al subir. Se veía como si la
   * caché se hubiera borrado.
   *
   * Ahora se pinta lo nuevo en el acto y se piden hacia atrás los bloques que
   * faltan hasta tocar lo guardado, que se conserva entero. Como la lista está
   * invertida, lo que entra por arriba no mueve lo que estás viendo.
   */
  const fillGap = useCallback(
    async (stored: CachedPage, tail: ChatMessage[], afterSeq: number) => {
      const kept = stored.messages.filter(message => message.seq <= afterSeq);
      const prepend = (older: ChatMessage[], hasMoreNext: boolean) => {
        const ids = new Set(older.map(message => message.id));
        const current = readMessages(session.key)?.messages ?? [];
        const next = [...older, ...current.filter(m => !ids.has(m.id))];
        writeMessages(session.key, next, hasMoreNext);
        setMessages(shown => keepPending(next, shown));
        setHasMore(hasMoreNext);
      };

      writeMessages(session.key, tail, true);
      setMessages(shown => keepPending(tail, shown));
      setHasMore(true);

      // `loadOlder` pediría lo mismo en paralelo al llegar arriba.
      isFetchingRef.current = true;
      try {
        let oldest = tail[0]?.seq ?? afterSeq + 1;
        for (let page = 0; page < GAP_FILL_PAGES; page += 1) {
          const older = await fetchMessages(
            baseUrl,
            session.id,
            token,
            oldest,
            GAP_FILL_LIMIT,
          );
          const fresh = older.messages.filter(m => m.seq > afterSeq);
          const reached =
            fresh.length < older.messages.length ||
            !older.hasMore ||
            fresh.length === 0;
          if (reached) {
            prepend([...kept, ...fresh], stored.hasMore);
            return;
          }
          prepend(fresh, true);
          oldest = fresh[0]!.seq;
        }
        // Un hueco enorme: lo de más atrás se pide al subir, como siempre.
      } finally {
        isFetchingRef.current = false;
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
      // Hay hueco si lo nuevo no se puede pegar a lo que había: porque el
      // bridge lo avisó, o porque es uno viejo sin `after_seq` y su última
      // página empieza después de lo que tenemos.
      const hasGap =
        page.gap === true || (page.gap === null && oldestNew > afterSeq + 1);
      if (!hasGap) {
        const next = mergeNewer(
          latest.messages,
          page.messages.filter(message => message.seq > afterSeq),
        );
        if (next !== latest.messages) {
          writeMessages(session.key, next, latest.hasMore);
          setMessages(shown => keepPending(next, shown));
        }
      } else {
        await fillGap(current, page.messages, afterSeq);
      }
      setError(null);
    } catch (cause) {
      // Lo guardado sigue en pantalla: el fallo solo se avisa.
      setError(cause instanceof Error ? cause.message : 'Unknown error');
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [baseUrl, session.id, session.key, token, loadPage, fillGap]);

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
    loadStoredMessages(session.key).then(stored => {
      if (cancelled) {
        return;
      }
      if (stored !== null || isReady) {
        hasStartedRef.current = true;
      }
      if (stored !== null) {
        setMessages(shown => keepPending(stored.messages, shown));
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
          setMessages(shown => keepPending(page.messages, shown));
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

  // Sub-agent tasks bypass this screen's state: only the header chip and the
  // Agents sheet repaint on each progress tick, not the whole thread.
  const taskFeed = useTaskFeed();

  const {
    status: socketStatus,
    respondPermission,
    setPermissionMode,
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
    onTasks: taskFeed.replace,
    onTaskUpdate: taskFeed.upsert,
  });

  const answerPermission = useCallback(
    (allow: boolean, bypass = false) => {
      if (permission === null) {
        return;
      }
      setIsResponding(true);
      // El bridge confirma con `permission_cancelled`, que limpia el estado.
      if (!respondPermission(permission.requestId, allow)) {
        setIsResponding(false);
        return;
      }
      // «Approve & Bypass», como en el escritorio: tras aprobar el plan, el
      // resto de la sesión ya no pide permiso. El bridge guarda el modo en la
      // sesión y lo aplica al proveedor en vivo.
      if (allow && bypass) {
        setPermissionMode('bypassPermissions');
      }
    },
    [permission, respondPermission, setPermissionMode],
  );

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

  // El encargo del chat directo sale una sola vez, aunque la pantalla se
  // vuelva a pintar. `keepPending` lo protege de la primera sincronización.
  const handoffSentRef = useRef(false);
  useEffect(() => {
    if (handoff === undefined || handoffSentRef.current) {
      return;
    }
    handoffSentRef.current = true;
    handleSend(handoff.text, handoff.images, null);
  }, [handoff, handleSend]);

  /** La oferta de sesión nueva que sigue en pie, si nadie la contestó. */
  const newSession = useMemo(() => {
    const pending = pendingNewSessionSuggestion(messages);
    return pending !== null && !answered.includes(pending.id) ? pending : null;
  }, [messages, answered]);

  const answerSuggestion = useCallback((suggestion: NewSessionSuggestion) => {
    setAnswered(current => [...current, suggestion.id]);
    saveAnsweredSuggestion(suggestion.id).catch(() => undefined);
  }, []);

  /**
   * «Create session»: en la misma máquina, con el mismo proveedor y modelo, y
   * con el encargo del agente como primer mensaje. El bridge la agrupa por su
   * carpeta, como cualquier sesión nueva.
   */
  const createSuggestedSession = useCallback(
    async (suggestion: NewSessionSuggestion) => {
      setIsCreatingSession(true);
      setCreateError(null);
      try {
        const created = await createSession(baseUrl, token, session.serverId, {
          cwd: suggestion.cwd ?? session.cwd,
          name: suggestion.title,
          provider: session.provider ?? 'claude',
          model: session.model ?? null,
        });
        await sendMessage(
          baseUrl,
          created.id,
          token,
          seededPrompt(suggestion, { id: session.id, name }),
        );
        answerSuggestion(suggestion);
        onOpenSession?.(created);
      } catch (failure) {
        setCreateError(
          failure instanceof Error
            ? failure.message
            : 'Could not create the session',
        );
      } finally {
        setIsCreatingSession(false);
      }
    },
    [baseUrl, token, session, name, answerSuggestion, onOpenSession],
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
    <View className="flex-1 bg-white">
      {directChat ? (
        directChat.header
      ) : (
        <View
          style={{ paddingTop: insets.top + 4 }}
          className="flex-row items-center gap-2.5 border-b border-slate-200 bg-white pb-1.5 pl-1.5 pr-2.5"
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={onClose}
            className="h-10 w-10 items-center justify-center rounded-full active:bg-slate-100"
          >
            <BackIcon size={22} color={ink('#0f172a')} />
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="View session info"
            onPress={onOpenInfo}
            className="flex-1 flex-row items-center gap-2.5 rounded-xl active:bg-slate-100"
          >
            <View
              style={{ backgroundColor: avatarColorFor(session.id) }}
              className="h-9 w-9 items-center justify-center rounded-full"
            >
              <Text className="text-[12px] font-semibold text-white">
                {initialsOf(session.name)}
              </Text>
            </View>

            <View className="flex-1">
              <Text
                numberOfLines={1}
                className="text-[15.5px] font-semibold tracking-[-0.3px] text-slate-900"
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
                  <View className="h-1.5 w-1.5 rounded-full bg-[#19c37d]" />
                ) : null}
                <Text
                  numberOfLines={1}
                  className={`flex-1 text-[11.5px] ${
                    permission !== null
                      ? 'text-amber-700'
                      : isStreaming
                      ? 'font-medium text-[#19c37d]'
                      : 'text-slate-500'
                  }`}
                >
                  {permission !== null
                    ? 'waiting for permission'
                    : isStreaming
                    ? 'working…'
                    : isSyncing
                    ? 'syncing…'
                    : isLive
                    ? `live · ${session.folder}`
                    : socketStatus === 'closed'
                    ? session.folder
                    : 'connecting…'}
                </Text>
              </View>
            </View>

            </Pressable>

          <AgentsButton
            feed={taskFeed}
            serverId={session.serverId}
            sessionId={session.id}
            baseUrl={baseUrl}
            token={token}
          />
        </View>
      )}

      {handoff !== undefined ? <ArrivalNote text={handoff.note} /> : null}

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
              <ActivityIndicator color={ink('#64748b')} />
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
                  ) : newSession !== null && !isStreaming && !directChat ? (
                    <NewSessionCard
                      suggestion={newSession}
                      isBusy={isCreatingSession}
                      error={createError}
                      onCreate={() => createSuggestedSession(newSession)}
                      onContinue={() => {
                        answerSuggestion(newSession);
                        handleSend('Continue here, in this session.', [], null);
                      }}
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
                    <ActivityIndicator size="small" color={ink('#94a3b8')} />
                  </View>
                ) : undefined
              }
              ListEmptyComponent={
                <View className="items-center px-6 py-16">
                  <Text className="text-sm text-slate-500">
                    This session has no messages.
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
              context={directChat?.context}
              placeholder={directChat ? 'What do you want to do?' : undefined}
              disabled={isLoading || baseUrl.length === 0 || directChat?.busy}
              initialText={draft}
              insertText={insert.text}
              insertNonce={insert.nonce}
              onTextChange={next => {
                draftRef.current = next;
                setHasDraftText(next.trim().length > 0);
              }}
            />
            <View style={{ height: insets.bottom }} className="bg-white" />
          </View>
        </Animated.View>
      </View>
    </View>
  );
}

/**
 * «Movido desde el chat directo»: aparece al llegar y se va solo. No ocupa
 * lugar en el layout — flota sobre la lista para no empujar los mensajes a
 * media transición.
 */
function ArrivalNote({ text }: { readonly text: string }) {
  const opacity = useRef(new RNAnimated.Value(0)).current;
  useEffect(() => {
    const show = RNAnimated.sequence([
      RNAnimated.delay(180),
      RNAnimated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      RNAnimated.delay(2600),
      RNAnimated.timing(opacity, { toValue: 0, duration: 260, useNativeDriver: true }),
    ]);
    show.start();
    return () => show.stop();
  }, [opacity]);
  return (
    <View pointerEvents="none" className="relative z-10 h-0 items-center">
      <RNAnimated.View
        style={{
          opacity,
          transform: [
            {
              translateY: opacity.interpolate({
                inputRange: [0, 1],
                outputRange: [-6, 0],
              }),
            },
          ],
        }}
        className="mt-2 rounded-full border border-slate-300 bg-slate-100 px-3 py-1.5"
      >
        <Text className="text-[12px] text-slate-600">{text}</Text>
      </RNAnimated.View>
    </View>
  );
}
