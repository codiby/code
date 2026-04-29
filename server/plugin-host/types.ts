/**
 * Server-side plugin types — only consumed inside the bridge process.
 * Cross-cutting types (manifest, contributions, OAuth spec, frontend host API)
 * live in `src/lib/plugin-types.ts` and are re-exported here for ergonomics.
 */
import type { z, ZodRawShape } from 'zod';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

export type {
  PluginManifest,
  PluginContributions,
  PluginPermissions,
  OAuthSpec,
  PluginListEntry,
  SidebarPanelContribution,
  SettingsSectionContribution,
  LinkedItemProviderContribution,
  DetailViewContribution,
} from '../../src/lib/plugin-types';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface PluginRouteContext {
  /** Path params extracted from the route definition (`:foo` style). */
  params: Record<string, string>;
  /** Query string of the request URL. */
  searchParams: URLSearchParams;
}

export type PluginRouteHandler = (
  req: Request,
  ctx: PluginRouteContext,
) => Promise<Response> | Response;

export interface PluginServerStorage {
  state<T = Record<string, unknown>>(): {
    load(defaults?: T): T;
    save(value: T): void;
  };
  secrets(): {
    load(): Record<string, string>;
    save(value: Record<string, string>): void;
  };
}

export interface SdkToolTextContent {
  type: 'text';
  text: string;
}

export interface SdkToolResult {
  content: SdkToolTextContent[];
  isError?: boolean;
}

/**
 * Concrete SDK tool descriptor produced by `registerSdkTool` and merged into
 * `codiby-code-sdk`. We use `<any>` here because `createSdkMcpServer` types
 * its `tools` array as `SdkMcpToolDefinition<any>[]` — narrowing the schema
 * causes an incompatible-handler-arg variance error at the merge point.
 */
export type RegisteredSdkTool = SdkMcpToolDefinition<any>;

export interface PluginServerHost {
  /** Plugin id (manifest.id; matches its folder name). */
  id: string;

  log(message: string): void;

  /**
   * Mount an HTTP route. The full URL is `/plugins/<id><path>`, where `<path>` may
   * include `:param` segments captured into `ctx.params`. Methods register independently;
   * a path may have different handlers per method.
   */
  registerRoute(method: HttpMethod, path: string, handler: PluginRouteHandler): void;

  /**
   * Add an MCP tool that will run inside the bridge process (codiby-code-sdk MCP server).
   * The exposed tool name is `<pluginId>_<name>`. Tool names must remain ≤60 chars
   * after prefixing (Claude's tool-name limit is 64).
   */
  registerSdkTool<T extends ZodRawShape>(
    name: string,
    description: string,
    inputShape: T,
    handler: (args: z.infer<z.ZodObject<T>>) => Promise<SdkToolResult>,
  ): void;

  /** Per-plugin persisted storage (state.json + secrets.json under `~/.codiby/plugins/<id>/`). */
  storage: PluginServerStorage;

  /** Schedule a recurring callback. Returns a disposer — call to cancel. */
  scheduleInterval(
    intervalMs: number,
    callback: () => Promise<void> | void,
    name: string,
  ): () => void;

  /** Domain-allow-listed fetch (only hosts in `manifest.permissions.network`). */
  fetch: typeof fetch;

  /** Push a message to every connected frontend client. Reaches plugin UI via host.ws.subscribe. */
  broadcastToFrontend(topic: string, message: object): void;

  /** Re-exported Zod from the bridge's installed copy — use this in `inputShape`. */
  z: typeof z;
}

export type PluginRegisterFn = (host: PluginServerHost) => void | Promise<void>;

/** Each plugin's server entry must export a register function (default or named). */
export interface PluginServerModule {
  default?: PluginRegisterFn;
  register?: PluginRegisterFn;
}
