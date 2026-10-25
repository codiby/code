import React from 'react';
import { act, create } from 'react-test-renderer';

import type { Frame } from '../src/api/SocketProvider';
import { useSessionSocket } from '../src/api/useSessionSocket';

type Listener = (serverId: string, frame: Frame) => void;

const mockListeners = new Set<Listener>();
const mockSockets = {
  subscribe: jest.fn(),
  addListener: (listener: Listener) => {
    mockListeners.add(listener);
    return () => mockListeners.delete(listener);
  },
  send: jest.fn(() => true),
  statusOf: () => 'open',
  isLive: () => true,
};

jest.mock('../src/api/SocketProvider', () => ({
  RECONNECTED: '__reconnected',
  useSockets: () => mockSockets,
}));

function emit(frame: Frame) {
  act(() => {
    for (const listener of mockListeners) {
      listener('srv', frame);
    }
  });
}

function Probe({ onStatus }: { onStatus: (status: string) => void }) {
  useSessionSocket({
    serverId: 'srv',
    sessionId: 's1',
    onMessage: jest.fn(),
    onStatus,
    onPartialText: jest.fn(),
    onPartialThinking: jest.fn(),
  });
  return null;
}

describe('useSessionSocket', () => {
  afterEach(() => mockListeners.clear());

  it('apaga el turno si el snapshot de la resuscripción dice que ya no corre', () => {
    const onStatus = jest.fn();
    act(() => {
      create(<Probe onStatus={onStatus} />);
    });

    emit({ type: 'status', sessionId: 's1', status: 'streaming' });
    // El `turn_complete` se perdió con el socket congelado; al volver a
    // primer plano solo llega el `session_state` de la resuscripción.
    emit({ type: 'session_state', sessionId: 's1', state: { isStreaming: false } });

    expect(onStatus.mock.calls.map(([status]) => status)).toEqual([
      'streaming',
      'idle',
    ]);
  });

  it('no inventa un estado si el snapshot no trae isStreaming', () => {
    const onStatus = jest.fn();
    act(() => {
      create(<Probe onStatus={onStatus} />);
    });

    emit({ type: 'session_state', sessionId: 's1', state: {} });

    expect(onStatus).not.toHaveBeenCalled();
  });
});
