/**
 * Lines the bridge logs once it's listening. They land in server.log and the
 * launchd/Electron stdout capture, which are readable without the owner's
 * credentials, so nothing here may carry a secret: the mobile bearer token
 * is shown only as a mask, and pairing happens through the Settings QR code.
 */

export const MASKED_TOKEN = '••••';

export type StartupInfo = {
  scheme: 'http' | 'https';
  port: number;
  host: string;
  tls: boolean;
  claudeBin: string;
  cwd: string;
  spawnMode: string;
  /** First LAN IPv4, or null / 127.0.0.1 when there is none. */
  lanIp: string | null;
};

export function mobileUrlLogLine(scheme: string, lanIp: string | null, port: number): string {
  if (!lanIp || lanIp === '127.0.0.1') return 'Mobile URL: (no LAN IP detected — connect to a WiFi network)';
  return `Mobile URL: ${scheme}://${lanIp}:${port}/m#t=${MASKED_TOKEN} (open Settings → Mobile Pairing to pair)`;
}

export function startupLogLines(info: StartupInfo): string[] {
  return [
    `Bridge server listening on ${info.scheme}://localhost:${info.port} (host=${info.host}, tls=${info.tls})`,
    `Swagger docs: ${info.scheme}://localhost:${info.port}/docs`,
    `Claude binary: ${info.claudeBin}`,
    `Working directory: ${info.cwd}`,
    `Spawn mode: ${info.spawnMode}`,
    mobileUrlLogLine(info.scheme, info.lanIp, info.port),
  ];
}
