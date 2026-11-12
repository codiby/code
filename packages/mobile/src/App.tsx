/**
 * @format
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  BackHandler,
  StatusBar,
  useWindowDimensions,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { findKnownSession } from './api/homeSnapshot';
import { fetchSessions } from './api/sessions';
import { SocketProvider } from './api/SocketProvider';
import { SessionLinkContext } from './components/Markdown/SessionLinkContext';
import { useMessageCacheSync } from './api/useMessageCacheSync';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { SessionSummary } from './api/types';
import { GlassTabBar, type TabKey } from './components/GlassTabBar';
import {
  ServerConfigProvider,
  useRouteFor,
} from './config/ServerConfigContext';
import { loadDrafts, saveDraft, type Drafts } from './lib/drafts';
import * as PredictiveBack from './lib/predictiveBack';
import { PushBridge, type PushOpenRequest } from './push';
import {
  AgentScreen,
  ChatScreen,
  HomeScreen,
  MockupViewer,
  ResourceGallery,
  SessionChatScreen,
  SessionInfoScreen,
  SettingsScreen,
  type GalleryTab,
} from './screens';

/** Capas apiladas sobre la conversación. */
type Layer =
  | { readonly kind: 'info' }
  | { readonly kind: 'gallery'; readonly tab: GalleryTab }
  | { readonly kind: 'mockup'; readonly name: string };

import './global.css';
import { useIsDark } from './theme';
import { applyThemePreference, loadThemePreference } from './themePreference';

// Antes del primer render que importe: así no parpadea el tema del sistema.
loadThemePreference().then(applyThemePreference);

/** Cuánto se desplaza la pantalla de atrás, como paralaje. */
const PARALLAX = 0.28;

/**
 * Curvas de Material 3. El default de `withTiming` es un ease-in-out, que
 * arranca lento: en una pantalla que entra, esos primeros milisegundos casi
 * sin desplazamiento se leen como retraso. Una decelerada sale disparada y
 * frena al final, que es lo que hace que se sienta inmediata.
 */
const ENTER = {
  duration: 320,
  easing: Easing.bezier(0.05, 0.7, 0.1, 1),
} as const;

/** Al salir conviene lo contrario: acelerar y desaparecer sin ceremonia. */
const EXIT = {
  duration: 240,
  easing: Easing.bezier(0.3, 0, 0.8, 0.15),
} as const;

/** Nada que pintar: solo mantiene viva la caché de mensajes. */

/** Fuera del JSX por `no-inline-styles`. */
const SHOWN = { display: 'flex' } as const;
const HIDDEN = { display: 'none' } as const;

function CacheSync() {
  useMessageCacheSync();
  return null;
}

function ThemedStatusBar() {
  const dark = useIsDark();
  return <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />;
}

function App() {
  return (
    // Lo exige `react-native-gesture-handler`: sin esta raíz, los gestos del
    // visor de imágenes no reciben eventos.
    <GestureHandlerRootView className="flex-1">
      <SafeAreaProvider>
        <ServerConfigProvider>
          {/* Dentro del de servidores: necesita sus rutas para saber a qué
              máquinas conectarse. */}
          <SocketProvider>
            <ThemedStatusBar />
            <CacheSync />
            <AppContent />
          </SocketProvider>
        </ServerConfigProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function AppContent() {
  const { width } = useWindowDimensions();
  const [activeTab, setActiveTab] = useState<TabKey>('chat');
  const [openSession, setOpenSession] = useState<SessionSummary | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  /** true mientras la conversación entra: retiene el trabajo pesado. */
  const [isEntering, setIsEntering] = useState(false);
  /**
   * Las capas sobre la conversación viven aquí y no dentro de ella porque
   * quien maneja el gesto de volver es esta pantalla: si no supiera qué hay
   * encima, el back cerraría la sesión entera. Un arreglo en vez de varios
   * booleanos — así «volver» siempre es sacar el último.
   */
  const [layers, setLayers] = useState<Layer[]>([]);
  const [totalMessages, setTotalMessages] = useState<number | null>(null);
  const push = useCallback((layer: Layer) => setLayers(c => [...c, layer]), []);
  // La ruta sale de la sesión abierta: con varios servidores, «el servidor»
  // ya no es uno solo.
  const { baseUrl, token } = useRouteFor(openSession?.serverId ?? '');

  /** 0 = la conversación está fuera de pantalla; 1 = cubre la lista. */
  const progress = useSharedValue(0);

  // Los borradores viven aquí porque los necesitan las dos pantallas: la de
  // sesión para restaurar el texto, y la lista para enseñar «Borrador: …».
  useEffect(() => {
    loadDrafts()
      .then(setDrafts)
      .catch(() => undefined);
  }, []);

  const handleDraftChange = useCallback((sessionId: string, text: string) => {
    saveDraft(sessionId, text)
      .then(setDrafts)
      .catch(() => undefined);
  }, []);

  const backToConversations = useCallback(() => setActiveTab('home'), []);

  /**
   * Solo monta la pantalla, fuera de cuadro. La animación no arranca aquí: si
   * empieza a la vez que el montaje, los primeros frames compiten con la
   * creación y medición de la jerarquía de vistas, y el salto se ve.
   */
  const openSessionAnimated = useCallback(
    (session: SessionSummary) => {
      setActiveTab('home');
      progress.value = 0;
      setIsEntering(true);
      setOpenSession(session);
    },
    [progress],
  );

  /**
   * Un enlace `codiby-session:<id>` dentro de un mensaje. Lo normal es que el
   * Home ya la conozca; si no —archivada, o de antes de la última recarga— se
   * pregunta al servidor de la conversación abierta.
   */
  const openSessionById = useCallback(
    async (id: string) => {
      const serverId = openSession?.serverId ?? '';
      if (openSession?.id === id) {
        return;
      }
      let target = findKnownSession(id, serverId);
      if (target === null && baseUrl.length > 0) {
        try {
          const list = await fetchSessions(baseUrl, token, serverId);
          target = list.find(session => session.id === id) ?? null;
        } catch {
          target = null;
        }
      }
      if (target === null) {
        Alert.alert('Session not found', 'It may have been deleted.');
        return;
      }
      setLayers([]);
      setTotalMessages(null);
      openSessionAnimated(target);
    },
    [openSession, baseUrl, token, openSessionAnimated],
  );

  /**
   * Opens a session on a given host: a tap on a push notification, or "Open
   * chat" in the Agent tab. Unlike a `codiby-session:` link, the request says
   * which machine it belongs to.
   */
  const openOnServer = useCallback(
    async (request: PushOpenRequest) => {
      let target = findKnownSession(request.sessionId, request.serverId);
      if (target === null) {
        try {
          const list = await fetchSessions(
            request.baseUrl,
            request.token,
            request.serverId,
          );
          target =
            list.find(session => session.id === request.sessionId) ?? null;
        } catch {
          target = null;
        }
      }
      if (target === null) {
        Alert.alert('Session not found', 'It may have been deleted.');
        return;
      }
      if (openSession?.key === target.key) {
        return;
      }
      setLayers([]);
      setTotalMessages(null);
      openSessionAnimated(target);
    },
    [openSession, openSessionAnimated],
  );

  /** Se dispara cuando la conversación ya existe y está medida. */
  const startEnterAnimation = useCallback(() => {
    if (progress.value === 0) {
      progress.value = withTiming(1, ENTER, finished => {
        if (finished === true) {
          runOnJS(setIsEntering)(false);
        }
      });
    }
  }, [progress]);

  // La sesión se desmonta al terminar la animación, no al pedir el cierre: si
  // se quitara antes, la pantalla desaparecería de golpe a media transición.
  const closeSession = useCallback(() => {
    setLayers([]);
    setTotalMessages(null);
    progress.value = withTiming(0, EXIT, finished => {
      if (finished === true) {
        runOnJS(setOpenSession)(null);
      }
    });
  }, [progress]);

  /** Cierra la capa de más arriba; solo con la pila vacía cierra la sesión. */
  const goBack = useCallback(() => {
    if (layers.length > 0) {
      setLayers(current => current.slice(0, -1));
      return;
    }
    closeSession();
  }, [layers.length, closeSession]);

  /**
   * Mientras hay una conversación abierta, el gesto predictivo es nuestro: el
   * sistema reporta el arrastre y nosotros movemos las dos capas con él. Al
   * cerrarla se vuelve a la lista. Solo desde Conversaciones se devuelve el
   * control al sistema para salir de la app.
   */
  useEffect(() => {
    if (openSession === null) {
      if (activeTab !== 'home') {
        if (PredictiveBack.IS_SUPPORTED) {
          PredictiveBack.acquire({ onCommit: backToConversations });
          return () => PredictiveBack.release();
        }
        const subscription = BackHandler.addEventListener(
          'hardwareBackPress',
          () => {
            backToConversations();
            return true;
          },
        );
        return () => subscription.remove();
      }
      PredictiveBack.release();
      return;
    }

    if (!PredictiveBack.IS_SUPPORTED) {
      // Sin el módulo nativo se cae al back clásico, sin arrastre.
      const subscription = BackHandler.addEventListener(
        'hardwareBackPress',
        () => {
          goBack();
          return true;
        },
      );
      return () => subscription.remove();
    }

    PredictiveBack.acquire({
      onProgress: event => {
        // Con algo encima, arrastrar no debe mover la conversación: lo que
        // se va a cerrar es la capa de arriba, no ella.
        if (layers.length === 0) {
          // Android reporta 0 → 1 conforme se arrastra; aquí es al revés,
          // porque 1 es «la conversación cubre la lista».
          progress.value = 1 - event.progress;
        }
      },
      onCancel: () => {
        progress.value = withTiming(1, ENTER);
      },
      onCommit: goBack,
    });

    return () => PredictiveBack.release();
  }, [
    openSession,
    activeTab,
    backToConversations,
    layers.length,
    goBack,
    progress,
  ]);

  const chatStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (1 - progress.value) * width }],
  }));

  // La lista se desplaza un poco y se oscurece: es lo que la hace leerse como
  // una capa *debajo* y no como una pantalla que se cambió de golpe.
  const homeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -progress.value * width * PARALLAX }],
  }));

  const scrimStyle = useAnimatedStyle(() => ({
    opacity: progress.value * 0.25,
  }));

  return (
    <SessionLinkContext.Provider value={openSessionById}>
    <PushBridge onOpen={openOnServer} />
    <View className="flex-1 bg-white">
      <Animated.View className="flex-1" style={homeStyle}>
        {/* El Home no se desmonta al cambiar de pestaña: desmontarlo tiraba su
            estado y al volver pedía todo otra vez a las dos máquinas. Se
            esconde y ya. */}
        <View className="flex-1" style={activeTab === 'home' ? SHOWN : HIDDEN}>
          <HomeScreen onOpenSession={openSessionAnimated} drafts={drafts} />
        </View>
        {activeTab === 'chat' ? (
          <ChatScreen
            onOpenSession={openSessionAnimated}
            onBack={backToConversations}
          />
        ) : null}
        {activeTab === 'agent' ? (
          <AgentScreen onOpenChat={openOnServer} />
        ) : null}
        {activeTab === 'settings' ? <SettingsScreen /> : null}
        {activeTab !== 'chat' ? (
          <GlassTabBar activeKey={activeTab} onChange={setActiveTab} />
        ) : null}
      </Animated.View>

      {openSession !== null ? (
        <>
          <Animated.View
            pointerEvents="none"
            style={scrimStyle}
            className="absolute inset-0 bg-black"
          />

          <Animated.View
            // Saltar de una sesión a otra por un enlace no pasa por null: sin
            // la key, la pantalla heredaría los mensajes de la anterior, y
            // `onLayout` no volvería a dispararse para la animación de entrada.
            key={openSession.key}
            style={chatStyle}
            className="absolute inset-0"
            onLayout={startEnterAnimation}
          >
            <SessionChatScreen
              session={openSession}
              onClose={closeSession}
              isReady={!isEntering}
              draft={drafts[openSession.key] ?? ''}
              onDraftChange={handleDraftChange}
              onOpenInfo={() => push({ kind: 'info' })}
              onOpenMockup={name => push({ kind: 'mockup', name })}
              onTotalMessages={setTotalMessages}
              onOpenSession={target => {
                setLayers([]);
                setTotalMessages(null);
                openSessionAnimated(target);
              }}
            />
          </Animated.View>

          {layers.map((layer, index) =>
            layer.kind === 'info' ? (
              <SessionInfoScreen
                key={`info-${index}`}
                session={openSession}
                baseUrl={baseUrl}
                token={token}
                totalMessages={totalMessages}
                onClose={goBack}
                onOpenGallery={kind => push({ kind: 'gallery', tab: kind })}
                onOpenMockup={name => push({ kind: 'mockup', name })}
                onGone={closeSession}
              />
            ) : layer.kind === 'gallery' ? (
              <ResourceGallery
                key={`gallery-${index}`}
                baseUrl={baseUrl}
                token={token}
                sessionId={openSession.id}
                sessionKey={openSession.key}
                initialTab={layer.tab}
                onClose={goBack}
                onOpenMockup={name => push({ kind: 'mockup', name })}
              />
            ) : (
              <MockupViewer
                key={`mockup-${index}`}
                baseUrl={baseUrl}
                token={token}
                sessionId={openSession.id}
                name={layer.name}
                onClose={goBack}
              />
            ),
          )}
        </>
      ) : null}
    </View>
    </SessionLinkContext.Provider>
  );
}

export default App;
