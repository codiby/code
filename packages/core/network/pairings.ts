import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { CODIBY_DIR, PORT, getLanIp } from '../config/config';
import { logError } from '../lib/logger';
import { getHostIdentity } from './host-identity';
import { listRemotes, putPairedRemote, removeRemote } from './remotes';
import { acquireTunnel, releaseTunnel, disconnectTunnel } from './ssh-tunnel';
import { createPairKey, localSshHostKeys, PairAuthorizedKeys } from './pairing-keys';
import { PairingManager } from './pairing';

let bridgePort = PORT;
let notify: () => void = () => {};
let timer: ReturnType<typeof setInterval> | undefined;
const keys = new PairAuthorizedKeys(join(homedir(), '.ssh', 'authorized_keys'));
export const pairings = new PairingManager({
  directory: join(CODIBY_DIR, 'pairing'), identity: getHostIdentity, port: () => bridgePort,
  hostKeys: localSshHostKeys, createKey: createPairKey,
  grantKey: (id, key, port, expires) => keys.grant(id, key, port, expires), revokeKey: id => keys.revoke(id),
  remotes: listRemotes, putRemote: putPairedRemote, removeRemote: id => { removeRemote(id); },
  disconnect: disconnectTunnel, changed: () => notify(),
  connect: async id => {
    try {
      const { localTunnelPort } = await acquireTunnel(id);
      return { baseUrl: `http://127.0.0.1:${localTunnelPort}`, release: () => releaseTunnel(id) };
    } catch (error) { releaseTunnel(id); throw error; }
  },
});

export function pairingDefaults() {
  return { returnAlias: `${userInfo().username}@${getLanIp() || hostname()}`, sshPort: 22, permission: 'write' };
}
export function startPairingMaintenance(port: number, onChange: () => void) {
  bridgePort = port;
  notify = onChange;
  const recover = () => { void pairings.recover().catch(error => logError(`[pairing] Recovery failed: ${error.message}`)); };
  recover();
  timer = setInterval(recover, 60_000);
  timer.unref();
}
export function stopPairingMaintenance() { if (timer) clearInterval(timer); }
