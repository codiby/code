/**
 * Push state shared by PushBridge (which does the work) and the Agent screen
 * (which shows it), plus taps that arrived while no screen was listening.
 * Module-level on purpose: Android runs headless handlers in the same JS
 * runtime as the app, so a tap handled in the background reaches the UI here.
 */

import { useSyncExternalStore } from 'react';

import type { OpenTarget } from './payload';

export type HostPushState =
  | { readonly state: 'registering'; readonly at: number }
  | {
      readonly state: 'registered';
      readonly deviceId: string;
      readonly configured: boolean;
      readonly at: number;
    }
  | { readonly state: 'agent-off'; readonly at: number }
  | { readonly state: 'error'; readonly message: string; readonly at: number };

export interface PushState {
  /** Firebase and the notification module are both in this build and configured. */
  readonly available: boolean;
  readonly token: string | null;
  /** Why there is no token (no network to Google, no Play services…). */
  readonly tokenError: string | null;
  /** Registration outcome per server id. */
  readonly hosts: Readonly<Record<string, HostPushState>>;
}

let state: PushState = {
  available: false,
  token: null,
  tokenError: null,
  hosts: {},
};
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getPushState(): PushState {
  return state;
}

export function updatePushState(
  patch: Partial<Omit<PushState, 'hosts'>>,
): void {
  state = { ...state, ...patch };
  emit();
}

export function setHostPushState(serverId: string, host: HostPushState): void {
  state = { ...state, hosts: { ...state.hosts, [serverId]: host } };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePushState(): PushState {
  return useSyncExternalStore(subscribe, getPushState, getPushState);
}

// ---------------------------------------------------------------------------
// Taps waiting for the UI
// ---------------------------------------------------------------------------

/** A tap older than this is stale: the user has moved on. */
const OPEN_TTL_MS = 2 * 60_000;

let pendingOpen: { target: OpenTarget; at: number } | null = null;
const openListeners = new Set<() => void>();

export function queueOpen(target: OpenTarget, at = Date.now()): void {
  pendingOpen = { target, at };
  for (const listener of openListeners) {
    listener();
  }
}

export function takePendingOpen(now = Date.now()): OpenTarget | null {
  const pending = pendingOpen;
  pendingOpen = null;
  return pending !== null && now - pending.at <= OPEN_TTL_MS
    ? pending.target
    : null;
}

export function onOpenQueued(listener: () => void): () => void {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
}

/** Tests only. */
export function _resetPushStateForTest(): void {
  state = { available: false, token: null, tokenError: null, hosts: {} };
  pendingOpen = null;
}
