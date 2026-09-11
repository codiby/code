import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CODIBY_DIR } from '../config/config';

export const PEER_PROTOCOL = 1;
export type HostIdentity = { hostId: string; name: string; protocolVersion: number };

/** Stable across restarts. A corrupt identity must not silently create a new host. */
export function readHostIdentity(directory: string): HostIdentity {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'host-identity.json');
  try {
    writeFileSync(path, JSON.stringify({ hostId: `host_${randomUUID()}` }), { flag: 'wx', mode: 0o600 });
  } catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
  }
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof data.hostId !== 'string' || !/^host_[a-zA-Z0-9-]+$/.test(data.hostId)) {
    throw new Error('Invalid host-identity.json');
  }
  return { hostId: data.hostId, name: hostname(), protocolVersion: PEER_PROTOCOL };
}

let identity: HostIdentity | undefined;
export function getHostIdentity(): HostIdentity {
  return identity ??= readHostIdentity(CODIBY_DIR);
}
