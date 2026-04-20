import type { ChildProcess } from 'child_process';
import type { ProviderSession } from './provider/types';

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
  proc: ChildProcess;
  // WebSocket viewers for terminal output
  viewers: Set<any>;
  outputBuffer: string[];
  exitCode: number | null;
  // Interactive PTY sessions (spawned via exec_shell):
  //   kind === 'pty' — long-lived shell that accepts stdin via terminal_input.
  //   kind === undefined/'oneshot' — legacy `>` one-shot command.
  kind?: 'oneshot' | 'pty';
  cols?: number;
  rows?: number;
  // Writes JSON control messages ({type:'write'|'resize'|'kill', ...}) to the
  // Node pty-helper subprocess. Only set when kind === 'pty'.
  writeControl?: (obj: { type: string; [k: string]: unknown }) => void;
}
