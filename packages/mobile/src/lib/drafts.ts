import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'codiby.drafts';

export type Drafts = Readonly<Record<string, string>>;

/**
 * Los borradores viven solo en el teléfono: el bridge no tiene dónde guardarlos
 * y sincronizarlos con el escritorio sería otra discusión. Se guardan todos en
 * una clave para que la lista los lea de una sola vez.
 */
export async function loadDrafts(): Promise<Drafts> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }
    const drafts: Record<string, string> = {};
    for (const [id, text] of Object.entries(parsed)) {
      if (typeof text === 'string' && text.trim().length > 0) {
        drafts[id] = text;
      }
    }
    return drafts;
  } catch {
    return {};
  }
}

/** Guardar vacío borra la entrada, para que no queden claves muertas. */
export async function saveDraft(
  sessionId: string,
  text: string,
): Promise<Drafts> {
  const drafts = { ...(await loadDrafts()) };
  if (text.trim().length === 0) {
    delete drafts[sessionId];
  } else {
    drafts[sessionId] = text;
  }
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  return drafts;
}
