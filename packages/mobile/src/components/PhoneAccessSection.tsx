import { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, Switch, Text, View } from 'react-native';

import {
  clearPhoneAgentLog,
  isPhoneAgentAvailable,
  openAccessibilitySettings,
  openAppDetails,
  openNotificationAccessSettings,
  phoneAgentLog,
  phoneAgentStatus,
  requestNotificationPermission,
  setPhoneAgentOptions,
  type PhoneAgentLogEntry,
  type PhoneAgentOptions,
  type PhoneAgentStatus,
} from '../lib/phoneAgent';
import { useInk } from '../theme';

/** Re-read while the section is on screen: links come and go on their own. */
const POLL_MS = 4000;
const LOG_ROWS = 8;

function time(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Settings → Phone access. The service itself is turned on in Android
 * settings; here the user sees what is missing, sets what agents may do, and
 * checks what they did.
 */
export function PhoneAccessSection() {
  const ink = useInk();
  const [status, setStatus] = useState<PhoneAgentStatus | null>(null);
  const [log, setLog] = useState<PhoneAgentLogEntry[]>([]);

  const refresh = useCallback(() => {
    phoneAgentStatus()
      .then(setStatus)
      .catch(() => undefined);
    phoneAgentLog()
      .then(setLog)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    // Coming back from Android settings is when a permission just changed.
    const sub = AppState.addEventListener('change', next => {
      if (next === 'active') {
        refresh();
      }
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [refresh]);

  if (!isPhoneAgentAvailable() || status === null) {
    return null;
  }

  const set = (options: PhoneAgentOptions) => {
    setStatus(current => (current ? { ...current, ...options } : current));
    setPhoneAgentOptions(options).then(refresh, refresh);
  };

  const toggleEnabled = async (enabled: boolean) => {
    set({ enabled });
    if (enabled && !status.postNotifications) {
      await requestNotificationPermission(status.sdk).catch(() => false);
      refresh();
    }
  };

  const track = { false: ink('#d9dce1'), true: ink('#0b7d5c') };
  const thumb = ink('#ffffff');

  const linked = status.linkedHosts;
  const summary = !status.enabled
    ? 'Off'
    : !status.accessibility
    ? 'Waiting for the accessibility service'
    : linked.length > 0
    ? `Linked to ${linked.join(', ')}`
    : 'Connecting to your hosts…';

  return (
    <View>
      <Text className="mb-2 mt-7 text-[11px] font-semibold uppercase tracking-widest text-slate-500">
        Phone access
      </Text>

      <View className="rounded-[20px] bg-slate-100 p-3.5">
        <View className="flex-row items-center gap-3">
          <View className="flex-1">
            <Text className="text-[14.5px] font-medium tracking-[-0.3px] text-slate-900">
              Let agents use this phone
            </Text>
            <Text
              className={`mt-0.5 text-[12px] ${
                status.enabled && linked.length > 0 ? 'text-accent' : 'text-slate-500'
              }`}
            >
              {summary}
            </Text>
          </View>
          <Switch
            accessibilityLabel="Let agents use this phone"
            value={status.enabled}
            onValueChange={toggleEnabled}
            trackColor={track}
            thumbColor={thumb}
          />
        </View>

        {status.enabled ? (
          <>
            <View className="mt-3 h-px bg-slate-200" />
            <Step
              done={status.accessibility}
              title="Accessibility service"
              detail="Reads the screen and acts on it"
              action="Turn on"
              onPress={openAccessibilitySettings}
            />
            {!status.accessibility && status.sdk >= 33 ? (
              <View className="ml-[34px] mt-1">
                <Text className="text-[12px] leading-[17px] text-slate-500">
                  If Android says the setting is restricted, open App info, tap ⋮
                  and choose “Allow restricted settings”, then try again.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={openAppDetails}
                  className="mt-1.5 self-start rounded-[15px] bg-white px-3 py-1.5 active:opacity-70"
                >
                  <Text className="text-[12px] font-semibold text-accent">App info</Text>
                </Pressable>
              </View>
            ) : null}
            <Step
              done={status.notificationAccess}
              title="Notification access"
              detail="Reads notifications and answers them"
              action="Grant"
              onPress={openNotificationAccessSettings}
            />
            <Step
              done={status.postNotifications}
              title="Status notification"
              detail="Shows when agents can use the phone"
              action="Allow"
              onPress={() =>
                requestNotificationPermission(status.sdk).then(refresh, refresh)
              }
            />

            <View className="mt-3 h-px bg-slate-200" />
            <Toggle
              title="Tap, type and open apps"
              value={status.allowAct}
              onChange={allowAct => set({ allowAct })}
              track={track}
              thumb={thumb}
            />
            <Toggle
              title="Read and reply to notifications"
              value={status.allowNotifications}
              onChange={allowNotifications => set({ allowNotifications })}
              track={track}
              thumb={thumb}
            />
            <Toggle
              title="Ask before every action"
              value={status.askEveryAction}
              onChange={askEveryAction => set({ askEveryAction })}
              track={track}
              thumb={thumb}
            />
            <Text className="mt-2 text-[12px] leading-[17px] text-slate-500">
              Sending, paying, buying, deleting or confirming anything, and any
              change in system settings, always waits for you to approve it on
              screen. Agents can't touch Codiby Code itself.
            </Text>
          </>
        ) : null}
      </View>

      {log.length > 0 ? (
        <>
          <View className="mb-2 mt-5 flex-row items-center justify-between">
            <Text className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">
              Recent agent activity
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear agent activity"
              onPress={() => clearPhoneAgentLog().then(refresh, refresh)}
              hitSlop={8}
            >
              <Text className="text-[12px] font-semibold text-accent">Clear</Text>
            </Pressable>
          </View>
          <View className="rounded-[20px] bg-slate-100 px-3.5 py-1">
            {log.slice(0, LOG_ROWS).map((entry, index) => (
              <View
                key={`${entry.t}-${index}`}
                className={`py-2.5 ${index > 0 ? 'border-t border-slate-200' : ''}`}
              >
                <View className="flex-row items-center justify-between gap-2">
                  <Text
                    numberOfLines={1}
                    className="flex-1 text-[13.5px] font-medium text-slate-900"
                  >
                    {entry.summary}
                  </Text>
                  <Text
                    className={`text-[11px] ${
                      entry.outcome === 'done'
                        ? 'text-slate-400'
                        : entry.outcome === 'declined'
                        ? 'text-amber-700'
                        : 'text-rose-600'
                    }`}
                  >
                    {entry.outcome === 'done' ? time(entry.t) : entry.outcome.split(':')[0]}
                  </Text>
                </View>
                <Text numberOfLines={1} className="mt-0.5 text-[11.5px] text-slate-500">
                  {entry.session} · {entry.host}
                </Text>
              </View>
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

function Step({
  done,
  title,
  detail,
  action,
  onPress,
}: {
  readonly done: boolean;
  readonly title: string;
  readonly detail: string;
  readonly action: string;
  readonly onPress: () => unknown;
}) {
  return (
    <View className="mt-3 flex-row items-center gap-2.5">
      <View
        className={`h-6 w-6 items-center justify-center rounded-full ${
          done ? 'bg-accent' : 'bg-white'
        }`}
      >
        <Text className={`text-[12px] font-bold ${done ? 'text-on-accent' : 'text-slate-400'}`}>
          {done ? '✓' : '·'}
        </Text>
      </View>
      <View className="flex-1">
        <Text className="text-[13.5px] font-medium text-slate-900">{title}</Text>
        <Text className="text-[11.5px] text-slate-500">{detail}</Text>
      </View>
      {done ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${action}: ${title}`}
          onPress={onPress}
          className="rounded-[15px] bg-accent px-3.5 py-1.5 active:opacity-80"
        >
          <Text className="text-[12px] font-semibold text-on-accent">{action}</Text>
        </Pressable>
      )}
    </View>
  );
}

function Toggle({
  title,
  value,
  onChange,
  track,
  thumb,
}: {
  readonly title: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
  readonly track: { false: string; true: string };
  readonly thumb: string;
}) {
  return (
    <View className="mt-2 flex-row items-center justify-between gap-3">
      <Text className="flex-1 text-[13.5px] text-slate-900">{title}</Text>
      <Switch
        accessibilityLabel={title}
        value={value}
        onValueChange={onChange}
        trackColor={track}
        thumbColor={thumb}
      />
    </View>
  );
}
