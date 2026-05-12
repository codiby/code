/**
 * OAuth-via-webview flow for sideloaded plugins. Port of
 * `src-tauri/src/lib.rs::plugin_oauth_login`.
 *
 * The plugin supplies a spec sourced from its `plugin.json` `permissions.oauth`
 * section. We open a child BrowserWindow, watch URL navigation, and on the
 * first navigation whose path matches one of `success_path_match`, harvest
 * the named cookies from `cookie_domain` and POST them to
 * `http://localhost:<bridgePort>/plugins/<plugin_id>/<credentials_endpoint>`.
 *
 * Plugins are isolated by `session.fromPartition('persist:plugin-<id>')` so
 * cookies don't bleed between plugins.
 */
import { BrowserWindow, session } from 'electron';

export type OAuthSpec = {
  plugin_id: string;
  login_url: string;
  success_path_match: string[];
  cookie_domain: string;
  cookie_names: string[];
  credentials_endpoint: string;
  window_title?: string;
  width?: number;
  height?: number;
};

function validatePluginId(id: string): void {
  if (!id || id.length > 31) throw new Error('plugin_id length must be 1..=31');
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id)) {
    throw new Error('plugin_id must match [a-z0-9][a-z0-9-]{0,30}');
  }
}

function validate(spec: OAuthSpec): void {
  validatePluginId(spec.plugin_id);
  if (!spec.credentials_endpoint.startsWith('/')) {
    throw new Error("credentials_endpoint must start with '/'");
  }
  if (!spec.cookie_names?.length) throw new Error('cookie_names must not be empty');
  if (!spec.success_path_match?.length) throw new Error('success_path_match must not be empty');
}

const activeWindows = new Map<string, BrowserWindow>();

export async function pluginOauthLogin(
  spec: OAuthSpec,
  getBridgePort: () => Promise<number>,
): Promise<void> {
  validate(spec);

  const loginUrl = new URL(spec.login_url);
  const cookieUrl = new URL(`https://${spec.cookie_domain}/`);

  // Close any prior login window for this plugin.
  const prev = activeWindows.get(spec.plugin_id);
  if (prev && !prev.isDestroyed()) {
    try { prev.close(); } catch {}
  }
  activeWindows.delete(spec.plugin_id);

  const partitionedSession = session.fromPartition(`persist:plugin-${spec.plugin_id}`);

  const win = new BrowserWindow({
    width: spec.width ?? 500,
    height: spec.height ?? 700,
    title: spec.window_title || `Sign in (${spec.plugin_id})`,
    resizable: true,
    webPreferences: {
      session: partitionedSession,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  activeWindows.set(spec.plugin_id, win);

  const successDeferred: { resolve: () => void; reject: (e: Error) => void } = (() => {
    let _resolve!: () => void;
    let _reject!: (e: Error) => void;
    const p = new Promise<void>((res, rej) => { _resolve = res; _reject = rej; });
    (p as unknown as { _resolve: typeof _resolve })._resolve = _resolve;
    return { resolve: _resolve, reject: _reject };
  })();
  const successPromise = new Promise<void>((resolve, reject) => {
    successDeferred.resolve = resolve;
    successDeferred.reject = reject;
  });

  const onNavigate = (_e: unknown, url: string) => {
    try {
      const path = new URL(url).pathname;
      if (spec.success_path_match.some((m) => path.includes(m))) {
        successDeferred.resolve();
      }
    } catch {}
  };
  win.webContents.on('did-navigate', onNavigate);
  win.webContents.on('did-redirect-navigation', onNavigate);
  win.webContents.on('did-navigate-in-page', onNavigate);

  win.on('closed', () => {
    activeWindows.delete(spec.plugin_id);
    successDeferred.reject(new Error('Login window closed before completing auth'));
  });

  await win.loadURL(loginUrl.toString());

  await successPromise;

  // Allow cookies to persist before reading them.
  await new Promise((r) => setTimeout(r, 500));

  const all = await partitionedSession.cookies.get({ url: cookieUrl.toString() });
  const captured: Record<string, string> = {};
  for (const c of all) {
    if (spec.cookie_names.includes(c.name)) {
      captured[c.name] = c.value;
    }
  }
  if (Object.keys(captured).length === 0) {
    try { win.close(); } catch {}
    throw new Error('None of the configured cookies were found after login');
  }

  const port = await getBridgePort();
  const target = `http://localhost:${port}/plugins/${spec.plugin_id}${spec.credentials_endpoint}`;

  const resp = await fetch(target, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(captured),
  });
  if (!resp.ok) {
    try { win.close(); } catch {}
    throw new Error(`Failed to deliver credentials to bridge server (HTTP ${resp.status})`);
  }

  try { win.close(); } catch {}
}
