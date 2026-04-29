/**
 * Plugin extension-point mount components. Place these in the host UI where
 * plugins should be able to contribute. Each component iterates the loaded
 * plugin registry, looks up the contributed components, and renders them.
 *
 * Plugin components receive `host` (a per-plugin namespaced API instance) as
 * a prop, plus session-scoped fields where applicable.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  getLoadedPlugins,
  loadPlugins,
  subscribePluginRegistry,
  type LoadedPlugin,
  type PluginContributionProps,
  type PluginLinkedItem,
} from '../lib/plugin-host';

/** Hook: subscribes the component to the plugin registry. */
function usePluginRegistry(): readonly LoadedPlugin[] {
  return useSyncExternalStore(subscribePluginRegistry, getLoadedPlugins, getLoadedPlugins);
}

/**
 * Mount once at app boot — kicks off the initial fetch + dynamic-imports.
 * Subsequent re-renders are driven by `subscribePluginRegistry`.
 */
export function PluginHostBootstrap(): null {
  useEffect(() => { loadPlugins(); }, []);
  return null;
}

// ---------------------------------------------------------------------------
// Sidebar panels
// ---------------------------------------------------------------------------

export function PluginSidebarPanels(): React.ReactElement | null {
  const plugins = usePluginRegistry();
  const items: Array<{ key: string; title: string; render: () => React.ReactElement }> = [];

  for (const plugin of plugins) {
    if (plugin.error) continue;
    for (const contribution of plugin.entry.contributes.sidebarPanels ?? []) {
      const Comp = plugin.components[contribution.component];
      if (!Comp) continue;
      items.push({
        key: `${plugin.entry.id}/${contribution.id}`,
        title: contribution.title,
        render: () => <Comp host={plugin.host} />,
      });
    }
  }

  if (items.length === 0) return null;

  return (
    <div className="border-t border-border">
      {items.map((item) => (
        <section key={item.key} className="border-b border-border">
          <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            {item.title}
          </div>
          <div className="px-2 pb-2">{item.render()}</div>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings sections
// ---------------------------------------------------------------------------

export function PluginSettingsSections(): React.ReactElement | null {
  const plugins = usePluginRegistry();
  const items: Array<{ key: string; title: string; render: () => React.ReactElement }> = [];

  for (const plugin of plugins) {
    if (plugin.error) continue;
    for (const contribution of plugin.entry.contributes.settingsSections ?? []) {
      const Comp = plugin.components[contribution.component];
      if (!Comp) continue;
      items.push({
        key: `${plugin.entry.id}/${contribution.id}`,
        title: contribution.title,
        render: () => <Comp host={plugin.host} />,
      });
    }
  }

  if (items.length === 0) return null;

  return (
    <>
      {items.map((item) => (
        <section key={item.key} className="space-y-3">
          <h3 className="text-sm font-semibold text-zinc-300">{item.title}</h3>
          <div>{item.render()}</div>
        </section>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Linked-item pickers (for ChatApp)
// ---------------------------------------------------------------------------

interface PluginLinkedItemPickersProps {
  sessionId: string | null;
}

export function PluginLinkedItemPickers({
  sessionId,
}: PluginLinkedItemPickersProps): React.ReactElement | null {
  const plugins = usePluginRegistry();

  // Stash the active sessionId on a window-scoped global so the per-plugin
  // host API's `session.current()` reads the right value. This is a
  // deliberately lightweight handoff — the long-term contract is via the
  // host API, not direct globals.
  useEffect(() => {
    (window as { __codibyCodeCurrentSessionId?: string | null }).__codibyCodeCurrentSessionId = sessionId;
  }, [sessionId]);

  const items: Array<{ key: string; render: () => React.ReactElement }> = [];

  for (const plugin of plugins) {
    if (plugin.error) continue;
    for (const contribution of plugin.entry.contributes.linkedItemProviders ?? []) {
      const Comp = plugin.components[contribution.component];
      if (!Comp) continue;
      items.push({
        key: `${plugin.entry.id}/${contribution.id}`,
        render: () => <Comp host={plugin.host} sessionId={sessionId} />,
      });
    }
  }

  if (items.length === 0) return null;

  return (
    <div className="flex items-center gap-2">
      {items.map((item) => (
        <span key={item.key}>{item.render()}</span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail view (single — current linked item)
// ---------------------------------------------------------------------------

export function PluginDetailView(): React.ReactElement | null {
  const plugins = usePluginRegistry();
  const [linkedItem, setLinkedItem] = useState<PluginLinkedItem | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ providerId: string; item: PluginLinkedItem | null }>;
      setLinkedItem(ev.detail?.item ?? null);
    };
    window.addEventListener('codiby-code:linked-item-changed', handler as EventListener);
    return () => window.removeEventListener('codiby-code:linked-item-changed', handler as EventListener);
  }, []);

  if (!linkedItem) return null;

  // Find the plugin that owns the linked item's providerId, then its first
  // detailViews contribution that says `matches: 'linkedItem'`.
  const plugin = plugins.find((p) => p.entry.id === linkedItem.providerId && !p.error);
  if (!plugin) return null;
  const view = (plugin.entry.contributes.detailViews ?? []).find((v) => v.matches === 'linkedItem');
  if (!view) return null;
  const Comp = plugin.components[view.component];
  if (!Comp) return null;

  return <Comp host={plugin.host} linkedItem={linkedItem} />;
}

// Re-export the prop type for convenience.
export type { PluginContributionProps };
