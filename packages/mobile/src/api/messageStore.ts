import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ChatMessage, MessageImage } from './types';

export interface CachedPage {
  readonly messages: ChatMessage[];
  readonly hasMore: boolean;
}

/**
 * Cuántas conversaciones se guardan, en memoria y en disco.
 *
 * El contenido ya viene acotado desde `normalizeContent` —8 000 caracteres por
 * mensaje y las imágenes fuera del texto—, pero el tope existe igual: esta app
 * ya llegó a 3,4 GB una vez por confiarse con lo que cabía en memoria. Por eso
 * además se guardan solo los últimos `MAX_STORED_MESSAGES` de cada una.
 */
const MAX_SESSIONS = 30;
const MAX_STORED_MESSAGES = 120;

/**
 * Una imagen más grande que esto no se guarda en disco. Una fila de
 * AsyncStorage no pasa de ~2 MB en Android, y la conversación ya se entiende
 * sin la captura: la próxima sincronización la vuelve a traer si hace falta.
 */
const MAX_STORED_IMAGE_CHARS = 150_000;

const PREFIX = 'codiby.msgs.';
const INDEX_KEY = 'codiby.msgs.index';

/** sessionKey → última página vista, en orden de uso (la más reciente al final). */
const cache = new Map<string, CachedPage>();
const listeners = new Map<string, Set<() => void>>();

function notify(sessionKey: string) {
  for (const listener of listeners.get(sessionKey) ?? []) {
    listener();
  }
}

/** Mueve al final y desaloja lo más viejo: un LRU sobre el orden del `Map`. */
function touch(sessionKey: string, page: CachedPage) {
  cache.delete(sessionKey);
  cache.set(sessionKey, page);
  const evicted: string[] = [];
  while (cache.size > MAX_SESSIONS) {
    const oldest = cache.keys().next();
    if (oldest.done === true) {
      break;
    }
    cache.delete(oldest.value);
    evicted.push(oldest.value);
  }
  if (evicted.length > 0) {
    AsyncStorage.removeMany(evicted.map(key => PREFIX + key)).catch(
      () => undefined,
    );
  }
}

// ── Disco ─────────────────────────────────────────────────────────────────────

const dirty = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Los mensajes llegan a ráfagas mientras el agente trabaja: se escribe agrupado. */
const FLUSH_DELAY_MS = 1_200;

function forDisk(page: CachedPage): CachedPage {
  const messages = page.messages
    // Las burbujas optimistas aún no existen en el bridge: guardarlas las
    // resucitaría duplicadas junto al eco real. Las fallidas sí se guardan:
    // son lo único que queda de un mensaje que no llegó.
    .filter(
      message =>
        !message.id.startsWith('local-') || message.sendState === 'failed',
    )
    .slice(-MAX_STORED_MESSAGES)
    .map(message =>
      message.images.length === 0
        ? message
        : {
            ...message,
            images: message.images.filter(
              (image: MessageImage) =>
                image.data.length <= MAX_STORED_IMAGE_CHARS,
            ),
          },
    );
  return {
    messages,
    // Si se recortó, hay más atrás aunque el bridge dijera que no.
    hasMore: page.hasMore || messages.length < page.messages.length,
  };
}

function scheduleFlush(sessionKey: string) {
  dirty.add(sessionKey);
  if (flushTimer !== null) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const entries: Record<string, string> = {};
    for (const key of dirty) {
      const page = cache.get(key);
      if (page !== undefined) {
        entries[PREFIX + key] = JSON.stringify(forDisk(page));
      }
    }
    dirty.clear();
    entries[INDEX_KEY] = JSON.stringify([...cache.keys()]);
    AsyncStorage.setMany(entries).catch(() => {
      // Perderlo solo cuesta que el próximo arranque tenga que pedirlo.
    });
  }, FLUSH_DELAY_MS);
}

/**
 * Carga lo guardado en disco a la memoria. Arranca al importar el módulo, así
 * que para cuando alguien abre un chat ya está: la conversación se pinta en el
 * primer fotograma aunque la app se haya cerrado del todo.
 */
const hydrated: Promise<void> = (async () => {
  try {
    const rawIndex = await AsyncStorage.getItem(INDEX_KEY);
    const index: unknown = JSON.parse(rawIndex ?? '[]');
    if (!Array.isArray(index)) {
      return;
    }
    const keys = index.filter((key): key is string => typeof key === 'string');
    const entries = await AsyncStorage.getMany(keys.map(key => PREFIX + key));
    // En el orden del índice: el LRU queda como estaba al cerrar la app.
    for (const sessionKey of keys) {
      const raw = entries[PREFIX + sessionKey] ?? null;
      // Lo que llegó por la red mientras se leía el disco es más nuevo.
      if (raw === null || cache.has(sessionKey)) {
        continue;
      }
      try {
        const page = JSON.parse(raw) as CachedPage;
        if (Array.isArray(page.messages)) {
          touch(sessionKey, { messages: page.messages, hasMore: page.hasMore === true });
          notify(sessionKey);
        }
      } catch {
        // Una entrada corrupta se ignora; la red la reemplaza.
      }
    }
  } catch {
    // Sin disco se sigue con la red, como antes.
  }
})();

/** Resuelve cuando lo guardado en disco ya está en memoria. */
export function whenHydrated(): Promise<void> {
  return hydrated;
}

// ── API ───────────────────────────────────────────────────────────────────────

export function readMessages(sessionKey: string): CachedPage | null {
  return cache.get(sessionKey) ?? null;
}

export function writeMessages(
  sessionKey: string,
  messages: ChatMessage[],
  hasMore: boolean,
) {
  touch(sessionKey, { messages, hasMore });
  scheduleFlush(sessionKey);
  notify(sessionKey);
}

/**
 * Añade un mensaje que llegó por el socket.
 *
 * Solo toca sesiones ya cacheadas: si nunca abriste ese chat, guardar mensajes
 * sueltos daría una página con agujeros —sin el historial que va antes— y al
 * abrirla parecería que la conversación empieza a la mitad.
 */
export function appendMessage(sessionKey: string, message: ChatMessage) {
  const page = cache.get(sessionKey);
  if (page === undefined) {
    return;
  }
  if (page.messages.some(item => item.id === message.id)) {
    return;
  }
  touch(sessionKey, {
    messages: [...page.messages, message],
    hasMore: page.hasMore,
  });
  scheduleFlush(sessionKey);
  notify(sessionKey);
}

export function subscribeMessages(sessionKey: string, listener: () => void) {
  let owned = listeners.get(sessionKey);
  if (owned === undefined) {
    owned = new Set();
    listeners.set(sessionKey, owned);
  }
  owned.add(listener);
  return () => {
    owned.delete(listener);
    if (owned.size === 0) {
      listeners.delete(sessionKey);
    }
  };
}

/** Para cuando una sesión se borra o se renombra desde otro sitio. */
export function forgetMessages(sessionKey: string) {
  cache.delete(sessionKey);
  AsyncStorage.removeItem(PREFIX + sessionKey).catch(() => undefined);
  notify(sessionKey);
}

export { lastSeqOf, mergeNewer } from '../lib/messageMerge';
