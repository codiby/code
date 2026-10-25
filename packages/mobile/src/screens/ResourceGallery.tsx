import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fetchResources, resourceUrl, type SessionResource } from '../api/resources';
import { ImageLightbox } from '../components/Gallery';
import { CloseIcon } from '../components/SessionList';

export type GalleryTab = 'image' | 'mockup';

export interface ResourceGalleryProps {
  readonly baseUrl: string;
  readonly token: string;
  readonly sessionId: string;
  readonly initialTab: GalleryTab;
  readonly onClose: () => void;
  readonly onOpenMockup: (name: string) => void;
}

const COLUMNS = 3;
const GAP = 3;

/** Separador entre filas de la rejilla. */
function GridGap() {
  return <View style={{ height: GAP }} />;
}

function mockupName(resource: SessionResource): string {
  return resource.name.replace(/\.html$/i, '');
}

export function ResourceGallery({
  baseUrl,
  token,
  sessionId,
  initialTab,
  onClose,
  onOpenMockup,
}: ResourceGalleryProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  const [resources, setResources] = useState<SessionResource[] | null>(null);
  const [tab, setTab] = useState<GalleryTab>(initialTab);
  const [zoomedIndex, setZoomedIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchResources(baseUrl, token, sessionId)
      .then(list => !cancelled && setResources(list))
      .catch(() => !cancelled && setResources([]));
    return () => {
      cancelled = true;
    };
  }, [baseUrl, token, sessionId]);

  const images = useMemo(
    () => (resources ?? []).filter(item => item.mime.startsWith('image/')),
    [resources],
  );
  const mockups = useMemo(
    () => (resources ?? []).filter(item => item.name.endsWith('.html')),
    [resources],
  );

  const cell = Math.floor((width - GAP * (COLUMNS + 1)) / COLUMNS);
  const shown = tab === 'image' ? images : mockups;

  return (
    <View className="absolute inset-0 bg-white">
      <View
        style={{ paddingTop: insets.top + 8 }}
        className="flex-row items-center gap-2 bg-white px-2 pb-3"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Volver"
          onPress={onClose}
          className="h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
        >
          <CloseIcon size={20} color="#0f172a" />
        </Pressable>
        <Text className="flex-1 text-base font-semibold text-slate-900">
          {`Recursos · ${images.length + mockups.length}`}
        </Text>
      </View>

      <View className="flex-row border-b border-slate-200 bg-white">
        {(['image', 'mockup'] as const).map(value => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityState={{ selected: tab === value }}
            onPress={() => setTab(value)}
            className={`flex-1 items-center py-3 ${
              tab === value ? 'border-b-2 border-slate-900' : ''
            }`}
          >
            <Text
              className={`text-[12.5px] font-semibold ${
                tab === value ? 'text-slate-900' : 'text-slate-400'
              }`}
            >
              {value === 'image'
                ? `Imágenes ${images.length}`
                : `Mockups ${mockups.length}`}
            </Text>
          </Pressable>
        ))}
      </View>

      {resources === null ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#64748b" />
        </View>
      ) : tab === 'image' ? (
        <FlatList
          data={shown}
          keyExtractor={item => item.id}
          numColumns={COLUMNS}
          contentContainerStyle={{ padding: GAP, paddingBottom: insets.bottom + GAP }}
          columnWrapperStyle={{ gap: GAP }}
          ItemSeparatorComponent={GridGap}
          renderItem={({ item, index }) => (
            <Pressable
              accessibilityRole="imagebutton"
              accessibilityLabel={item.name}
              onPress={() => setZoomedIndex(index)}
              className="active:opacity-80"
            >
              <Image
                source={{ uri: resourceUrl(baseUrl, item, token) }}
                style={{ width: cell, height: cell }}
                className="rounded bg-slate-100"
              />
            </Pressable>
          )}
        />
      ) : (
        <FlatList
          data={shown}
          keyExtractor={item => item.id}
          contentContainerStyle={{ paddingBottom: insets.bottom }}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Abrir ${mockupName(item)}`}
              onPress={() => onOpenMockup(mockupName(item))}
              className="flex-row items-center gap-3 border-b border-slate-100 px-4 py-3 active:bg-slate-50"
            >
              <View className="h-9 w-9 items-center justify-center rounded-lg bg-violet-600">
                <Text className="text-sm text-white">◨</Text>
              </View>
              <Text
                numberOfLines={1}
                className="flex-1 text-[13.5px] font-semibold text-slate-900"
              >
                {mockupName(item)}
              </Text>
              <Text className="text-[11px] text-slate-400">
                {`${Math.round(item.size / 1024)} KB`}
              </Text>
            </Pressable>
          )}
        />
      )}

      {/* El visor es local a la galería: se desliza entre las imágenes que
          ya están cargadas, así que no merece una capa de la pila. */}
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
    </View>
  );
}
