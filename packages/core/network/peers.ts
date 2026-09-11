import { join } from 'node:path';
import { CODIBY_DIR } from '../config/config';
import { getHostIdentity } from './host-identity';
import { listRemotes, pinRemoteHost } from './remotes';
import { acquireTunnel, releaseTunnel } from './ssh-tunnel';
import { PeerClient } from './peer-client';
import { pairings } from './pairings';
import { PeerReceipts } from './peer-protocol';

export const peerReceipts = new PeerReceipts(join(CODIBY_DIR, 'peer-receipts'));
export const peers = new PeerClient({
  identity: getHostIdentity,
  remotes: listRemotes,
  pin: pinRemoteHost,
  credentials: id => pairings.credentials(id),
  connect: async remoteId => {
    try {
      const { localTunnelPort } = await acquireTunnel(remoteId);
      return { baseUrl: `http://127.0.0.1:${localTunnelPort}`, release: () => releaseTunnel(remoteId) };
    } catch (error) {
      releaseTunnel(remoteId);
      throw error;
    }
  },
});
