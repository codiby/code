/**
 * HTTP handlers backing the mobile companion UI.
 *
 *   GET  /mobile/pair               → { url, token, lanIp, port, funnelUrl? }
 *   POST /mobile/pair/regenerate    → { url, token, lanIp, port, funnelUrl? } (new token)
 *   POST /mobile/notify-test        → { ok: true } + fires a Telegram alert
 *
 * The `/mobile/pair*` routes are intentionally restricted to localhost so
 * only the desktop user can read/rotate the token; the mobile client never
 * needs these — it receives the token via the QR code fragment.
 */

import { corsHeaders, getLanIp, loadOrCreateMobileToken, regenerateMobileToken, PORT, resolveTls } from '../config/config';
import { notify } from '../integrations/notify';
import { loadTailscaleSettings } from '../session/storage';
import { getTailscaleHostname } from '../network/tailscale';

function pairResponse(token: string) {
  const lanIp = getLanIp();
  const scheme = resolveTls() ? 'https' : 'http';
  const url = `${scheme}://${lanIp}:${PORT}/m#t=${token}`;

  let funnelUrl: string | undefined;
  let funnelHostname: string | undefined;
  try {
    if (loadTailscaleSettings().funnelEnabled) {
      const host = getTailscaleHostname();
      if (host) {
        funnelHostname = host;
        funnelUrl = `https://${host}/m#t=${token}`;
      }
    }
  } catch {}

  return { url, token, lanIp, port: PORT, funnelUrl, funnelHostname };
}

export async function handleMobilePair(): Promise<Response> {
  const token = loadOrCreateMobileToken();
  return Response.json(pairResponse(token), { headers: corsHeaders });
}

export async function handleMobilePairRegenerate(): Promise<Response> {
  const token = regenerateMobileToken();
  return Response.json(pairResponse(token), { headers: corsHeaders });
}

export async function handleMobileNotifyTest(req: Request): Promise<Response> {
  let message: string | undefined;
  try {
    const body = await req.json() as { message?: string };
    message = body?.message;
  } catch {}
  await notify({ type: 'test', message });
  return Response.json({ ok: true }, { headers: corsHeaders });
}
