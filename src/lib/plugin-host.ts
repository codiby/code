/**
 * Frontend plugin host — fetches the manifest list from the bridge, dynamically
 * imports each plugin's `ui.js`, and surfaces a per-plugin `PluginHostAPI` that
 * the plugin's React components receive as a prop.
 *
 * Plugin components must be named exports of the plugin's `ui.js` whose names
 * match the `component:` field in their contribution manifest entry. They do
 * NOT import anything from the host — they receive the API by prop:
 *
 *     export function BoardPanel({ host }) { ... }
 *
 * React/ReactDOM identity is shared between host and plugins via an importmap
 * (set up in `scripts/build.ts`). Without that, hooks called inside plugin
 * components would crash on a "two Reacts" mismatch.
 */
import type {
  PluginHostAPI,
  PluginListEntry,
  AllowedPluginTauriCommand,
} from './plugin-types';

export type PluginComponent = React.ComponentType<PluginContributionProps>;

export interface PluginLinkedItem {
  providerId: string;
  itemId: string;
  label: string;
}

export interface PluginContributionProps {
  host: PluginHostAPI;
  sessionId?: string | null;
  linkedItem?: PluginLinkedItem | null;
}

export interface LoadedPlugin {
  entry: PluginListEntry;
  /** Named exports of the plugin's `ui.js`, looked up by `contribution.component`. */
  components: Record<string, PluginComponent>;
  /** Cached host API instance for this plugin. */
  host: PluginHostAPI;
  /** Last load error, if any. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Registry singleton + subscription
// ---------------------------------------------------------------------------

let plugins: LoadedPlugin[] = [];
const subscribers = new Set<() => void>();
let loadPromise: Promise<void> | null = null;

function notify() {
  for (const cb of subscribers) {
    try { cb(); } catch {}
  }
}

export function getLoadedPlugins(): readonly LoadedPlugin[] {
  return plugins;
}

export function subscribePluginRegistry(cb: () => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Idempotent — multiple callers share one in-flight load. Re-call after a
 * plugin enable/disable change to refresh.
 */
export function loadPlugins(): Promise<void> {
  if (!loadPromise) loadPromise = doLoadPlugins().finally(() => { loadPromise = null; });
  return loadPromise;
}

async function doLoadPlugins(): Promise<void> {
  let entries: PluginListEntry[] = [];
  try {
    const res = await fetch('/plugins');
    if (!res.ok) throw new Error(`GET /plugins → ${res.status}`);
    entries = (await res.json()) as PluginListEntry[];
  } catch (err) {
    console.error('[plugin-host] failed to fetch /plugins:', err);
    plugins = [];
    notify();
    return;
  }

  const next: LoadedPlugin[] = [];
  for (const entry of entries) {
    if (!entry.enabled || !entry.hasUi) {
      next.push({
        entry,
        components: {},
        host: createHostAPI(entry.id),
        error: entry.error,
      });
      continue;
    }
    const url = `/plugins/${encodeURIComponent(entry.id)}/static/${entryUrlPath(entry)}?v=${encodeURIComponent(entry.buildHash)}`;
    try {
      const mod: Record<string, unknown> = await import(/* @vite-ignore */ url);
      // Sanity check: a plugin that bundled its own React would have an
      // exported `React` whose identity differs from window.React. Reject it
      // — hooks inside the plugin would crash later anyway with cryptic errors.
      const sharedReact = (globalThis as { React?: unknown }).React;
      if ('React' in mod && sharedReact && mod.React !== sharedReact) {
        throw new Error(`plugin "${entry.id}" bundled its own React — did the build forget to externalize "react"?`);
      }
      const components: Record<string, PluginComponent> = {};
      for (const name of expectedComponentNames(entry)) {
        const c = mod[name];
        if (typeof c === 'function') components[name] = c as PluginComponent;
      }
      next.push({ entry, components, host: createHostAPI(entry.id) });
    } catch (err) {
      console.error(`[plugin-host] failed to load "${entry.id}" UI:`, err);
      next.push({
        entry,
        components: {},
        host: createHostAPI(entry.id),
        error: String((err as Error)?.message ?? err),
      });
    }
  }

  plugins = next;
  notify();
}

function entryUrlPath(_entry: PluginListEntry): string {
  // Convention: plugins put their UI bundle at `dist/ui.js`. The wire
  // `PluginListEntry` does not echo `manifest.ui.entry` because in v1 every
  // plugin uses the convention; if that needs to vary, surface the path
  // on `PluginListEntry` and look it up here.
  return 'dist/ui.js';
}

function expectedComponentNames(entry: PluginListEntry): string[] {
  const c = entry.contributes;
  return [
    ...(c.sidebarPanels ?? []).map((x) => x.component),
    ...(c.settingsSections ?? []).map((x) => x.component),
    ...(c.linkedItemProviders ?? []).map((x) => x.component),
    ...(c.detailViews ?? []).map((x) => x.component),
  ];
}

// ---------------------------------------------------------------------------
// Host API factory — one per plugin id
// ---------------------------------------------------------------------------

const TAURI_ALLOWED: ReadonlySet<AllowedPluginTauriCommand> = new Set([
  'plugin_oauth_login',
  'plugin_open_url',
]);

function createHostAPI(pluginId: string): PluginHostAPI {
  const linkedItemSubs = new Set<(itemId: string | null) => void>();
  let currentLinkedItem: PluginLinkedItem | null = null;

  return {
    pluginId,

    serverFetch(path, init) {
      const cleaned = path.startsWith('/') ? path : `/${path}`;
      return fetch(`/plugins/${encodeURIComponent(pluginId)}${cleaned}`, init);
    },

    async invokeTauri<T = unknown>(cmd: AllowedPluginTauriCommand, args?: unknown): Promise<T> {
      if (!TAURI_ALLOWED.has(cmd)) {
        throw new Error(`plugin host: command "${cmd}" not whitelisted`);
      }
      // Dynamic-import @tauri-apps/api/core so the browser dev server (no
      // Tauri context) doesn't crash at module-eval time.
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<T>(cmd, args as Record<string, unknown> | undefined);
    },

    storage: {
      async get<T = unknown>(key: string): Promise<T | null> {
        const raw = localStorage.getItem(`plugin:${pluginId}:${key}`);
        if (raw === null) return null;
        try { return JSON.parse(raw) as T; } catch { return null; }
      },
      async set<T = unknown>(key: string, value: T): Promise<void> {
        localStorage.setItem(`plugin:${pluginId}:${key}`, JSON.stringify(value));
      },
    },

    session: {
      current() {
        // Wired up by `<PluginExtensionMount />` via context — for now,
        // global window-scoped reference. (Stage 1.8 will inject from ChatApp.)
        const id = (window as { __codibyCodeCurrentSessionId?: string }).__codibyCodeCurrentSessionId ?? null;
        return { id };
      },
      onLinkedItemChange(cb) {
        linkedItemSubs.add(cb);
        return () => { linkedItemSubs.delete(cb); };
      },
      setLinkedItem(itemId, label) {
        currentLinkedItem = itemId
          ? { providerId: pluginId, itemId, label }
          : null;
        for (const fn of linkedItemSubs) {
          try { fn(itemId); } catch {}
        }
        // Notify listeners outside this plugin's API — the host re-renders
        // <PluginDetailView /> based on currentLinkedItem.
        window.dispatchEvent(new CustomEvent('codiby-code:linked-item-changed', {
          detail: { providerId: pluginId, item: currentLinkedItem },
        }));
      },
    },

    ws: {
      subscribe<T = unknown>(topic: string, cb: (msg: T) => void): () => void {
        const handler = (e: Event) => {
          const ev = e as CustomEvent<{ pluginId: string; topic: string; payload: T }>;
          if (ev.detail?.pluginId !== pluginId) return;
          if (ev.detail.topic !== topic) return;
          cb(ev.detail.payload);
        };
        window.addEventListener('codiby-code:plugin-message', handler as EventListener);
        return () => window.removeEventListener('codiby-code:plugin-message', handler as EventListener);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Bridge WS → window event bridge
// ---------------------------------------------------------------------------

/**
 * Wire the existing app-wide WebSocket so frames of `{type:'plugin_message', pluginId, topic, payload}`
 * become `codiby-code:plugin-message` window events that `host.ws.subscribe` listens to.
 * Call once from the app's WS handler.
 */
export function dispatchPluginMessage(msg: { pluginId: string; topic: string; payload: unknown }): void {
  window.dispatchEvent(new CustomEvent('codiby-code:plugin-message', { detail: msg }));
}
