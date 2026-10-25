import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ServerError } from '../api/client';
import { sendMessage } from '../api/messages';
import {
  fetchProviderModels,
  fetchUserHome,
  listDirs,
  PROVIDERS,
  type ProviderModel,
  type ProviderName,
} from '../api/providers';
import { createSession } from '../api/sessions';
import type { MessageImage, SessionSummary } from '../api/types';
import { useServers } from '../config/ServerConfigContext';
import { ROUTE_DOT, routeState } from '../config/servers';

/** Qué máquina y qué agente usaste la última vez. Es de este teléfono. */
const LAST_SERVER_KEY = 'codiby.new-session-server';
const LAST_PROVIDER_KEY = 'codiby.new-session-provider';

/** Cuántas carpetas recientes caben sin que la fila se vuelva un menú. */
const MAX_RECENTS = 6;

export interface NewSessionSheetProps {
  readonly visible: boolean;
  /**
   * Todo lo que hay en la lista. Solo se usa para sacar las carpetas
   * recientes: dónde abriste sesión antes es el mejor predictor de dónde vas
   * a abrir la siguiente.
   */
  readonly sessions: SessionSummary[];
  readonly initial?: {
    readonly serverId: string;
    readonly cwd: string;
    readonly name: string;
    readonly text: string;
    readonly images: MessageImage[];
  };
  readonly onCancel: () => void;
  /** La sesión ya existe en el bridge cuando esto se dispara. */
  readonly onCreated: (session: SessionSummary) => void;
}

function isProvider(value: string): value is ProviderName {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** Último segmento de la ruta, que es como se llama el proyecto. */
function folderOf(path: string): string {
  const clean = path.replace(/\/+$/, '');
  const segments = clean.split('/').filter(segment => segment.length > 0);
  return segments[segments.length - 1] ?? clean;
}

function parentOf(path: string): string {
  const clean = path.replace(/\/+$/, '');
  const cut = clean.lastIndexOf('/');
  return cut <= 0 ? '/' : clean.slice(0, cut);
}

interface OptionProps {
  readonly label: string;
  readonly isActive: boolean;
  readonly onPress: () => void;
  readonly dotColor?: string;
  readonly disabled?: boolean;
}

function Option({ label, isActive, onPress, dotColor, disabled }: OptionProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: isActive, disabled: disabled === true }}
      onPress={onPress}
      disabled={disabled}
      className={`flex-row items-center gap-1.5 rounded-full px-3 py-1.5 active:opacity-70 ${
        isActive ? 'bg-slate-900' : 'bg-slate-100'
      } ${disabled === true ? 'opacity-40' : ''}`}
    >
      {dotColor !== undefined ? (
        <View
          style={{ backgroundColor: dotColor }}
          className="h-2 w-2 rounded-full"
        />
      ) : null}
      <Text
        numberOfLines={1}
        className={`max-w-[190px] text-xs font-semibold ${
          isActive ? 'text-white' : 'text-slate-600'
        }`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function Label({ children }: { readonly children: string }) {
  return (
    <Text className="px-5 pb-1.5 pt-4 text-[9.5px] font-bold uppercase tracking-widest text-slate-400">
      {children}
    </Text>
  );
}

/**
 * Abrir una sesión desde el teléfono.
 *
 * La carpeta se elige de tres maneras porque ninguna sola sirve siempre:
 * recientes para lo de todos los días, subcarpetas para bajar un nivel sin
 * teclear, y la ruta a mano para lo que no está en ninguna de las dos.
 */
export function NewSessionSheet({
  visible,
  sessions,
  initial,
  onCancel,
  onCreated,
}: NewSessionSheetProps) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const { servers, routes } = useServers();

  const [serverId, setServerId] = useState('');
  const [cwd, setCwd] = useState('');
  const [dirs, setDirs] = useState<string[]>([]);
  const [isListing, setIsListing] = useState(false);
  const [provider, setProvider] = useState<ProviderName>('claude');
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * La sesión que ya se creó en un intento anterior. Existe para que
   * reintentar tras un primer mensaje fallido no abra una segunda sesión: el
   * `POST /sessions` ya surtió efecto aunque la pantalla siga aquí.
   */
  const created = useRef<SessionSummary | null>(null);

  /** Los que responden por alguna ruta; a los demás no se les puede pedir. */
  const reachable = useMemo(
    () =>
      servers.filter(server => (routes[server.id]?.baseUrl ?? '').length > 0),
    [servers, routes],
  );

  const route = routes[serverId];
  const baseUrl = route?.baseUrl ?? '';
  const token = route?.token ?? '';

  /** Carpetas donde ya hay sesiones en esa máquina, de la más reciente. */
  const recents = useMemo(() => {
    const seen: string[] = [];
    for (const session of [...sessions].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    )) {
      if (session.serverId !== serverId || session.cwd.length === 0) {
        continue;
      }
      const clean = session.cwd.replace(/\/+$/, '');
      if (!seen.includes(clean)) {
        seen.push(clean);
      }
      if (seen.length === MAX_RECENTS) {
        break;
      }
    }
    return seen;
  }, [sessions, serverId]);

  // Al abrir: campos en blanco y la máquina y el agente de la última vez, si
  // esa máquina sigue contestando.
  useEffect(() => {
    if (!visible) {
      return;
    }
    let cancelled = false;
    created.current = null;
    setError(null);
    setName(initial?.name ?? '');
    setPrompt(initial?.text ?? '');
    setModel(null);

    Promise.all([
      AsyncStorage.getItem(LAST_SERVER_KEY),
      AsyncStorage.getItem(LAST_PROVIDER_KEY),
    ])
      .then(([lastServer, lastProvider]) => {
        if (cancelled) {
          return;
        }
        const fallback = reachable[0]?.id ?? '';
        setServerId(
          initial && reachable.some(s => s.id === initial.serverId)
            ? initial.serverId
            : lastServer !== null && reachable.some(s => s.id === lastServer)
            ? lastServer
            : fallback,
        );
        if (lastProvider !== null && isProvider(lastProvider)) {
          setProvider(lastProvider);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setServerId(reachable[0]?.id ?? '');
        }
      });

    return () => {
      cancelled = true;
    };
    // `reachable` se recrea en cada render; lo que importa es que la hoja se
    // abrió.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Al elegir máquina: la carpeta de partida es la última donde trabajaste
  // ahí, y si no hay ninguna, su carpeta personal.
  useEffect(() => {
    if (!visible || baseUrl.length === 0) {
      return;
    }
    if (initial?.serverId === serverId && initial.cwd.length > 0) {
      setCwd(initial.cwd);
      return;
    }
    const recent = recents[0];
    if (recent !== undefined) {
      setCwd(recent);
      return;
    }
    let cancelled = false;
    fetchUserHome(baseUrl, token)
      .then(home => {
        if (!cancelled) {
          setCwd(home.replace(/\/+$/, ''));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCwd('/');
        }
      });
    return () => {
      cancelled = true;
    };
    // `recents` cambia con la lista de sesiones y volvería a mover la carpeta
    // bajo los dedos; aquí solo interesa el momento en que cambia la máquina.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, serverId, baseUrl, token]);

  // Subcarpetas de donde estás. Con retardo porque `cwd` también cambia letra
  // a letra al escribir la ruta a mano.
  useEffect(() => {
    if (!visible || baseUrl.length === 0 || cwd.trim().length === 0) {
      setDirs([]);
      return;
    }
    let cancelled = false;
    setIsListing(true);
    const timer = setTimeout(() => {
      listDirs(baseUrl, token, cwd.trim())
        .then(found => {
          if (!cancelled) {
            setDirs(found);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setDirs([]);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setIsListing(false);
          }
        });
    }, 280);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [visible, baseUrl, token, cwd]);

  // Modelos del agente elegido en esa máquina. Claude devuelve lista vacía
  // hasta que ha arrancado una sesión suya ahí, así que el campo desaparece
  // en vez de enseñar un hueco.
  useEffect(() => {
    if (!visible || baseUrl.length === 0) {
      setModels([]);
      return;
    }
    let cancelled = false;
    setModel(null);
    fetchProviderModels(baseUrl, token, provider)
      .then(found => {
        if (!cancelled) {
          setModels(found);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModels([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [visible, baseUrl, token, provider]);

  const close = useCallback(() => {
    if (isCreating) {
      return;
    }
    onCancel();
  }, [isCreating, onCancel]);

  const submit = async () => {
    const path =
      cwd.trim().replace(/\/+$/, '') || (cwd.trim() === '/' ? '/' : '');
    if (isCreating || path.length === 0 || baseUrl.length === 0) {
      return;
    }
    setIsCreating(true);
    setError(null);
    const text = prompt.trim();
    try {
      const session =
        created.current ??
        (await createSession(baseUrl, token, serverId, {
          cwd: path,
          name: name.trim(),
          provider,
          model,
        }));
      created.current = session;

      if (text.length > 0 || (initial?.images.length ?? 0) > 0) {
        const destination = routes[session.serverId];
        if (!destination?.baseUrl) {
          throw new ServerError('El host de la sesión no responde');
        }
        await sendMessage(
          destination.baseUrl,
          session.id,
          destination.token,
          text,
          initial?.images,
        );
      }

      await Promise.all([
        AsyncStorage.setItem(LAST_SERVER_KEY, serverId),
        AsyncStorage.setItem(LAST_PROVIDER_KEY, provider),
      ]).catch(() => undefined);

      created.current = null;
      onCreated(session);
    } catch (problem) {
      const detail =
        problem instanceof ServerError
          ? problem.message
          : 'No se pudo crear la sesión';
      setError(
        created.current === null
          ? detail
          : `La sesión ya está abierta, pero el primer mensaje no salió: ${detail}`,
      );
    } finally {
      setIsCreating(false);
    }
  };

  const canCreate = cwd.trim().length > 0 && baseUrl.length > 0 && !isCreating;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={close}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancelar"
        onPress={close}
        className="flex-1 bg-slate-900/40"
      />
      <View
        style={{ paddingBottom: insets.bottom + 12 }}
        className="rounded-t-[26px] bg-white pt-2"
      >
        <View className="mx-auto mb-4 h-1 w-9 rounded-full bg-slate-200" />
        <Text className="px-5 text-[17px] font-bold text-slate-900">
          Nueva sesión
        </Text>
        <Text className="px-5 pt-1 text-[12px] leading-5 text-slate-500">
          {reachable.length === 0
            ? 'Ningún servidor responde: no hay dónde abrirla.'
            : 'El agente arranca en cuanto la creas.'}
        </Text>

        <ScrollView
          pointerEvents={created.current !== null ? 'none' : 'auto'}
          style={{ maxHeight: height * 0.5 }}
          keyboardShouldPersistTaps="handled"
        >
          <Label>Servidor</Label>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2 px-5"
          >
            {servers.map(server => {
              const serverRoute = routes[server.id];
              const info = routeState(
                (serverRoute?.baseUrl ?? '').length > 0,
                serverRoute?.path ?? null,
                serverRoute?.isProbing ?? false,
              );
              const isDown = (serverRoute?.baseUrl ?? '').length === 0;
              return (
                <Option
                  key={server.id}
                  label={server.name.length > 0 ? server.name : 'Sin nombre'}
                  isActive={server.id === serverId}
                  onPress={() => setServerId(server.id)}
                  dotColor={ROUTE_DOT[info.dot].backgroundColor}
                  disabled={isDown}
                />
              );
            })}
          </ScrollView>

          <Label>Carpeta</Label>
          {recents.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerClassName="gap-2 px-5"
            >
              {recents.map(path => (
                <Option
                  key={path}
                  label={folderOf(path)}
                  isActive={cwd.trim().replace(/\/+$/, '') === path}
                  onPress={() => setCwd(path)}
                />
              ))}
            </ScrollView>
          ) : null}

          <TextInput
            value={cwd}
            onChangeText={setCwd}
            placeholder="/ruta/del/proyecto"
            placeholderTextColor="#94a3b8"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            // Sin altura fija y con relleno vertical, como el buscador del
            // encabezado: en Android una `height` recorta los descendentes.
            className="mx-5 mt-2.5 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-[13px] leading-5 text-slate-900"
          />

          <View className="mt-2 h-8 flex-row items-center">
            {isListing ? (
              <Text className="px-5 text-[11px] text-slate-400">Leyendo…</Text>
            ) : (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerClassName="items-center gap-2 px-5"
              >
                <Option
                  label="↑ Subir"
                  isActive={false}
                  onPress={() => setCwd(parentOf(cwd))}
                  disabled={cwd.trim().replace(/\/+$/, '').length === 0}
                />
                {dirs.map(dir => (
                  <Option
                    key={dir}
                    label={folderOf(dir)}
                    isActive={false}
                    onPress={() => setCwd(dir.replace(/\/+$/, ''))}
                  />
                ))}
                {dirs.length === 0 ? (
                  <Text className="text-[11px] text-slate-400">
                    Sin subcarpetas
                  </Text>
                ) : null}
              </ScrollView>
            )}
          </View>

          <Label>Agente</Label>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2 px-5"
          >
            {PROVIDERS.map(item => (
              <Option
                key={item}
                label={item}
                isActive={item === provider}
                onPress={() => setProvider(item)}
              />
            ))}
          </ScrollView>

          {models.length > 0 ? (
            <>
              <Label>Modelo</Label>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerClassName="gap-2 px-5"
              >
                <Option
                  label="Por defecto"
                  isActive={model === null}
                  onPress={() => setModel(null)}
                />
                {models.map(item => (
                  <Option
                    key={item.id}
                    label={item.label}
                    isActive={item.id === model}
                    onPress={() => setModel(item.id)}
                  />
                ))}
              </ScrollView>
            </>
          ) : null}

          <Label>Nombre</Label>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Opcional — el bridge la numera si lo dejas vacío"
            placeholderTextColor="#94a3b8"
            className="mx-5 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-[14px] leading-5 text-slate-900"
          />

          <Label>Primer mensaje</Label>
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            placeholder="Opcional. Si lo escribes, la sesión nace trabajando."
            placeholderTextColor="#94a3b8"
            multiline
            className="mx-5 mb-4 h-[76px] rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-[14px] leading-5 text-slate-900"
          />
        </ScrollView>

        {error !== null ? (
          <Text className="px-5 pt-3 text-[12px] leading-4 text-rose-600">
            {error}
          </Text>
        ) : null}

        <View className="flex-row items-center gap-3 px-5 pt-3">
          <Pressable
            accessibilityRole="button"
            onPress={close}
            disabled={isCreating}
            className="rounded-full px-4 py-3 active:bg-slate-100"
          >
            <Text className="text-[14px] font-semibold text-slate-500">
              Cancelar
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !canCreate }}
            onPress={submit}
            disabled={!canCreate}
            className={`flex-1 flex-row items-center justify-center gap-2 rounded-full py-3.5 ${
              canCreate ? 'bg-slate-900 active:opacity-80' : 'bg-slate-200'
            }`}
          >
            {isCreating ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : null}
            <Text
              className={`text-[14.5px] font-bold ${
                canCreate ? 'text-white' : 'text-slate-400'
              }`}
            >
              {prompt.trim().length > 0 ? 'Crear y enviar' : 'Crear sesión'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
