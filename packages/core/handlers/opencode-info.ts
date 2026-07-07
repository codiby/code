/**
 * Cached probe of the opencode SDK + binary.
 *
 * The bridge calls `getOpencodeInfo()` once per process lifetime to:
 *   1. confirm the `opencode` binary is installed and bootable, and
 *   2. fetch the union of models exposed by every provider the user is
 *      currently authenticated for.
 *
 * Spinning up an opencode server takes several seconds, so we memoise
 * the result. Subsequent calls (e.g. from the frontend on each app
 * mount, or per-session at thread start) hit the cache and return
 * synchronously. If the first probe fails (binary missing, no auth
 * configured, port collision), `available` flips to false and the
 * cache sticks — the frontend uses that flag to hide the OpenCode
 * provider entirely until the bridge is restarted.
 */

import { createOpencodeServer, createOpencodeClient } from '@opencode-ai/sdk';
import { createServer } from 'net';

export type OpenCodeModel = { id: string; label: string; providerName: string };
export type OpenCodeInfo = {
  available: boolean;
  models: OpenCodeModel[];
  error?: string;
};

let cached: OpenCodeInfo | null = null;
let inflight: Promise<OpenCodeInfo> | null = null;

async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr && typeof addr.port === 'number') {
        const port = addr.port;
        srv.close((err) => (err ? reject(err) : resolve(port)));
      } else {
        srv.close();
        reject(new Error('Failed to bind ephemeral port for opencode probe'));
      }
    });
  });
}

async function fetchInfo(): Promise<OpenCodeInfo> {
  let server: { url: string; close: () => void } | null = null;
  try {
    const port = await findFreePort();
    server = await createOpencodeServer({ hostname: '127.0.0.1', port, timeout: 10000 });
    const client = createOpencodeClient({ baseUrl: server.url });
    const result = await client.provider.list({ throwOnError: true });
    const data = (result as { data?: { all?: unknown[]; connected?: string[] } }).data;
    const all = (data?.all ?? []) as Array<{
      id: string;
      name: string;
      models: Record<string, { id: string; name: string; status?: string }>;
    }>;
    const connected = new Set(data?.connected ?? []);
    const models: OpenCodeModel[] = [];
    for (const provider of all) {
      // Only surface providers the user is authenticated for; listing
      // every backend just to grey them out is more noise than help.
      if (!connected.has(provider.id)) continue;
      for (const [, model] of Object.entries(provider.models)) {
        if (model.status === 'deprecated') continue;
        models.push({
          id: `${provider.id}/${model.id}`,
          label: model.name,
          providerName: provider.name,
        });
      }
    }
    models.sort((a, b) => {
      if (a.providerName !== b.providerName) return a.providerName.localeCompare(b.providerName);
      return a.label.localeCompare(b.label);
    });
    return { available: true, models };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { available: false, models: [], error: message };
  } finally {
    server?.close();
  }
}

export async function getOpencodeInfo(): Promise<OpenCodeInfo> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = fetchInfo();
  const result = await inflight;
  cached = result;
  inflight = null;
  return result;
}
