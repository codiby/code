/**
 * IndexedDB-based storage for chat messages and session data.
 * No size limits, async, doesn't block the UI.
 */

const DB_NAME = 'codiby-code';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('messages')) {
        db.createObjectStore('messages');
      }
      if (!db.objectStoreNames.contains('data')) {
        db.createObjectStore('data');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function loadMessages(sessionId: string): Promise<unknown[]> {
  try {
    const db = await getDB();
    const result: unknown[] = await new Promise((resolve) => {
      const tx = db.transaction('messages', 'readonly');
      const req = tx.objectStore('messages').get(sessionId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
    if (result.length > 0) return result;

    // Migrate from localStorage if IndexedDB is empty
    const lsKey = `claude-ui-msgs-${sessionId}`;
    try {
      const lsData = JSON.parse(localStorage.getItem(lsKey) || '[]');
      if (lsData.length > 0) {
        // Save to IndexedDB and remove from localStorage
        const tx = db.transaction('messages', 'readwrite');
        tx.objectStore('messages').put(lsData, sessionId);
        localStorage.removeItem(lsKey);
        return lsData;
      }
    } catch {}
    return [];
  } catch {
    // IndexedDB not available — use localStorage directly
    try {
      return JSON.parse(localStorage.getItem(`claude-ui-msgs-${sessionId}`) || '[]');
    } catch { return []; }
  }
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function saveMessages(sessionId: string, messages: unknown[]) {
  clearTimeout(saveTimers.get(sessionId));
  saveTimers.set(sessionId, setTimeout(async () => {
    try {
      // Trim large terminal output
      const slim = (messages as any[]).map(m =>
        m.isTerminal && m.content?.length > 10000
          ? { ...m, content: m.content.slice(-5000) }
          : m
      );
      const db = await getDB();
      const tx = db.transaction('messages', 'readwrite');
      tx.objectStore('messages').put(slim, sessionId);
    } catch {}
  }, 300));
}

export async function deleteMessages(sessionId: string) {
  clearTimeout(saveTimers.get(sessionId));
  try {
    const db = await getDB();
    const tx = db.transaction('messages', 'readwrite');
    tx.objectStore('messages').delete(sessionId);
  } catch {}
  // Also clean localStorage legacy
  try { localStorage.removeItem(`claude-ui-msgs-${sessionId}`); } catch {}
}

/** Generic key-value store for session data */
export async function getData<T>(key: string, fallback: T): Promise<T> {
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction('data', 'readonly');
      const req = tx.objectStore('data').get(key);
      req.onsuccess = () => resolve(req.result ?? fallback);
      req.onerror = () => resolve(fallback);
    });
  } catch { return fallback; }
}

export async function setData(key: string, value: unknown) {
  try {
    const db = await getDB();
    const tx = db.transaction('data', 'readwrite');
    tx.objectStore('data').put(value, key);
  } catch {}
}
