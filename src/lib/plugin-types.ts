/**
 * Shared plugin contract — the types both the host (frontend + bridge) and
 * plugin authors program against. Used type-only on the server side so there
 * is no runtime coupling between `server/` and `src/`.
 *
 * Layout on disk:
 *   ~/.codiby/plugins/<id>/plugin.json
 *   ~/.codiby/plugins/<id>/dist/ui.js          (optional — frontend contributions)
 *   ~/.codiby/plugins/<id>/dist/server.js      (optional — bridge contributions)
 *   ~/.codiby/plugins/<id>/dist/assets/...     (served at /plugins/<id>/static/...)
 *   ~/.codiby/plugins/<id>/state.json          (host-managed; per-plugin namespaced)
 *   ~/.codiby/plugins/<id>/secrets.json        (host-managed; chmod 0o600)
 */

export const CODIBY_CODE_PLUGIN_API_VERSION = '1' as const;

export type CodibyCodePluginApiVersion = typeof CODIBY_CODE_PLUGIN_API_VERSION;

export interface PluginManifest {
  /** Folder name; must match `[a-z0-9][a-z0-9-]{0,30}` and be unique. */
  id: string;
  /** Human-facing display name. */
  name: string;
  /** Semver. */
  version: string;
  /** Major version of the host API this plugin targets. */
  codibyCodeApi: CodibyCodePluginApiVersion;
  /** Optional one-liner shown in the Plugins settings list. */
  description?: string;
  /** Optional homepage / repo URL. */
  homepage?: string;

  ui?: {
    /** Path inside the plugin dir to the ESM bundle (e.g. "dist/ui.js"). */
    entry: string;
    contributes: PluginContributions;
  };

  server?: {
    /** Path inside the plugin dir to the bridge ESM bundle. */
    entry: string;
  };

  permissions: PluginPermissions;
}

export interface PluginContributions {
  sidebarPanels?: SidebarPanelContribution[];
  settingsSections?: SettingsSectionContribution[];
  /** "Linked item" providers feed the per-chat ticket-style dropdown in ChatApp. */
  linkedItemProviders?: LinkedItemProviderContribution[];
  /** Detail views render below/alongside the chat for the active linked item. */
  detailViews?: DetailViewContribution[];
}

export interface SidebarPanelContribution {
  id: string;
  title: string;
  /** Optional lucide-style icon name. */
  icon?: string;
  /** Named export in the plugin's UI bundle. */
  component: string;
}

export interface SettingsSectionContribution {
  id: string;
  title: string;
  component: string;
}

export interface LinkedItemProviderContribution {
  id: string;
  /** Label shown in the picker (e.g. "Ticket"). */
  label: string;
  component: string;
}

export interface DetailViewContribution {
  id: string;
  /** Render this view when the chat session has a linked item from this provider. */
  matches: 'linkedItem' | 'route';
  component: string;
}

export interface PluginPermissions {
  /** Domain allow-list applied to host.fetch on the server side. */
  network?: string[];
  /** OAuth-via-webview spec; if present, plugins may invoke `plugin_oauth_login`. */
  oauth?: OAuthSpec;
  /** True if the plugin uses `host.storage.state()` / `.secrets()`. */
  storage?: boolean;
  /** True if the plugin contributes MCP tools. */
  mcpTools?: boolean;
}

export interface OAuthSpec {
  /** URL the webview opens to begin the auth flow. */
  login_url: string;
  /** Path substrings that signal "auth complete" — first match triggers cookie capture. */
  success_path_match: string[];
  /** Cookies are read only for this exact host (no parent-domain widening). */
  cookie_domain: string;
  /** Only cookies whose names appear here are forwarded to the bridge. */
  cookie_names: string[];
  /**
   * Path on the bridge to POST the captured cookies to.
   * Auto-prefixed with `/plugins/<id>` by the host. Body: `{ [cookieName]: value }`.
   */
  credentials_endpoint: string;
  window_title?: string;
  width?: number;
  height?: number;
}

// ---------------------------------------------------------------------------
// Host APIs visible to plugin code
// ---------------------------------------------------------------------------

/**
 * Frontend host API, injected into plugin React components via context.
 * All methods that hit the bridge are auto-namespaced to the plugin's id.
 */
export interface PluginHostAPI {
  /** Plugin's manifest id, exposed for diagnostics. */
  pluginId: string;

  /**
   * Fetch from the bridge. The path is rewritten to `/plugins/<id><path>`.
   * Pass leading "/" or not — both work.
   */
  serverFetch(path: string, init?: RequestInit): Promise<Response>;

  /**
   * Invoke a whitelisted native command on the desktop app. Currently allowed:
   *   - "plugin_oauth_login" — opens the OAuth webview using the manifest's spec
   *   - "plugin_open_url"    — open URL in the user's default browser
   */
  invokeNative<T = unknown>(cmd: AllowedPluginNativeCommand, args?: unknown): Promise<T>;

  /** Per-plugin client-side key/value store (persisted by the bridge). */
  storage: {
    get<T = unknown>(key: string): Promise<T | null>;
    set<T = unknown>(key: string, value: T): Promise<void>;
  };

  /** Current chat session + linked-item bridge. */
  session: {
    current(): { id: string | null };
    onLinkedItemChange(cb: (itemId: string | null) => void): () => void;
    setLinkedItem(itemId: string | null, label: string): void;
  };

  /** Subscribe to bridge → frontend broadcasts (server-side `broadcastToFrontend`). */
  ws: { subscribe<T = unknown>(topic: string, cb: (msg: T) => void): () => void };
}

export type AllowedPluginNativeCommand = 'plugin_oauth_login' | 'plugin_open_url';

// ---------------------------------------------------------------------------
// Wire types — what the bridge returns to the frontend at GET /plugins
// ---------------------------------------------------------------------------

export interface PluginListEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  /** True if a `dist/ui.js` is present and loaded. */
  hasUi: boolean;
  /** True if a `dist/server.js` was loaded into the bridge process. */
  hasServer: boolean;
  /** Cache-buster appended to the ui.js URL on every load. */
  buildHash: string;
  /** Manifest contributions (what to mount where). */
  contributes: PluginContributions;
  /** Last load error, if any. */
  error?: string;
}
