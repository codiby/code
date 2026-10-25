import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { fetchResources, resourceUrl } from '../api/resources';
import { CloseIcon } from '../components/SessionList';

const styles = StyleSheet.create({ web: { flex: 1 } });

export interface MockupViewerProps {
  readonly baseUrl: string;
  readonly token: string;
  readonly sessionId: string;
  /** Nombre del mockup tal como se escribió, sin la extensión. */
  readonly name: string;
  readonly onClose: () => void;
}

/**
 * Muestra un mockup de la sesión a pantalla completa.
 *
 * El bridge ya los guarda como recursos y los sirve con `Content-Type:
 * text/html`, así que basta apuntar el WebView a su `/raw` — no hay que copiar
 * el HTML ni servirlo desde la app.
 */
export function MockupViewer({
  baseUrl,
  token,
  sessionId,
  name,
  onClose,
}: MockupViewerProps) {
  const insets = useSafeAreaInsets();
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchResources(baseUrl, token, sessionId, 'mockup')
      .then(resources => {
        if (cancelled) {
          return;
        }
        // El recurso se guarda como `<nombre>.html`.
        const match =
          resources.find(item => item.name === `${name}.html`) ??
          resources.find(item => item.name.startsWith(name));
        if (match === undefined) {
          setError(`No encontré el mockup «${name}» en esta sesión.`);
          return;
        }
        setUri(resourceUrl(baseUrl, match, token));
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'Error desconocido'),
      );
    return () => {
      cancelled = true;
    };
  }, [baseUrl, token, sessionId, name]);

  return (
    <View className="absolute inset-0 bg-white">
      <View
        style={{ paddingTop: insets.top + 8 }}
        className="flex-row items-center gap-2 border-b border-slate-200 bg-white px-2 pb-3"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cerrar el mockup"
          onPress={onClose}
          className="h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
        >
          <CloseIcon size={20} color="#0f172a" />
        </Pressable>
        <Text
          numberOfLines={1}
          className="flex-1 text-base font-semibold text-slate-900"
        >
          {name}
        </Text>
      </View>

      {error !== null ? (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-sm text-slate-500">{error}</Text>
        </View>
      ) : uri === null ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#64748b" />
        </View>
      ) : (
        <WebView
          source={{ uri }}
          // Los mockups son autocontenidos y pueden traer scripts propios.
          javaScriptEnabled
          // Sin esto, un mockup con `<img>` local no cargaría nada.
          originWhitelist={['*']}
          startInLoadingState
          // `className` no aplica: NativeWind no tiene registrado el WebView.
          // TypeScript lo acepta por la augmentación global, pero en runtime
          // se quedaría sin altura.
          style={styles.web}
        />
      )}

      <View style={{ height: insets.bottom }} />
    </View>
  );
}
