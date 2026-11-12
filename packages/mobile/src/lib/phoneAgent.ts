import { NativeModules, PermissionsAndroid, Platform } from 'react-native';

/** What Settings → Phone access shows. Mirrors `PhoneAgentModule.status`. */
export interface PhoneAgentStatus {
  readonly enabled: boolean;
  readonly allowAct: boolean;
  readonly allowNotifications: boolean;
  readonly askEveryAction: boolean;
  /** The accessibility service is on in Android settings. */
  readonly accessibility: boolean;
  readonly notificationAccess: boolean;
  /** Notifications allowed: needed for the "agents can use this phone" status. */
  readonly postNotifications: boolean;
  readonly linkedHosts: string[];
  readonly sdk: number;
}

export type PhoneAgentOptions = Partial<
  Pick<PhoneAgentStatus, 'enabled' | 'allowAct' | 'allowNotifications' | 'askEveryAction'>
>;

export interface PhoneAgentLogEntry {
  readonly t: number;
  readonly host: string;
  readonly session: string;
  readonly command: string;
  readonly summary: string;
  readonly outcome: string;
}

interface NativePhoneAgent {
  status(): Promise<PhoneAgentStatus>;
  setOptions(options: PhoneAgentOptions): Promise<void>;
  openAccessibilitySettings(): Promise<void>;
  openNotificationAccessSettings(): Promise<void>;
  openAppDetails(): Promise<void>;
  log(): Promise<string>;
  clearLog(): Promise<void>;
}

function native(): NativePhoneAgent | undefined {
  return Platform.OS === 'android'
    ? (NativeModules.PhoneAgent as NativePhoneAgent | undefined)
    : undefined;
}

/** Only the Android build carries the service; iOS has no equivalent. */
export function isPhoneAgentAvailable(): boolean {
  return native() !== undefined;
}

export async function phoneAgentStatus(): Promise<PhoneAgentStatus | null> {
  return (await native()?.status()) ?? null;
}

export async function setPhoneAgentOptions(options: PhoneAgentOptions): Promise<void> {
  await native()?.setOptions(options);
}

export async function openAccessibilitySettings(): Promise<void> {
  await native()?.openAccessibilitySettings();
}

export async function openNotificationAccessSettings(): Promise<void> {
  await native()?.openNotificationAccessSettings();
}

export async function openAppDetails(): Promise<void> {
  await native()?.openAppDetails();
}

/** Android 13+ asks at runtime; older versions grant it with the install. */
export async function requestNotificationPermission(sdk: number): Promise<boolean> {
  if (sdk < 33) {
    return true;
  }
  const result = await PermissionsAndroid.request(
    'android.permission.POST_NOTIFICATIONS' as never,
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

/** Newest first. A corrupt log reads as empty rather than breaking Settings. */
export function parsePhoneAgentLog(raw: string): PhoneAgentLogEntry[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(
        (entry): entry is PhoneAgentLogEntry =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as PhoneAgentLogEntry).t === 'number',
      )
      .reverse();
  } catch {
    return [];
  }
}

export async function phoneAgentLog(): Promise<PhoneAgentLogEntry[]> {
  const raw = await native()?.log();
  return raw ? parsePhoneAgentLog(raw) : [];
}

export async function clearPhoneAgentLog(): Promise<void> {
  await native()?.clearLog();
}
