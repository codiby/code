/**
 * Suggests the public base URL by reading this host's Tailscale Funnel
 * config — the usual way a home server becomes reachable over https for
 * Google's redirect. Read-only: it never changes the Funnel.
 */

import { googleDeps } from './deps';

export interface BaseUrlSuggestion {
  url: string | null;
  detail: string;
}

const LOOPBACK_PROXY = /^\s*\|--\s+(\/\S*)\s+proxy\s+https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)\/?\s*$/;
const FUNNEL_ORIGIN = /^(https:\/\/[^\s/]+)\/?\s+\(Funnel on\)/;

/**
 * Public https bases that proxy to `port`, parsed from `tailscale funnel status`:
 *
 *   https://host.tailnet.ts.net:10000 (Funnel on)
 *   |-- / proxy http://127.0.0.1:3111
 *
 * Mounts that proxy to a sub-path of the backend are skipped: the bridge's
 * routes live at its root, so only `… proxy http://127.0.0.1:<port>` works.
 */
export function parseFunnelBases(output: string, port: number): string[] {
  const out: string[] = [];
  let origin: string | null = null;
  for (const line of output.split('\n')) {
    const o = line.match(FUNNEL_ORIGIN);
    if (o) { origin = o[1]!; continue; }
    // Any other header line (a "(tailnet only)" origin, comments) ends the current funnel block.
    if (/^[^\s|]/.test(line)) { origin = null; continue; }
    const p = line.match(LOOPBACK_PROXY);
    if (p && origin && Number(p[2]) === port) {
      const mount = p[1] === '/' ? '' : p[1]!.replace(/\/+$/, '');
      out.push(`${origin}${mount}`);
    }
  }
  return [...new Set(out)];
}

export async function suggestPublicBaseUrl(port: number): Promise<BaseUrlSuggestion> {
  const bin = googleDeps().tailscaleBin();
  if (!bin) return { url: null, detail: 'Tailscale is not installed on this host. Enter the https URL this bridge is reachable at.' };
  let res;
  try {
    res = await googleDeps().run([bin, 'funnel', 'status'], 5_000);
  } catch {
    return { url: null, detail: "Couldn't run tailscale on this host." };
  }
  const bases = parseFunnelBases(`${res.stdout}\n${res.stderr}`, port);
  if (bases.length) {
    return { url: bases[0]!, detail: `Tailscale Funnel exposes this bridge (port ${port}) at ${bases[0]}.` };
  }
  return {
    url: null,
    detail: `Tailscale Funnel isn't exposing this bridge (port ${port}). On this host run: tailscale funnel --bg ${port} — or enter another https URL that reaches it.`,
  };
}
