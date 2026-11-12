import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import {
  answerApproval,
  fetchAgentStatus,
  fetchApprovals,
  sendTestPush,
  type AgentStatus,
  type PendingApproval,
} from '../api/agent';
import { useAppActive } from '../api/useAppActive';
import { useServers } from '../config/ServerConfigContext';
import {
  openNotificationSettings,
  permissionState,
  requestPermission,
  type PermissionState,
} from '../push/notifications';
import { AGENT_SESSION_ID } from '../push/payload';
import type { PushOpenRequest } from '../push/PushBridge';
import { registerWithHost } from '../push/registration';
import { usePushState, type HostPushState } from '../push/state';
import { ScreenLayout } from './ScreenLayout';

/** Permission requests that are questions for the owner, not yes/no. */
const QUESTION_TOOLS = new Set(['AskUserQuestion']);

/** Approvals block a session, so this screen polls while it's in front. */
const POLL_MS = 5_000;
const PERMISSION_ASKED_KEY = 'codiby.push.permission-asked';

interface AgentHost {
  readonly serverId: string;
  readonly serverName: string;
  readonly baseUrl: string;
  readonly token: string;
  readonly status: AgentStatus | null;
  readonly error: string | null;
  /** null = this host's bridge has no approvals route (policy not installed). */
  readonly approvals: PendingApproval[] | null;
}

export interface AgentScreenProps {
  readonly onOpenChat: (request: PushOpenRequest) => void;
}

function inMinutes(at: number | null, now: number): string | null {
  if (at === null) {
    return null;
  }
  const minutes = Math.round((at - now) / 60_000);
  return minutes <= 0 ? 'expires now' : `expires in ${minutes} min`;
}

/**
 * The Agent tab: is the agent up, what is it waiting for, and can it reach
 * this phone. Answers given here go through the same approvals endpoint the
 * desktop and the chat channels use.
 */
export function AgentScreen({ onOpenChat }: AgentScreenProps) {
  const { servers, routes } = useServers();
  const active = useAppActive();
  const push = usePushState();
  const [hosts, setHosts] = useState<Record<string, AgentHost>>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [permission, setPermission] = useState<PermissionState>('unavailable');
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const routesRef = useRef(routes);
  routesRef.current = routes;

  const live = servers
    .map(server => ({ server, route: routes[server.id] }))
    .filter(item => item.route !== undefined && item.route.baseUrl.length > 0);
  const liveKey = live
    .map(item => `${item.server.id}@${item.route!.baseUrl}`)
    .join('|');

  const refresh = useCallback(async () => {
    const targets = servers
      .map(server => ({ server, route: routesRef.current[server.id] }))
      .filter(
        item => item.route !== undefined && item.route.baseUrl.length > 0,
      );
    const results = await Promise.all(
      targets.map(async ({ server, route }): Promise<AgentHost> => {
        const base = {
          serverId: server.id,
          serverName: server.name || 'Host',
          baseUrl: route!.baseUrl,
          token: route!.token,
        };
        try {
          const status = await fetchAgentStatus(base.baseUrl, base.token);
          let approvals: PendingApproval[] | null = [];
          if (status.enabled) {
            approvals = await fetchApprovals(base.baseUrl, base.token).catch(
              () => null,
            );
          }
          return { ...base, status, error: null, approvals };
        } catch (error) {
          return {
            ...base,
            status: null,
            error: error instanceof Error ? error.message : String(error),
            approvals: null,
          };
        }
      }),
    );
    setHosts(Object.fromEntries(results.map(host => [host.serverId, host])));
    setLoaded(true);
  }, [servers]);

  useEffect(() => {
    if (!active) {
      return;
    }
    refresh().catch(() => undefined);
    const timer = setInterval(() => {
      refresh().catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, refresh, liveKey]);

  // Ask for notification permission the first time this screen is opened:
  // it's where the user learns what the notifications are for.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const current = await permissionState();
      if (
        current === 'undetermined' &&
        (await AsyncStorage.getItem(PERMISSION_ASKED_KEY)) === null
      ) {
        await AsyncStorage.setItem(PERMISSION_ASKED_KEY, String(Date.now()));
        const next = await requestPermission();
        if (!cancelled) {
          setPermission(next);
        }
        return;
      }
      if (!cancelled) {
        setPermission(current);
      }
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [active]);

  const answer = async (
    host: AgentHost,
    approval: PendingApproval,
    allow: boolean,
  ) => {
    if (busy[approval.requestId]) {
      return;
    }
    setBusy(current => ({ ...current, [approval.requestId]: true }));
    setFailure(null);
    try {
      await answerApproval(
        host.baseUrl,
        host.token,
        approval.requestId,
        allow,
        'app',
      );
      setHosts(current => {
        const entry = current[host.serverId];
        return entry === undefined
          ? current
          : {
              ...current,
              [host.serverId]: {
                ...entry,
                approvals: (entry.approvals ?? []).filter(
                  a => a.requestId !== approval.requestId,
                ),
              },
            };
      });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(current => ({ ...current, [approval.requestId]: false }));
      refresh().catch(() => undefined);
    }
  };

  const askPermission = async () => {
    // Once denied, Android and iOS only let the user change it in Settings.
    if (permission === 'denied') {
      await openNotificationSettings().catch(() => undefined);
      return;
    }
    setPermission(await requestPermission());
  };

  const register = (host: AgentHost) => {
    const server = servers.find(s => s.id === host.serverId);
    if (server === undefined || push.token === null) {
      return;
    }
    registerWithHost(
      { server, baseUrl: host.baseUrl, token: host.token },
      push.token,
    ).catch(() => undefined);
  };

  const test = async (host: AgentHost, deviceId: string) => {
    setTestResult(current => ({ ...current, [host.serverId]: 'Sending…' }));
    try {
      const result = await sendTestPush(host.baseUrl, host.token, deviceId);
      const error = result.results.find(r => !r.ok)?.error;
      setTestResult(current => ({
        ...current,
        [host.serverId]: result.ok
          ? 'Sent — it should arrive in a few seconds.'
          : `Not delivered: ${error ?? 'unknown error'}`,
      }));
    } catch (error) {
      setTestResult(current => ({
        ...current,
        [host.serverId]: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const agents = Object.values(hosts).filter(
    host => host.status?.enabled === true,
  );
  const now = Date.now();

  return (
    <ScreenLayout title="Agent">
      <Text className="mb-4 text-xs leading-5 text-slate-500">
        Your always-on agent: what it's doing, what it needs you to approve, and
        whether it can reach this phone.
      </Text>

      {failure !== null ? (
        <View className="mb-3 rounded-[16px] bg-rose-50 px-3.5 py-2.5">
          <Text className="text-[12.5px] text-rose-700">{failure}</Text>
        </View>
      ) : null}

      {!loaded && live.length > 0 ? (
        <View className="items-center py-8">
          <ActivityIndicator />
        </View>
      ) : agents.length === 0 ? (
        <View className="rounded-[20px] bg-slate-100 p-3.5">
          <Text className="text-[14.5px] font-medium tracking-[-0.3px] text-slate-900">
            {live.length === 0 ? 'No host is reachable' : 'No agent is running'}
          </Text>
          <Text className="mt-1 text-[12px] leading-[17px] text-slate-500">
            {live.length === 0
              ? 'Connect to the machine that runs your agent in Settings.'
              : 'Turn the agent on in Codiby Code → Agent, on the machine that should run it around the clock.'}
          </Text>
        </View>
      ) : (
        agents.map(host => (
          <AgentHostCard
            key={host.serverId}
            host={host}
            now={now}
            busy={busy}
            onAnswer={(approval, allow) => answer(host, approval, allow)}
            onOpenSession={sessionId =>
              onOpenChat({
                serverId: host.serverId,
                sessionId: sessionId || AGENT_SESSION_ID,
                baseUrl: host.baseUrl,
                token: host.token,
              })
            }
            onOpenChat={() =>
              onOpenChat({
                serverId: host.serverId,
                sessionId: host.status?.session?.id || AGENT_SESSION_ID,
                baseUrl: host.baseUrl,
                token: host.token,
              })
            }
          />
        ))
      )}

      <Text className="mb-2 mt-7 text-[11px] font-semibold uppercase tracking-widest text-slate-500">
        Notifications
      </Text>
      <View className="rounded-[20px] bg-slate-100 p-3.5">
        {!push.available ? (
          <>
            <Text className="text-[14.5px] font-medium tracking-[-0.3px] text-slate-900">
              Not set up in this build
            </Text>
            <Text className="mt-1 text-[12px] leading-[17px] text-slate-500">
              Push needs the Firebase config files in the app. Follow the steps
              in Codiby Code → Agent → Devices, then rebuild the app.
            </Text>
          </>
        ) : (
          <>
            <Row
              title="Allow notifications"
              detail={
                permission === 'granted'
                  ? 'Allowed'
                  : permission === 'denied'
                  ? 'Blocked — approvals and messages stay silent'
                  : 'Not asked yet'
              }
              action={
                permission === 'granted'
                  ? null
                  : permission === 'denied'
                  ? 'Settings'
                  : 'Allow'
              }
              onPress={askPermission}
            />
            {push.token === null ? (
              <Text className="mt-3 text-[12px] leading-[17px] text-slate-500">
                {push.tokenError === null
                  ? 'Getting this phone’s push address…'
                  : `No push address yet: ${push.tokenError}`}
              </Text>
            ) : null}
            {push.token === null
              ? null
              : agents.map(host => (
                  <Registration
                    key={host.serverId}
                    host={host}
                    state={push.hosts[host.serverId]}
                    result={testResult[host.serverId] ?? null}
                    onRetry={() => register(host)}
                    onTest={deviceId => test(host, deviceId)}
                  />
                ))}
          </>
        )}
      </View>
    </ScreenLayout>
  );
}

function AgentHostCard({
  host,
  now,
  busy,
  onAnswer,
  onOpenChat,
  onOpenSession,
}: {
  readonly host: AgentHost;
  readonly now: number;
  readonly busy: Record<string, boolean>;
  readonly onAnswer: (approval: PendingApproval, allow: boolean) => void;
  readonly onOpenChat: () => void;
  readonly onOpenSession: (sessionId: string) => void;
}) {
  const status = host.status!;
  const session = status.session;
  const pending = host.approvals ?? [];
  const state =
    session === null
      ? 'Not started'
      : session.pendingApproval !== null
      ? 'Waiting for your approval'
      : session.isStreaming
      ? 'Working…'
      : 'Idle';

  return (
    <View className="mb-3">
      <View className="flex-row items-center gap-3 rounded-[20px] bg-slate-100 p-3.5">
        <Text className="text-[26px]">{status.persona.emoji || '🤖'}</Text>
        <View className="flex-1">
          <Text className="text-[14.5px] font-medium tracking-[-0.3px] text-slate-900">
            {status.persona.name}
          </Text>
          <Text numberOfLines={1} className="mt-0.5 text-[12px] text-slate-500">
            {state} · {status.host || host.serverName}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${status.persona.name}'s chat`}
          onPress={onOpenChat}
          className="rounded-[15px] bg-accent px-3.5 py-1.5 active:opacity-80"
        >
          <Text className="text-[12px] font-semibold text-on-accent">
            Open chat
          </Text>
        </Pressable>
      </View>

      <Text className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-widest text-slate-500">
        Waiting for you{pending.length > 0 ? ` · ${pending.length}` : ''}
      </Text>
      {host.approvals === null ? (
        <Text className="text-[12px] text-slate-500">
          This host doesn't list approvals yet.
        </Text>
      ) : pending.length === 0 ? (
        <Text className="text-[12px] text-slate-500">
          Nothing is waiting for your approval.
        </Text>
      ) : (
        pending.map(approval => (
          <View
            key={approval.requestId}
            className="mb-2 rounded-[20px] bg-slate-100 p-3.5"
          >
            <Text className="text-[13.5px] font-semibold text-slate-900">
              {approval.title}
            </Text>
            {approval.summary.length > 0 &&
            approval.summary !== approval.title ? (
              <Text
                numberOfLines={4}
                className="mt-1 font-mono text-[12px] leading-[17px] text-slate-700"
              >
                {approval.summary}
              </Text>
            ) : null}
            <Text
              numberOfLines={1}
              className="mt-1.5 text-[11.5px] text-slate-500"
            >
              {[
                approval.sessionName,
                approval.code ? `code ${approval.code}` : null,
                inMinutes(approval.expiresAt, now),
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            {QUESTION_TOOLS.has(approval.toolName) ? (
              // A question isn't yes/no: it's answered in the session's chat.
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Answer ${approval.title} in chat`}
                onPress={() => onOpenSession(approval.sessionId)}
                className="mt-3 h-9 items-center justify-center rounded-[18px] bg-accent active:opacity-80"
              >
                <Text className="text-[12.5px] font-semibold text-on-accent">
                  Answer in chat
                </Text>
              </Pressable>
            ) : (
              <View className="mt-3 flex-row gap-2">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Deny ${approval.title}`}
                  disabled={busy[approval.requestId] === true}
                  onPress={() => onAnswer(approval, false)}
                  className="h-9 flex-1 items-center justify-center rounded-[18px] bg-white active:opacity-70"
                >
                  <Text className="text-[12.5px] font-semibold text-rose-600">
                    Deny
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Approve ${approval.title}`}
                  disabled={busy[approval.requestId] === true}
                  onPress={() => onAnswer(approval, true)}
                  className="h-9 flex-1 items-center justify-center rounded-[18px] bg-accent active:opacity-80"
                >
                  <Text className="text-[12.5px] font-semibold text-on-accent">
                    {busy[approval.requestId] === true ? 'Sending…' : 'Approve'}
                  </Text>
                </Pressable>
              </View>
            )}
          </View>
        ))
      )}
    </View>
  );
}

function Row({
  title,
  detail,
  action,
  onPress,
}: {
  readonly title: string;
  readonly detail: string;
  readonly action: string | null;
  readonly onPress: () => unknown;
}) {
  return (
    <View className="flex-row items-center gap-3">
      <View className="flex-1">
        <Text className="text-[13.5px] font-medium text-slate-900">
          {title}
        </Text>
        <Text className="text-[11.5px] text-slate-500">{detail}</Text>
      </View>
      {action === null ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${action}: ${title}`}
          onPress={onPress}
          className="rounded-[15px] bg-accent px-3.5 py-1.5 active:opacity-80"
        >
          <Text className="text-[12px] font-semibold text-on-accent">
            {action}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function Registration({
  host,
  state,
  result,
  onRetry,
  onTest,
}: {
  readonly host: AgentHost;
  readonly state: HostPushState | undefined;
  readonly result: string | null;
  readonly onRetry: () => void;
  readonly onTest: (deviceId: string) => void;
}) {
  const name = host.status?.host || host.serverName;
  const detail =
    state === undefined || state.state === 'registering'
      ? 'Registering this phone…'
      : state.state === 'registered'
      ? state.configured
        ? 'This phone gets approvals and messages'
        : `Registered, but ${name} has no Firebase key yet — add it in Codiby Code → Agent → Devices`
      : state.state === 'agent-off'
      ? 'The agent is off on this host'
      : `Couldn't register: ${state.message}`;

  return (
    <View className="mt-3 border-t border-slate-200 pt-3">
      <Row
        title={name}
        detail={detail}
        action={state?.state === 'error' ? 'Retry' : null}
        onPress={onRetry}
      />
      {state?.state === 'registered' && state.configured ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Send a test push from ${name}`}
          onPress={() => onTest(state.deviceId)}
          className="mt-2.5 h-9 items-center justify-center rounded-[18px] bg-white active:opacity-70"
        >
          <Text className="text-[12.5px] font-semibold text-slate-700">
            Send test push
          </Text>
        </Pressable>
      ) : null}
      {result !== null ? (
        <Text className="mt-1.5 text-[11.5px] text-slate-500">{result}</Text>
      ) : null}
    </View>
  );
}
