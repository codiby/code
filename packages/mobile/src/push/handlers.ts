/**
 * What to do with a push and with a tap on its notification. Shared by the
 * foreground listeners (PushBridge) and the headless handlers in index.js, so
 * an approval behaves the same whether the app is open or closed.
 */

import { Platform } from 'react-native';

import { answerApproval, isUnreachable } from '../api/agent';
import { candidateUrls, serverForHost } from './hosts';
import {
  cancelNotification,
  displayAnswerProblem,
  displayApproval,
  displayNotify,
} from './notifications';
import { notifications } from './native';
import {
  ACTION_APPROVE,
  ACTION_DENY,
  openTargetOf,
  parsePushData,
  toNotificationData,
  type ApprovalPush,
  type OpenTarget,
} from './payload';

export interface RemoteMessageLike {
  readonly data?: Record<string, unknown>;
}

export async function handleRemoteMessage(
  message: RemoteMessageLike,
  opts: { foreground: boolean },
): Promise<void> {
  const push = parsePushData(message.data);
  if (push === null) {
    return;
  }
  if (push.type === 'approval_resolved') {
    await cancelNotification(push.requestId);
    return;
  }
  // iOS draws the alert from the APNs payload itself unless the app is in
  // front; drawing it again here would show it twice.
  if (Platform.OS === 'ios' && !opts.foreground) {
    return;
  }
  if (push.type === 'approval') {
    await displayApproval(push);
  } else {
    await displayNotify(push);
  }
}

/**
 * Send the owner's answer to the host that asked. Tries each of the server's
 * routes, but only moves on when a route didn't answer — a host that
 * answered "already resolved" means stop.
 */
export async function answerFromNotification(
  push: ApprovalPush,
  allow: boolean,
): Promise<boolean> {
  const server = await serverForHost(push.host);
  const data = toNotificationData(push);
  if (server === null) {
    await displayAnswerProblem(
      { requestId: push.requestId, title: push.title, data },
      'This phone does not know that host.',
    );
    return false;
  }
  const urls = await candidateUrls(server);
  let reason = 'The host has no address set in the app.';
  for (const url of urls) {
    try {
      await answerApproval(url, server.token, push.requestId, allow, 'push');
      await cancelNotification(push.requestId);
      return true;
    } catch (error) {
      reason =
        error instanceof Error ? `${error.message}.` : 'Something went wrong.';
      if (!isUnreachable(error)) {
        break;
      }
    }
  }
  await displayAnswerProblem(
    { requestId: push.requestId, title: push.title, data },
    reason,
  );
  return false;
}

export interface NotificationEventLike {
  readonly type: number;
  readonly detail: {
    readonly notification?: {
      readonly id?: string;
      readonly data?: Record<string, unknown>;
    };
    readonly pressAction?: { readonly id: string };
  };
}

/**
 * A notification event from notify-kit. Returns where to navigate for a
 * plain tap; action buttons are handled here and return null.
 */
export async function handleNotificationEvent(
  event: NotificationEventLike,
): Promise<OpenTarget | null> {
  const kit = notifications();
  if (kit === null) {
    return null;
  }
  const push = parsePushData(event.detail.notification?.data);
  if (push === null) {
    return null;
  }
  const { EventType } = kit;
  if (
    event.type === EventType.ACTION_PRESS &&
    push.type === 'approval' &&
    !push.question
  ) {
    const action = event.detail.pressAction?.id;
    if (action === ACTION_APPROVE || action === ACTION_DENY) {
      await answerFromNotification(push, action === ACTION_APPROVE);
    }
    return null;
  }
  if (event.type === EventType.PRESS) {
    return openTargetOf(push);
  }
  return null;
}

/** For taps on alerts iOS drew itself (Firebase reports those, not notify-kit). */
export function openTargetFromRemote(
  message: RemoteMessageLike | null | undefined,
): OpenTarget | null {
  const push = parsePushData(message?.data);
  return push === null ? null : openTargetOf(push);
}
