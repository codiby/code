/**
 * Drawing and removing notifications (react-native-notify-kit, the
 * maintained notifee fork). A request's notification id is its `requestId`:
 * on iOS that is also the identifier of the alert the system drew from the
 * push (the bridge sets it as `apns-collapse-id`), so one cancel removes
 * either.
 */

import { Platform } from 'react-native';

import { notifications } from './native';
import {
  ACTION_APPROVE,
  ACTION_DENY,
  APPROVAL_CATEGORY,
  CHANNELS,
  toNotificationData,
  type ApprovalPush,
  type NotifyPush,
} from './payload';

/** Monochrome status-bar icon (android/app/src/main/res/drawable). */
const SMALL_ICON = 'ic_notification';

export type PermissionState =
  | 'granted'
  | 'denied'
  | 'undetermined'
  | 'unavailable';

let setup: Promise<void> | null = null;

/** Channels (Android) and the approval category (iOS). Idempotent. */
export function ensureNotificationSetup(): Promise<void> {
  const kit = notifications();
  if (kit === null) {
    return Promise.resolve();
  }
  if (setup !== null) {
    return setup;
  }
  const { default: notifee, AndroidImportance, AndroidVisibility } = kit;
  setup = (async () => {
    if (Platform.OS === 'android') {
      await notifee.createChannels([
        {
          id: CHANNELS.approvals,
          name: 'Approvals',
          description: 'An agent is waiting for you to allow or deny something',
          importance: AndroidImportance.HIGH,
          // The buttons approve things: keep them off a locked screen.
          visibility: AndroidVisibility.PRIVATE,
          sound: 'default',
          vibration: true,
        },
        {
          id: CHANNELS.messages,
          name: 'Agent messages',
          description: 'Messages and reminders from your agent',
          importance: AndroidImportance.DEFAULT,
          visibility: AndroidVisibility.PRIVATE,
          sound: 'default',
        },
        {
          id: CHANNELS.quiet,
          name: 'Quiet hours',
          description: 'Agent messages that arrive during your quiet hours',
          importance: AndroidImportance.LOW,
          visibility: AndroidVisibility.PRIVATE,
        },
      ]);
    } else {
      await notifee.setNotificationCategories([
        {
          id: APPROVAL_CATEGORY,
          actions: [
            {
              id: ACTION_APPROVE,
              title: 'Approve',
              authenticationRequired: true,
            },
            {
              id: ACTION_DENY,
              title: 'Deny',
              destructive: true,
              authenticationRequired: true,
            },
          ],
        },
      ]);
    }
  })().catch(error => {
    setup = null;
    throw error;
  });
  return setup;
}

export async function displayApproval(
  push: ApprovalPush,
  now = Date.now(),
): Promise<void> {
  const kit = notifications();
  if (kit === null) {
    return;
  }
  await ensureNotificationSetup();
  const {
    default: notifee,
    AndroidStyle,
    AndroidVisibility,
    AndroidCategory,
  } = kit;
  const remaining = push.expiresAt === null ? null : push.expiresAt - now;
  if (remaining !== null && remaining <= 0) {
    return;
  }
  await notifee.displayNotification({
    id: push.requestId,
    title: push.title,
    body: push.body,
    data: toNotificationData(push),
    android: {
      channelId: CHANNELS.approvals,
      smallIcon: SMALL_ICON,
      category: AndroidCategory.REMINDER,
      visibility: AndroidVisibility.PRIVATE,
      style: { type: AndroidStyle.BIGTEXT, text: push.body },
      pressAction: { id: 'default', launchActivity: 'default' },
      // No launchActivity: the answer is sent from the background, the app
      // stays closed. A question has no yes/no; tapping opens its chat.
      ...(push.question
        ? {}
        : {
            actions: [
              { title: 'Approve', pressAction: { id: ACTION_APPROVE } },
              { title: 'Deny', pressAction: { id: ACTION_DENY } },
            ],
          }),
      autoCancel: false,
      ...(remaining !== null ? { timeoutAfter: remaining } : {}),
    },
    ios: {
      ...(push.question ? {} : { categoryId: APPROVAL_CATEGORY }),
      interruptionLevel: 'timeSensitive',
      sound: 'default',
      threadId: 'approvals',
      foregroundPresentationOptions: { banner: true, list: true, sound: true },
    },
  });
}

export async function displayNotify(push: NotifyPush): Promise<void> {
  const kit = notifications();
  if (kit === null) {
    return;
  }
  await ensureNotificationSetup();
  const { default: notifee, AndroidStyle } = kit;
  await notifee.displayNotification({
    title: push.title,
    body: push.body,
    data: toNotificationData(push),
    android: {
      channelId: push.channel,
      smallIcon: SMALL_ICON,
      style: { type: AndroidStyle.BIGTEXT, text: push.body },
      pressAction: { id: 'default', launchActivity: 'default' },
    },
    ios: {
      threadId: 'messages',
      ...(push.quiet
        ? { interruptionLevel: 'passive' as const }
        : { sound: 'default' }),
      foregroundPresentationOptions: {
        banner: true,
        list: true,
        sound: !push.quiet,
      },
    },
  });
}

export async function cancelNotification(id: string): Promise<void> {
  const kit = notifications();
  if (kit === null) {
    return;
  }
  await kit.default.cancelNotification(id);
}

/** Replaces an approval's notification when the answer could not be sent. */
export async function displayAnswerProblem(
  push: Pick<ApprovalPush, 'requestId' | 'title'> & {
    data: Record<string, string>;
  },
  reason: string,
): Promise<void> {
  const kit = notifications();
  if (kit === null) {
    return;
  }
  await ensureNotificationSetup();
  await kit.default.displayNotification({
    id: push.requestId,
    title: "Your answer wasn't sent",
    body: `${reason} Open Codiby to answer "${push.title}".`,
    data: push.data,
    android: {
      channelId: CHANNELS.approvals,
      smallIcon: SMALL_ICON,
      pressAction: { id: 'default', launchActivity: 'default' },
    },
    ios: { threadId: 'approvals' },
  });
}

export async function permissionState(): Promise<PermissionState> {
  const kit = notifications();
  if (kit === null) {
    return 'unavailable';
  }
  try {
    const settings = await kit.default.getNotificationSettings();
    return toPermission(kit, settings.authorizationStatus);
  } catch {
    return 'unavailable';
  }
}

/** Android 13+ POST_NOTIFICATIONS, iOS alert/sound/badge. */
export async function requestPermission(): Promise<PermissionState> {
  const kit = notifications();
  if (kit === null) {
    return 'unavailable';
  }
  try {
    const settings = await kit.default.requestPermission({
      alert: true,
      sound: true,
      badge: true,
    });
    return toPermission(kit, settings.authorizationStatus);
  } catch {
    return 'unavailable';
  }
}

export async function openNotificationSettings(): Promise<void> {
  await notifications()?.default.openNotificationSettings();
}

function toPermission(
  kit: NonNullable<ReturnType<typeof notifications>>,
  status: number,
): PermissionState {
  const { AuthorizationStatus } = kit;
  if (
    status === AuthorizationStatus.AUTHORIZED ||
    status === AuthorizationStatus.PROVISIONAL
  ) {
    return 'granted';
  }
  if (status === AuthorizationStatus.DENIED) {
    return 'denied';
  }
  return 'undetermined';
}

/** Tests only. */
export function _resetNotificationSetupForTest(): void {
  setup = null;
}
