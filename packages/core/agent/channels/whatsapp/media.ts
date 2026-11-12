/**
 * Inbound WhatsApp media. wacli has no "download this message" command, but
 * its backend serves `GET /media?jid&id&account` (what `wa backup` uses),
 * authenticated with the same bearer token the CLI reads from its config
 * (`WACLI_CONFIG_PATH` or ~/.wacli/config.json, overridable with
 * WACLI_BACKEND_URL / WACLI_TOKEN). The token never leaves this module.
 */

import { homedir } from 'os';
import { join } from 'path';
import { readJson } from '../../store';

export interface WacliBackend {
  url: string;
  token: string;
}

export function readWacliBackend(configPath = ''): WacliBackend | null {
  const file = configPath || process.env.WACLI_CONFIG_PATH || join(homedir(), '.wacli', 'config.json');
  const cfg = readJson<{ token?: unknown; backendUrl?: unknown } | null>(file, null);
  const token = process.env.WACLI_TOKEN || (typeof cfg?.token === 'string' ? cfg.token : '');
  const url = process.env.WACLI_BACKEND_URL || (typeof cfg?.backendUrl === 'string' ? cfg.backendUrl : '') || 'http://127.0.0.1:3000';
  if (!token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type MediaResult =
  | { ok: true; data: Uint8Array; mime: string }
  | { ok: false; reason: string };

export async function downloadWacliMedia(
  backend: WacliBackend,
  ref: { jid: string; id: string; account?: string | null },
  opts: { fetch?: FetchLike; maxBytes?: number } = {},
): Promise<MediaResult> {
  const q = new URLSearchParams({ jid: ref.jid, id: ref.id, ...(ref.account ? { account: ref.account } : {}) });
  const maxBytes = opts.maxBytes ?? 20 * 1024 * 1024;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${backend.url}/media?${q}`, {
      headers: { authorization: `Bearer ${backend.token}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return { ok: false, reason: `backend unreachable (${err instanceof Error ? err.message : err})` };
  }
  if (res.status === 410) return { ok: false, reason: 'expired on WhatsApp' };
  if (!res.ok) return { ok: false, reason: `backend returned ${res.status}` };
  const length = Number(res.headers.get('content-length') || 0);
  if (length > maxBytes) return { ok: false, reason: 'too large' };
  const data = new Uint8Array(await res.arrayBuffer());
  if (data.byteLength > maxBytes) return { ok: false, reason: 'too large' };
  return { ok: true, data, mime: (res.headers.get('content-type') || 'application/octet-stream').split(';')[0]!.trim() };
}
