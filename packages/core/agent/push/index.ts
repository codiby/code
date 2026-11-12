/**
 * Push (workstream 6): native push to the owner's phones through Firebase
 * Cloud Messaging (Android directly, iOS via APNs).
 *
 *   serviceAccount.ts — the Firebase key, encrypted in the vault
 *   oauth.ts          — RS256 assertion → cached, single-flight access token
 *   fcm.ts            — FCM HTTP v1 sender + error classification
 *   messages.ts       — the payload contract with packages/mobile
 *   devices.ts        — `agent_devices` (one row per registration token)
 *   sender.ts         — fan-out and what to do with each FCM answer
 *   hooks.ts          — approvals and owner notifications → pushes
 *   routes.ts         — `/agent/push/*`
 *
 * Imported for its side effects by agent/index.ts.
 */

import { installPushHooks } from './hooks';
import './routes';

installPushHooks();

export { pushToDevices, canPush } from './sender';
