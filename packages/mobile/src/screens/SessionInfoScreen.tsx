import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fetchPreferences, savePinned } from '../api/preferences';
import { fetchResources, resourceUrl, type SessionResource } from '../api/resources';
import { deleteSession, renameSession, setSessionStatus } from '../api/sessions';
import type { SessionSummary } from '../api/types';
import { ImageLightbox } from '../components/Gallery';
import {
  ArchiveIcon,
  CloseIcon,
  PinIcon,
  RenameDialog,
  RenameIcon,
  TrashIcon,
} from '../components/SessionList';
import { avatarColorFor, formatFullTimestamp, initialsOf } from '../lib/format';

export interface SessionInfoScreenProps {
  readonly session: SessionSummary;
  readonly baseUrl: string;
  readonly token: string;
  /** Del `session_state`; `null` mientras no haya llegado. */
  readonly totalMessages: number | null;
  readonly onClose: () => void;
  readonly onOpenGallery: (kind: 'image' | 'mockup') => void;
  readonly onOpenMockup: (name: string) => void;
  /** La sesión dejó de existir: hay que salir del todo. */
  readonly onGone: () => void;
}

const STRIP_COUNT = 8;

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/** Quita la extensión: el mockup se abre por nombre, no por archivo. */
function mockupName(resource: SessionResource): string {
  return resource.name.replace(/\.html$/i, '');
}

export function SessionInfoScreen({
  session,
  baseUrl,
  token,
  totalMessages,
  onClose,
  onOpenGallery,
  onOpenMockup,
  onGone,
}: SessionInfoScreenProps) {
  const insets = useSafeAreaInsets();

  const [resources, setResources] = useState<SessionResource[] | null>(null);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [name, setName] = useState(session.name);
  const [isRenaming, setIsRenaming] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [zoomedIndex, setZoomedIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchResources(baseUrl, token, session.id)
      .then(list => !cancelled && setResources(list))
      .catch(() => !cancelled && setResources([]));
    fetchPreferences(baseUrl, token)
      .then(prefs => !cancelled && setPinnedIds(prefs.pinnedIds))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [baseUrl, token, session.id]);

  const images = (resources ?? []).filter(item => item.mime.startsWith('image/'));
  const mockups = (resources ?? []).filter(item => item.name.endsWith('.html'));
  const isPinned = pinnedIds.includes(session.id);

  const togglePin = useCallback(() => {
    const next = isPinned
      ? pinnedIds.filter(id => id !== session.id)
      : [session.id, ...pinnedIds];
    setPinnedIds(next);
    savePinned(baseUrl, token, next).catch(() => undefined);
  }, [isPinned, pinnedIds, baseUrl, token, session.id]);

  const toggleArchive = useCallback(() => {
    setIsWorking(true);
    setSessionStatus(baseUrl, token, session.id, session.isOpen ? 'archived' : 'open')
      .then(onClose)
      .catch(() => undefined)
      .finally(() => setIsWorking(false));
  }, [baseUrl, token, session.id, session.isOpen, onClose]);

  const confirmDelete = useCallback(() => {
    Alert.alert(
      'Borrar la sesión',
      'Se elimina del bridge. El historial en disco se conserva.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Borrar',
          style: 'destructive',
          onPress: () => {
            setIsWorking(true);
            deleteSession(baseUrl, token, session.id)
              .then(onGone)
              .catch(() => undefined)
              .finally(() => setIsWorking(false));
          },
        },
      ],
    );
  }, [baseUrl, token, session.id, onGone]);

  const applyRename = useCallback(
    (next: string) => {
      setIsWorking(true);
      renameSession(baseUrl, token, session.id, next)
        .then(() => setName(next))
        .catch(() => undefined)
        .finally(() => {
          setIsWorking(false);
          setIsRenaming(false);
        });
    },
    [baseUrl, token, session.id],
  );

  return (
    <View className="absolute inset-0 bg-slate-100">
      <View
        style={{ paddingTop: insets.top + 8 }}
        className="flex-row items-center gap-2 border-b border-slate-200 bg-white px-2 pb-3"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cerrar"
          onPress={onClose}
          className="h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
        >
          <CloseIcon size={20} color="#0f172a" />
        </Pressable>
        <Text className="flex-1 text-base font-semibold text-slate-900">
          Info de la sesión
        </Text>
        {isWorking ? <ActivityIndicator size="small" color="#64748b" /> : null}
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        <View className="items-center border-b border-slate-200 bg-white px-4 pb-4 pt-5">
          <View
            style={{ backgroundColor: avatarColorFor(session.id) }}
            className="h-20 w-20 items-center justify-center rounded-full"
          >
            <Text className="text-2xl font-bold text-white">
              {initialsOf(name)}
            </Text>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Renombrar la sesión"
            onPress={() => setIsRenaming(true)}
            className="mt-2.5 flex-row items-center gap-1.5 active:opacity-60"
          >
            <Text className="text-lg font-bold text-slate-900">{name}</Text>
            <RenameIcon size={13} color="#cbd5e1" />
          </Pressable>

          <Text className="mt-0.5 font-mono text-[11px] text-slate-400">
            {session.cwd}
          </Text>

          <View className="mt-3 flex-row flex-wrap justify-center gap-1.5">
            <View className="flex-row items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1">
              <View
                className={`h-1.5 w-1.5 rounded-full ${
                  session.isRunning ? 'bg-emerald-500' : 'bg-slate-300'
                }`}
              />
              <Text className="text-[10.5px] font-semibold text-slate-600">
                {session.isOpen ? 'activa' : 'archivada'}
              </Text>
            </View>
            {session.provider !== null ? (
              <View className="rounded-full bg-slate-100 px-2.5 py-1">
                <Text className="text-[10.5px] font-semibold text-slate-600">
                  {session.provider}
                </Text>
              </View>
            ) : null}
          </View>
        </View>

        {resources === null ? (
          <View className="items-center py-8">
            <ActivityIndicator size="small" color="#94a3b8" />
          </View>
        ) : (
          <>
            {images.length > 0 ? (
              <View className="mt-2 border-y border-slate-200 bg-white">
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onOpenGallery('image')}
                  className="flex-row items-center px-4 pb-2 pt-3 active:opacity-60"
                >
                  <Text className="text-[12.5px] font-semibold text-slate-700">
                    Imágenes
                  </Text>
                  <Text className="ml-auto text-[11.5px] text-slate-400">
                    {`${images.length} ›`}
                  </Text>
                </Pressable>

                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerClassName="gap-1.5 px-4 pb-3"
                >
                  {images.slice(0, STRIP_COUNT).map((item, index) => (
                    <Pressable
                      key={item.id}
                      accessibilityRole="imagebutton"
                      accessibilityLabel={item.name}
                      // Tocar una miniatura abre esa imagen, no la rejilla:
                      // la rejilla se llega por el «14 ›» de la cabecera.
                      onPress={() => setZoomedIndex(index)}
                      className="active:opacity-80"
                    >
                      <Image
                        source={{ uri: resourceUrl(baseUrl, item, token) }}
                        className="h-[74px] w-[74px] rounded-xl bg-slate-100"
                      />
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            ) : null}

            {mockups.length > 0 ? (
              <View className="mt-2 border-y border-slate-200 bg-white">
                <View className="flex-row items-center px-4 pb-2 pt-3">
                  <Text className="text-[12.5px] font-semibold text-slate-700">
                    Mockups
                  </Text>
                  <Text className="ml-auto text-[11.5px] text-slate-400">
                    {mockups.length}
                  </Text>
                </View>
                {mockups.map((item, index) => (
                  <View
                    key={item.id}
                    className={`flex-row items-center gap-3 px-4 py-2.5 ${
                      index === 0 ? '' : 'border-t border-slate-100'
                    }`}
                  >
                    <View className="h-8 w-8 items-center justify-center rounded-lg bg-violet-600">
                      <Text className="text-[13px] text-white">◨</Text>
                    </View>
                    <View className="flex-1">
                      <Text
                        numberOfLines={1}
                        className="text-[13px] font-semibold text-slate-900"
                      >
                        {mockupName(item)}
                      </Text>
                      <Text className="text-[11px] text-slate-400">
                        {sizeLabel(item.size)}
                      </Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Abrir ${mockupName(item)}`}
                      onPress={() => onOpenMockup(mockupName(item))}
                      className="rounded-full bg-slate-900 px-3 py-1 active:opacity-70"
                    >
                      <Text className="text-[11px] font-bold text-white">
                        Ver
                      </Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        )}

        <View className="mt-2 border-y border-slate-200 bg-white">
          {[
            ['Carpeta', session.cwd],
            ['Proveedor', session.provider ?? '—'],
            ['Actualizada', formatFullTimestamp(session.updatedAt)],
            // `totalMessages` viene del `session_state` del chat: pedirlo solo
            // para esta ficha significaría abrir otro socket.
            ['Mensajes', totalMessages === null ? '—' : String(totalMessages)],
          ].map(([key, value], index) => (
            <View
              key={key}
              className={`flex-row px-4 py-2.5 ${
                index === 0 ? '' : 'border-t border-slate-100'
              }`}
            >
              <Text className="w-24 text-[12.5px] text-slate-400">{key}</Text>
              <Text
                numberOfLines={1}
                className={`flex-1 text-[12.5px] text-slate-700 ${
                  key === 'Carpeta' ? 'font-mono text-[11px]' : ''
                }`}
              >
                {value}
              </Text>
            </View>
          ))}
        </View>

        <View className="mt-2 border-y border-slate-200 bg-white">
          <Pressable
            accessibilityRole="button"
            onPress={togglePin}
            className="flex-row items-center gap-3 px-4 py-3 active:bg-slate-50"
          >
            <PinIcon size={18} color={isPinned ? '#0f172a' : '#475569'} />
            <Text className="text-[13.5px] text-slate-700">
              {isPinned ? 'Quitar de arriba' : 'Anclar arriba'}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={toggleArchive}
            className="flex-row items-center gap-3 border-t border-slate-100 px-4 py-3 active:bg-slate-50"
          >
            <ArchiveIcon size={18} color="#475569" />
            <Text className="text-[13.5px] text-slate-700">
              {session.isOpen ? 'Archivar' : 'Desarchivar'}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={confirmDelete}
            className="flex-row items-center gap-3 border-t border-slate-100 px-4 py-3 active:bg-rose-50"
          >
            <TrashIcon size={18} color="#be123c" />
            <Text className="text-[13.5px] text-rose-700">
              Borrar la sesión
            </Text>
          </Pressable>
        </View>
      </ScrollView>

      {zoomedIndex !== null ? (
        <ImageLightbox
          items={images.map(item => ({
            id: item.id,
            uri: resourceUrl(baseUrl, item, token),
            name: item.name,
          }))}
          initialIndex={zoomedIndex}
          onClose={() => setZoomedIndex(null)}
        />
      ) : null}

      <RenameDialog
        visible={isRenaming}
        initialName={name}
        isWorking={isWorking}
        onCancel={() => setIsRenaming(false)}
        onSubmit={applyRename}
      />
    </View>
  );
}
