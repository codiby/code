import type { ChildProcess } from 'child_process';
import type { ProviderSession } from './provider/types';
import type { PtyHandle } from './pty';

export type Session = {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  claudeSessionId: string | null;
  browserWs: Set<any>;
  providerSession: ProviderSession | null;
  ready: boolean;
  status: 'starting' | 'running' | 'stopped';
  replayDone: boolean;
  savedCommands: string[];
  model: string | null;
  permissionMode: string;
  provider: string;
};

export type PersistedSession = {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  claudeSessionId: string | null;
  savedCommands?: string[];
  model?: string | null;
  permissionMode?: string;
  provider?: string;
};

export interface TrackedProcess {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  sessionId: string;
  startedAt: number;
  // For oneshot processes spawned with child_process.spawn this is the
  // ChildProcess; for re-adopted entries (after server restart) it's null.
  // PTY entries leave this null and use `pty` instead.
  proc: ChildProcess | null;
  viewers: Set<any>;
  outputBuffer: string[];
  exitCode: number | null;
  // Interactive PTY sessions (spawned via exec_shell):
  //   kind === 'pty' — long-lived shell driven by Bun.Terminal.
  //   kind === undefined/'oneshot' — `>` one-shot command via child_process.spawn.
  kind?: 'oneshot' | 'pty';
  cols?: number;
  rows?: number;
  // Bun-native PTY handle. Only set when kind === 'pty' and the entry was
  // spawned in *this* server lifetime (re-adopted PTY entries are killed
  // rather than restored — see restoreProcessRegistry).
  pty?: PtyHandle;
}
