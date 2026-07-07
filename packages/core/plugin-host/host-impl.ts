/**
 * Per-plugin server host implementation. Constructs the `PluginServerHost`
 * object handed to each plugin's `register(host)` function and tracks the
 * routes / SDK tools / intervals it registered (so the loader and dispatcher
 * can read them back).
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { log as bridgeLog } from '../logger';
import type {
  HttpMethod,
  PluginManifest,
  PluginRouteHandler,
  PluginServerHost,
  PluginServerStorage,
  RegisteredSdkTool,
  SdkToolResult,
} from './types';

export const PLUGINS_ROOT = join(homedir(), '.codiby', 'plugins');

/** Read/write state in this plugin's namespaced dir. */
function makePluginStorage(pluginId: string): PluginServerStorage {
  const dir = join(PLUGINS_ROOT, pluginId);
  const stateFile = join(dir, 'state.json');
  const secretsFile = join(dir, 'secrets.json');

  function ensureDir() {
    try { mkdirSync(dir, { recursive: true }); } catch {}
  }

  return {
    state<T = Record<string, unknown>>() {
      return {
        load(defaults?: T): T {
          try {
            return JSON.parse(readFileSync(stateFile, 'utf-8')) as T;
          } catch {
            return (defaults ?? ({} as T)) as T;
          }
        },
        save(value: T): void {
          ensureDir();
          writeFileSync(stateFile, JSON.stringify(value, null, 2));
        },
      };
    },
    secrets() {
      return {
        load(): Record<string, string> {
          try {
            return JSON.parse(readFileSync(secretsFile, 'utf-8')) as Record<string, string>;
          } catch {
            return {};
          }
        },
        save(value: Record<string, string>): void {
          ensureDir();
          writeFileSync(secretsFile, JSON.stringify(value, null, 2));
          // Restrict to owner — these are credentials.
          try { chmodSync(secretsFile, 0o600); } catch {}
        },
      };
    },
  };
}

/**
 * Build a fetch wrapper that rejects requests to hosts outside the manifest's
 * `permissions.network` allow-list. Same-host different-port still counts as
 * allowed; subdomains do NOT widen — exact host match only.
 */
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function makeAllowlistedFetch(allowed: string[] | undefined): FetchLike {
  // Falsy/empty allow-list ⇒ no network at all (fail-closed).
  const set = new Set(allowed ?? []);
  return async function pluginFetch(input: RequestInfo | URL, init?: RequestInit) {
    const urlStr = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    let host: string;
    try { host = new URL(urlStr).host.split(':')[0] ?? ''; } catch { throw new Error('plugin fetch: invalid URL'); }
    if (!set.has(host)) {
      throw new Error(`plugin fetch: host "${host}" not in manifest.permissions.network`);
    }
    return fetch(input, init);
  };
}

export interface RouteEntry {
  method: HttpMethod;
  /** Route pattern relative to /plugins/<id> (e.g. "/items/:id"). Leading slash required. */
  pattern: string;
  /** Pre-compiled regex for matching `ctx.params`. */
  regex: RegExp;
  paramNames: string[];
  handler: PluginRouteHandler;
}

export interface LoadedPluginRuntime {
  manifest: PluginManifest;
  /** Routes the plugin registered, keyed by `<METHOD> <pattern>` for diagnostics. */
  routes: RouteEntry[];
  /** Fully-built SDK tools (already prefixed with `<id>_`). */
  sdkTools: RegisteredSdkTool[];
  /** Disposers for any intervals the plugin scheduled. */
  intervals: Array<{ name: string; dispose: () => void }>;
  /** Build hash for cache-busting `ui.js` URLs (mtime of the manifest at load time). */
  buildHash: string;
  /** Last error from register() — null on success. */
  error: string | null;
}

export interface HostBridgeAdapter {
  /** Push a JSON message to all connected frontend WebSocket clients. */
  broadcastToAllFrontends(message: object): void;
}

const TOOL_NAME_LIMIT = 60;

/**
 * Build the host object handed to one plugin. Mutates the supplied
 * `LoadedPluginRuntime` as the plugin registers things.
 */
export function createPluginServerHost(
  runtime: LoadedPluginRuntime,
  bridge: HostBridgeAdapter,
): PluginServerHost {
  const { manifest } = runtime;
  const allowedNetwork = manifest.permissions?.network;

  return {
    id: manifest.id,

    log(message: string) {
      bridgeLog(`[plugin:${manifest.id}] ${message}`);
    },

    registerRoute(method: HttpMethod, path: string, handler: PluginRouteHandler) {
      if (!path.startsWith('/')) {
        throw new Error(`plugin "${manifest.id}" registerRoute: path must start with "/"`);
      }
      const { regex, paramNames } = compileRoutePattern(path);
      runtime.routes.push({ method, pattern: path, regex, paramNames, handler });
    },

    registerSdkTool(name, description, inputShape, handler) {
      const prefixed = `${manifest.id}_${name}`;
      if (prefixed.length > TOOL_NAME_LIMIT) {
        throw new Error(
          `plugin "${manifest.id}" tool name "${prefixed}" is ${prefixed.length} chars (max ${TOOL_NAME_LIMIT}).`,
        );
      }
      const def = tool(prefixed, description, inputShape, async (args) => {
        const result = await (handler as (a: unknown) => Promise<SdkToolResult>)(args);
        // CallToolResult shape: { content: [...], isError?: boolean }
        return { content: result.content, ...(result.isError ? { isError: true } : {}) };
      });
      runtime.sdkTools.push(def as RegisteredSdkTool);
    },

    storage: makePluginStorage(manifest.id),

    scheduleInterval(intervalMs, callback, name) {
      const handle = setInterval(async () => {
        try { await callback(); }
        catch (err) {
          bridgeLog(`[plugin:${manifest.id}] interval "${name}" failed: ${String(err)}`);
        }
      }, intervalMs);
      const dispose = () => clearInterval(handle);
      runtime.intervals.push({ name, dispose });
      return dispose;
    },

    fetch: makeAllowlistedFetch(allowedNetwork) as typeof fetch,

    broadcastToFrontend(topic, message) {
      bridge.broadcastToAllFrontends({
        type: 'plugin_message',
        pluginId: manifest.id,
        topic,
        payload: message,
      });
    },

    z,
  };
}

/**
 * Compile a route pattern like `/items/:id/comments` into a regex + the names
 * of the captured params. Trailing `/` is normalised away so `/foo` and `/foo/`
 * both match.
 */
export function compileRoutePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const escaped = pattern.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
  const re = escaped.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${re.replace(/\/$/, '')}/?$`), paramNames };
}
