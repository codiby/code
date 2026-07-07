/**
 * Tailscale helpers — used to expose the bridge server over the public
 * internet via Tailscale Funnel. We shell out to the `tailscale` CLI rather
 * than embedding tsnet, so the user's existing login + ACLs are respected.
 *
 *   tailscale status --json     → discover Self.DNSName (the funnel hostname)
 *   tailscale funnel --bg 3111  → expose localhost:3111 publicly on :443
 *   tailscale funnel reset      → tear down all funnel/serve config
 */

import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { log } from './logger';

function findTailscaleBin(): string | null {
  if (process.env.TAILSCALE_BIN && existsSync(process.env.TAILSCALE_BIN)) {
    return process.env.TAILSCALE_BIN;
  }
  const candidates = [
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/usr/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function isTailscaleAvailable(): boolean {
  return findTailscaleBin() !== null;
}

/**
 * Returns the funnel-eligible DNS name for this machine (e.g.
 * `macbook-pro.tail1234.ts.net`), or null if Tailscale isn't installed,
 * not logged in, or the daemon isn't running.
 */
export function getTailscaleHostname(): string | null {
  const bin = findTailscaleBin();
  if (!bin) return null;
  try {
    const res = spawnSync(bin, ['status', '--json'], { encoding: 'utf-8', timeout: 5000 });
    if (res.status !== 0) return null;
    const parsed = JSON.parse(res.stdout) as { Self?: { DNSName?: string } };
    const dns = parsed?.Self?.DNSName;
    if (!dns) return null;
    return dns.replace(/\.$/, '');
  } catch {
    return null;
  }
}

export type FunnelStatusInfo = {
  /** True if any funnel config exists for this machine. */
  active: boolean;
  /** Ports we currently funnel — best-effort parsed from `funnel status`. */
  ports: number[];
};

export function getFunnelStatus(): FunnelStatusInfo {
  const bin = findTailscaleBin();
  if (!bin) return { active: false, ports: [] };
  try {
    const res = spawnSync(bin, ['funnel', 'status'], { encoding: 'utf-8', timeout: 5000 });
    const out = `${res.stdout}\n${res.stderr}`;
    const ports = new Set<number>();
    // Lines look like `|-- / proxy http://localhost:3111`
    for (const m of out.matchAll(/proxy\s+https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/g)) {
      ports.add(parseInt(m[1]!, 10));
    }
    const active = /Funnel on/i.test(out) || ports.size > 0;
    return { active, ports: [...ports] };
  } catch {
    return { active: false, ports: [] };
  }
}

export type FunnelResult = { ok: true } | { ok: false; error: string };

export function enableFunnel(port: number): FunnelResult {
  const bin = findTailscaleBin();
  if (!bin) return { ok: false, error: 'Tailscale CLI not found. Install Tailscale first.' };
  try {
    const res = spawnSync(bin, ['funnel', '--bg', '--yes', String(port)], { encoding: 'utf-8', timeout: 15000 });
    if (res.status === 0) return { ok: true };
    const err = (res.stderr || res.stdout || '').trim() || `tailscale exited with code ${res.status}`;
    log(`tailscale funnel enable failed: ${err}`);
    return { ok: false, error: err };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function disableFunnel(): FunnelResult {
  const bin = findTailscaleBin();
  if (!bin) return { ok: false, error: 'Tailscale CLI not found.' };
  try {
    const res = spawnSync(bin, ['funnel', 'reset'], { encoding: 'utf-8', timeout: 10000 });
    if (res.status === 0) return { ok: true };
    const err = (res.stderr || res.stdout || '').trim() || `tailscale exited with code ${res.status}`;
    log(`tailscale funnel reset failed: ${err}`);
    return { ok: false, error: err };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
