import { useState } from 'react';
import {
  Image,
  Modal,
  Pressable,
  Text,
  View,
  type ImageLoadEvent,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import type { MessageImage } from '../../api/types';
import { ImageLightbox } from '../Gallery';

export interface ChatImageProps {
  readonly image: MessageImage;
}

/** Mientras no se sepa el tamaño real, se reserva un hueco con esta forma. */
const FALLBACK_RATIO = 4 / 3;

/** Una captura de móvil es muy vertical; sin tope ocuparía toda la pantalla. */
const MIN_RATIO = 0.62;

function toUri(image: MessageImage): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

export function ChatImage({ image }: ChatImageProps) {
  const uri = toUri(image);
  const [ratio, setRatio] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // `Image.getSize` no sirve aquí: en Android resuelve la URI por la vía de
  // red y una `data:` la rechaza. El tamaño real viene en el evento de carga
  // del propio componente, que sí decodifica el base64.
  const onLoad = (event: ImageLoadEvent) => {
    const { width, height } = event.nativeEvent.source;
    if (width > 0 && height > 0) {
      setRatio(width / height);
    }
  };

  if (failed) {
    return (
      <View className="my-1 rounded-lg bg-slate-100 px-3 py-2">
        <Text className="text-[11px] text-slate-400">
          {`No se pudo abrir la imagen (${image.mediaType})`}
        </Text>
      </View>
    );
  }

  const bubbleRatio = Math.max(ratio ?? FALLBACK_RATIO, MIN_RATIO);

  return (
    <>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel="Abrir imagen"
        onPress={() => setIsFullscreen(true)}
        className="my-1 active:opacity-80"
      >
        <Image
          source={{ uri }}
          style={{ aspectRatio: bubbleRatio }}
          resizeMode="cover"
          onLoad={onLoad}
          onError={() => setFailed(true)}
          className="w-full rounded-lg bg-slate-100"
        />
      </Pressable>

      <Modal
        visible={isFullscreen}
        transparent
        animationType="fade"
        onRequestClose={() => setIsFullscreen(false)}
      >
        {isFullscreen ? (
          // Android Modal owns a separate native root; gestures need their
          // own handler root even though the app already has one.
          <GestureHandlerRootView style={{ flex: 1 }}>
            <ImageLightbox
              items={[{ id: 'chat-image', uri, name: 'Imagen' }]}
              initialIndex={0}
              onClose={() => setIsFullscreen(false)}
            />
          </GestureHandlerRootView>
        ) : null}
      </Modal>
    </>
  );
}

export function ChatImages({ images }: { readonly images: MessageImage[] }) {
  if (images.length === 0) {
    return null;
  }
  return (
    <View>
      {images.map((image, index) => (
        <ChatImage key={index} image={image} />
      ))}
    </View>
  );
}
