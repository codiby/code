import type { Dispatch, SetStateAction } from 'react';
import type { SessionInfo, ConnectionStatus, SessionActivity } from '../../claude-client';
import type { LocalSessionState } from '../../session-state';
import type { SliceCreator } from '../types';
import { apply } from '../apply';

type RemoteStatus = { status: 'connecting' | 'online' | 'reconnecting' | 'offline'; lastError: string | null };

/** Core session state: the session list, the active session, the per-session
 *  server state map (the streaming target), connection/activity/remote status
 *  maps, turn-complete markers and the visible-message window.
 *
 *  Setters keep the exact `useState` signature (value or `prev => next`), so
 *  the ~544-line `onSessionState` reducer and every lifecycle handler stay in
 *  ChatApp unchanged — they just write through these store actions now, which
 *  is what lets child components read session state directly instead of via
 *  props. */
export interface SessionsSlice {
  sessions: SessionInfo[];
  activeId: string | null;
  sessionStates: Record<string, LocalSessionState>;
  statuses: Record<string, ConnectionStatus>;
  sessionActivity: Record<string, SessionActivity>;
  remoteStatuses: Record<string, RemoteStatus>;
  turnCompleteIds: Set<string>;
  visibleMessageCount: number;

  setSessions: Dispatch<SetStateAction<SessionInfo[]>>;
  setActiveId: Dispatch<SetStateAction<string | null>>;
  setSessionStates: Dispatch<SetStateAction<Record<string, LocalSessionState>>>;
  setStatuses: Dispatch<SetStateAction<Record<string, ConnectionStatus>>>;
  setSessionActivity: Dispatch<SetStateAction<Record<string, SessionActivity>>>;
  setRemoteStatuses: Dispatch<SetStateAction<Record<string, RemoteStatus>>>;
  setTurnCompleteIds: Dispatch<SetStateAction<Set<string>>>;
  setVisibleMessageCount: Dispatch<SetStateAction<number>>;
}

export const createSessionsSlice: SliceCreator<SessionsSlice> = (set) => ({
  sessions: [],
  activeId: null,
  sessionStates: {},
  statuses: {},
  sessionActivity: {},
  remoteStatuses: {},
  turnCompleteIds: new Set(),
  visibleMessageCount: 200,

  setSessions: (u) => set(s => ({ sessions: apply(s.sessions, u) })),
  setActiveId: (u) => set(s => ({ activeId: apply(s.activeId, u) })),
  setSessionStates: (u) => set(s => ({ sessionStates: apply(s.sessionStates, u) })),
  setStatuses: (u) => set(s => ({ statuses: apply(s.statuses, u) })),
  setSessionActivity: (u) => set(s => ({ sessionActivity: apply(s.sessionActivity, u) })),
  setRemoteStatuses: (u) => set(s => ({ remoteStatuses: apply(s.remoteStatuses, u) })),
  setTurnCompleteIds: (u) => set(s => ({ turnCompleteIds: apply(s.turnCompleteIds, u) })),
  setVisibleMessageCount: (u) => set(s => ({ visibleMessageCount: apply(s.visibleMessageCount, u) })),
});
