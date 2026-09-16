/** Manual folder order in the sidebar, keyed by parent (`''` = root).
 *
 *  It used to live in this window's localStorage, so every machine and every
 *  device listed the same folders in its own order. The server's preferences
 *  (`groupOrder`) are now the source of truth; the old localStorage copy is
 *  only read once, to seed a server that has never stored an order. */

export type GroupOrder = Record<string, string[]>;

const LEGACY_KEY = 'tabBarGroupOrderByParent';
const LEGACY_FLAT_KEY = 'tabBarGroupOrder';

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : null;
}

/** The `groupOrder` a preferences blob carries, or null when it has none. */
export function parseGroupOrder(value: unknown): GroupOrder | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: GroupOrder = {};
  for (const [parent, ids] of Object.entries(value)) {
    const arr = stringArray(ids);
    if (arr) out[parent] = arr;
  }
  return out;
}

/** Take the order this window kept before it moved server-side, and forget it.
 *  Null when there is nothing to migrate. */
export function takeLegacyGroupOrder(): GroupOrder | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    const flat = localStorage.getItem(LEGACY_FLAT_KEY);
    localStorage.removeItem(LEGACY_KEY);
    localStorage.removeItem(LEGACY_FLAT_KEY);
    const nested = raw ? parseGroupOrder(JSON.parse(raw)) : null;
    if (nested && Object.keys(nested).length) return nested;
    const legacy = flat ? stringArray(JSON.parse(flat)) : null;
    return legacy?.length ? { '': legacy } : null;
  } catch {
    return null;
  }
}
