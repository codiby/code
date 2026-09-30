/**
 * Mic toggle for voice mode: talk to the session and hear its replies.
 * Everything past the mic lives on the bridge (see lib/voice-session.ts).
 */

import { useEffect, useRef, useState } from 'react';
import { AudioLines, Loader2, Mic } from 'lucide-react';
import type { ClaudeClient } from '../lib/claude-client';
import { VoiceSession, type VoiceState } from '../lib/voice-session';
import { tryInvokeNative } from '../lib/native';

interface Props {
  client: ClaudeClient | null;
  sessionId: string;
}

export function VoiceModeButton({ client, sessionId }: Props) {
  const [state, setState] = useState<VoiceState>('closed');
  const [transcript, setTranscript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<VoiceSession | null>(null);
  /** Session whose floating bubble voice mode brought up, to take back down. */
  const floatedRef = useRef<string | null>(null);

  /** Only a bubble voice mode added goes away with it; one the user floated
   *  themselves stays put. */
  const releaseBubble = () => {
    const sid = floatedRef.current;
    floatedRef.current = null;
    if (sid) void tryInvokeNative('bubble_unfloat', { sessionId: sid });
  };

  const stop = () => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setTranscript(null);
    releaseBubble();
  };

  // Switching tabs or unmounting ends the conversation: the mic must never
  // keep streaming into a session the user can't see.
  useEffect(() => stop, [sessionId]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  const start = async () => {
    if (!client) return;
    setError(null);
    try {
      const voice = new VoiceSession(await client.voiceSocketUrl(sessionId), {
        onState: (s) => {
          setState(s);
          // The socket can drop on its own (Deepgram closed, bridge restart).
          if (s === 'closed') releaseBubble();
        },
        onTranscript: setTranscript,
        onError: setError,
      });
      sessionRef.current = voice;
      await voice.start();
      // Float the session while voice mode runs, so its state stays in view
      // from any app. Outside Electron there are no bubbles and this no-ops.
      const floating = await tryInvokeNative<string[]>('bubble_list');
      if (floating && !floating.includes(sessionId) && sessionRef.current === voice) {
        await tryInvokeNative('bubble_float', { sessionId });
        floatedRef.current = sessionId;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      stop();
    }
  };

  const onPress = () => {
    if (state === 'closed') void start();
    else if (state === 'speaking') sessionRef.current?.interrupt();
    else stop();
  };

  const active = state !== 'closed';
  const label = state === 'closed' ? 'Start voice mode'
    : state === 'speaking' ? 'Stop the reply'
    : 'End voice mode';

  return (
    <div className="relative flex items-center">
      {(transcript || error) && (
        <div
          className={`absolute bottom-full right-0 mb-2 max-w-[320px] w-max rounded-lg px-2.5 py-1.5 text-[12px] leading-snug shadow-lg ${
            error ? 'bg-red-950/90 text-red-200' : 'bg-surface-light text-zinc-200'
          }`}
        >
          {error ?? transcript}
        </div>
      )}
      <button
        type="button"
        onClick={onPress}
        onContextMenu={(e) => { if (active) { e.preventDefault(); stop(); } }}
        aria-label={label}
        title={active ? `${label} (right-click to end)` : label}
        className={`rounded-full w-[30px] h-[30px] flex items-center justify-center transition-colors ${
          state === 'listening' ? 'bg-red-500/90 text-white animate-pulse'
          : state === 'speaking' ? 'bg-cyan-500/90 text-white'
          : state === 'connecting' ? 'bg-white/10 text-zinc-300'
          : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5'
        }`}
      >
        {state === 'connecting' ? <Loader2 className="w-4 h-4 animate-spin" />
          : state === 'speaking' ? <AudioLines className="w-4 h-4" />
          : <Mic className="w-4 h-4" />}
      </button>
    </div>
  );
}
