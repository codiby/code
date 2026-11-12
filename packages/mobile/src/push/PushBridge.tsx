/**
 * Push plumbing for the running app, rendered once inside the server
 * provider: gets the FCM token, registers it with every agent host that
 * answers, draws pushes that arrive while the app is open, and turns taps on
 * notifications into "open this session on that host".
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useServers } from '../config/ServerConfigContext';
import {
  handleNotificationEvent,
  handleRemoteMessage,
  openTargetFromRemote,
} from './handlers';
import { loadRegistrations, serverIdForHost } from './hosts';
import { firebaseMessaging, notifications } from './native';
import { ensureNotificationSetup } from './notifications';
import type { OpenTarget } from './payload';
import { registerWithHost } from './registration';
import {
  onOpenQueued,
  takePendingOpen,
  updatePushState,
  usePushState,
} from './state';

export interface PushOpenRequest {
  readonly serverId: string;
  readonly sessionId: string;
  readonly baseUrl: string;
  readonly token: string;
}

/** Retry a host whose agent was off, in case it was turned on since. */
const AGENT_OFF_RETRY_MS = 10 * 60_000;
const ERROR_RETRY_MS = 60_000;
/** Give up on a tap whose host never comes online. */
const OPEN_WAIT_MS = 20_000;

const ignore = () => undefined;

export function PushBridge({
  onOpen,
}: {
  readonly onOpen: (request: PushOpenRequest) => void;
}) {
  const { servers, routes, isLoaded } = useServers();
  const { token } = usePushState();
  const [pending, setPending] = useState<{
    serverId: string;
    sessionId: string;
    at: number;
  } | null>(null);
  /** `${serverId}:${token}` → when it may be tried again. */
  const nextAttempt = useRef(new Map<string, number>());
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  const requestOpen = useCallback((target: OpenTarget) => {
    loadRegistrations()
      .then(registrations => {
        const serverId = serverIdForHost(target.host, registrations);
        if (serverId !== null) {
          setPending({ serverId, sessionId: target.sessionId, at: Date.now() });
        }
      })
      .catch(ignore);
  }, []);

  useEffect(() => {
    const firebase = firebaseMessaging();
    const kit = notifications();
    updatePushState({ available: firebase !== null && kit !== null });
    if (firebase === null || kit === null) {
      return;
    }
    let cancelled = false;
    const { api, instance } = firebase;
    ensureNotificationSetup().catch(ignore);

    api.getToken(instance).then(
      next => {
        if (!cancelled) {
          updatePushState({ token: next, tokenError: null });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          updatePushState({
            tokenError: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    const offRefresh = api.onTokenRefresh(instance, next =>
      updatePushState({ token: next, tokenError: null }),
    );
    const offMessage = api.onMessage(instance, message => {
      handleRemoteMessage(message, { foreground: true }).catch(ignore);
    });
    const offEvent = kit.default.onForegroundEvent(event => {
      handleNotificationEvent(event)
        .then(target => target !== null && requestOpen(target))
        .catch(ignore);
    });

    // Taps that launched or resumed the app: alerts iOS drew (Firebase reports
    // those), notifications we drew (notify-kit), and background taps.
    const offOpened = api.onNotificationOpenedApp(instance, message => {
      const target = openTargetFromRemote(message);
      if (target !== null) {
        requestOpen(target);
      }
    });
    api
      .getInitialNotification(instance)
      .then(message => {
        const target = openTargetFromRemote(message);
        if (target !== null && !cancelled) {
          requestOpen(target);
        }
      })
      .catch(ignore);
    kit.default
      .getInitialNotification()
      .then(initial => {
        const target =
          initial === null ? null : openTargetFromRemote(initial.notification);
        if (target !== null && !cancelled) {
          requestOpen(target);
        }
      })
      .catch(ignore);
    const drainQueued = () => {
      const target = takePendingOpen();
      if (target !== null) {
        requestOpen(target);
      }
    };
    const offQueued = onOpenQueued(drainQueued);
    drainQueued();

    return () => {
      cancelled = true;
      offRefresh();
      offMessage();
      offEvent();
      offOpened();
      offQueued();
    };
  }, [requestOpen]);

  // Register with every host that has a live route. Cheap and idempotent on
  // the bridge (an upsert that also refreshes "last seen").
  useEffect(() => {
    if (token === null || !isLoaded) {
      return;
    }
    const now = Date.now();
    for (const server of servers) {
      const route = routes[server.id];
      if (route === undefined || route.baseUrl.length === 0) {
        continue;
      }
      const key = `${server.id}:${token}`;
      if ((nextAttempt.current.get(key) ?? 0) > now) {
        continue;
      }
      nextAttempt.current.set(key, Number.POSITIVE_INFINITY);
      registerWithHost(
        { server, baseUrl: route.baseUrl, token: route.token },
        token,
      )
        .then(result => {
          const retryIn =
            result.state === 'registered'
              ? Number.POSITIVE_INFINITY
              : result.state === 'agent-off'
              ? AGENT_OFF_RETRY_MS
              : ERROR_RETRY_MS;
          nextAttempt.current.set(key, Date.now() + retryIn);
        })
        .catch(ignore);
    }
  }, [token, servers, routes, isLoaded]);

  // A tap waits for its host's route: on a cold start the probes are still running.
  useEffect(() => {
    if (pending === null) {
      return;
    }
    const route = routes[pending.serverId];
    if (route !== undefined && route.baseUrl.length > 0) {
      setPending(null);
      onOpenRef.current({
        serverId: pending.serverId,
        sessionId: pending.sessionId,
        baseUrl: route.baseUrl,
        token: route.token,
      });
      return;
    }
    const timer = setTimeout(
      () => setPending(null),
      Math.max(0, pending.at + OPEN_WAIT_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [pending, routes]);

  return null;
}
