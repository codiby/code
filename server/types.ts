import type { ChildProcess } from 'child_process';

export type Session = {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  claudeSessionId: string | null;
  claudeWs: WebSocket | null;
  browserWs: Set<any>;
  process: ChildProcess | null;
  ready: boolean;
  status: 'starting' | 'running' | 'stopped';
  replayDone: boolean;
  pendingMessages: string[];
  savedCommands: string[];
  model: string | null;
  permissionMode: string;
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
}
