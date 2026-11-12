/**
 * Headless entry points, registered from index.js before the app component:
 * Android delivers data messages and notification button presses to a
 * headless task when the app isn't running, and both must exist at startup.
 */

import { firebaseMessaging, notifications } from './native';
import { handleNotificationEvent, handleRemoteMessage } from './handlers';
import { queueOpen } from './state';

let registered = false;

export function registerPushBackgroundHandlers(): void {
  if (registered) {
    return;
  }
  registered = true;

  const firebase = firebaseMessaging();
  if (firebase !== null) {
    firebase.api.setBackgroundMessageHandler(firebase.instance, message =>
      handleRemoteMessage(message, { foreground: false }).catch(
        () => undefined,
      ),
    );
  }

  const kit = notifications();
  if (kit !== null) {
    kit.default.onBackgroundEvent(async event => {
      const target = await handleNotificationEvent(event).catch(() => null);
      if (target !== null) {
        // The tap also opens the app; PushBridge picks this up once mounted.
        queueOpen(target);
      }
    });
  }
}
