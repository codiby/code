/**
 * The only door to the native push modules.
 *
 * A build can lack them: iOS links Firebase and the notification module only
 * once `GoogleService-Info.plist` is in place (see react-native.config.js),
 * and Android has no Firebase app until `google-services.json` exists. Every
 * caller goes through these guards, so a build without Firebase just reports
 * "push unavailable" instead of crashing at launch.
 */

import { TurboModuleRegistry } from 'react-native';

type NotifyKit = typeof import('react-native-notify-kit');
type MessagingModule = typeof import('@react-native-firebase/messaging');
type AppModule = typeof import('@react-native-firebase/app');
export type Messaging = ReturnType<MessagingModule['getMessaging']>;

let notifyKit: NotifyKit | null | undefined;

/** Looked up without throwing: `getEnforcing` is what crashes an unlinked build. */
function linked(name: string): boolean {
  return Boolean(TurboModuleRegistry.get(name));
}
let messaging: { api: MessagingModule; instance: Messaging } | null | undefined;

/** notifee-compatible API (react-native-notify-kit), or null when not linked. */
export function notifications(): NotifyKit | null {
  if (notifyKit !== undefined) {
    return notifyKit;
  }
  try {
    notifyKit = linked('NotifeeApiModule')
      ? (require('react-native-notify-kit') as NotifyKit)
      : null;
  } catch {
    notifyKit = null;
  }
  return notifyKit;
}

/** Firebase Messaging, or null when Firebase isn't linked or has no app config. */
export function firebaseMessaging(): {
  api: MessagingModule;
  instance: Messaging;
} | null {
  if (messaging !== undefined) {
    return messaging;
  }
  messaging = null;
  try {
    if (!linked('NativeRNFBTurboApp')) {
      return null;
    }
    const app = require('@react-native-firebase/app') as AppModule;
    // No google-services.json / GoogleService-Info.plist → no default app.
    if (app.getApps().length === 0) {
      return null;
    }
    const api = require('@react-native-firebase/messaging') as MessagingModule;
    messaging = { api, instance: api.getMessaging() };
  } catch {
    messaging = null;
  }
  return messaging;
}

export function isPushAvailable(): boolean {
  return notifications() !== null && firebaseMessaging() !== null;
}

/** Tests only. */
export function _resetNativeForTest(): void {
  notifyKit = undefined;
  messaging = undefined;
}
