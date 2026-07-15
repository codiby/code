import type { ProjectEnvVar } from '../../tab-groups';
import { persistPrefs } from '../persist-prefs';
import type { SliceCreator } from '../types';

/** Plain, server-persisted UI preferences (the data half of the slice). */
export interface PreferencesData {
  /** Auto-place newly spawned sessions into a project group. */
  autoGroupSessions: boolean;
  /** Bring a browser preview to the front before an action-style browser_*
   *  tool runs, so the user sees it happen. */
  autoFocusBrowserOnAction: boolean;
  /** Show the Telegram bot's pseudo-session tab in the sidebar / tab bar. */
  showTelegramSession: boolean;
  /** Sending mid-turn cancels the in-flight turn instead of queueing. */
  interruptOnSend: boolean;
  /** Give each session a stable accent that tints its focus-mode pane. */
  colorChatBySession: boolean;
  /** Also wash the whole chat background with the session accent. */
  tintChatBackground: boolean;
  /** Per-session accent overrides (sessionId → hex). Absence = auto-derived. */
  sessionAccents: Record<string, string>;
  /** Global env vars layered onto every Bash tool call / user terminal. */
  globalEnvVars: ProjectEnvVar[];
}

/** The boolean toggles settable through the generic `setPreference` action. */
type TogglePrefKey =
  | 'autoGroupSessions'
  | 'autoFocusBrowserOnAction'
  | 'showTelegramSession'
  | 'interruptOnSend'
  | 'colorChatBySession'
  | 'tintChatBackground';

export interface PreferencesSlice extends PreferencesData {
  /** Set a boolean preference and persist it to the server. */
  setPreference: (key: TogglePrefKey, value: boolean) => void;
  /** Add/remove a per-session accent override (null clears it) and persist. */
  setSessionAccent: (sessionId: string, color: string | null) => void;
  /** Replace the global env-var list and persist. */
  setGlobalEnvVars: (vars: ProjectEnvVar[]) => void;
  /** Merge a server-sent `preferences` payload into local state without
   *  re-persisting (this is the server telling us its current values). */
  hydratePreferences: (prefs: Record<string, unknown>) => void;
}

export const createPreferencesSlice: SliceCreator<PreferencesSlice> = (set, get) => ({
  autoGroupSessions: false,
  autoFocusBrowserOnAction: true,
  showTelegramSession: true,
  interruptOnSend: true,
  colorChatBySession: true,
  tintChatBackground: false,
  sessionAccents: {},
  globalEnvVars: [],

  setPreference: (key, value) => {
    set({ [key]: value } as Partial<PreferencesData>);
    persistPrefs({ [key]: value });
  },

  setSessionAccent: (sessionId, color) => {
    const next = { ...get().sessionAccents };
    if (color) next[sessionId] = color; else delete next[sessionId];
    set({ sessionAccents: next });
    persistPrefs({ sessionAccents: next });
  },

  setGlobalEnvVars: (vars) => {
    set({ globalEnvVars: vars });
    persistPrefs({ globalEnvVars: vars });
  },

  hydratePreferences: (prefs) => {
    const patch: Partial<PreferencesData> = {};
    if (typeof prefs.autoGroupSessions === 'boolean') patch.autoGroupSessions = prefs.autoGroupSessions;
    if (typeof prefs.autoFocusBrowserOnAction === 'boolean') patch.autoFocusBrowserOnAction = prefs.autoFocusBrowserOnAction;
    if (typeof prefs.showTelegramSession === 'boolean') patch.showTelegramSession = prefs.showTelegramSession;
    if (typeof prefs.interruptOnSend === 'boolean') patch.interruptOnSend = prefs.interruptOnSend;
    if (typeof prefs.colorChatBySession === 'boolean') patch.colorChatBySession = prefs.colorChatBySession;
    if (typeof prefs.tintChatBackground === 'boolean') patch.tintChatBackground = prefs.tintChatBackground;
    if (prefs.sessionAccents && typeof prefs.sessionAccents === 'object') patch.sessionAccents = prefs.sessionAccents as Record<string, string>;
    if (Array.isArray(prefs.globalEnvVars)) patch.globalEnvVars = prefs.globalEnvVars as ProjectEnvVar[];
    if (Object.keys(patch).length) set(patch);
  },
});
