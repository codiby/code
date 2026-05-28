/**
 * Compact "terminal started" card rendered inline in the chat. Replaces
 * the legacy practice of dropping the entire xterm bubble into the
 * conversation — the bubble (with the live PTY) now lives in the bottom
 * Terminals panel; the chat only shows this small announcement card.
 *
 * Layout: status dot · name · URL · mini command · [Show logs] [Stop] [×]
 *
 * Click "Show logs" → the parent makes the matching panel tab active and
 * expands the panel if it's collapsed. Click "×" persists a dismiss via
 * the existing dismissShell flow; click "Stop" kills the tracked PTY.
 */

import { useEffect, useState } from 'react';
import { ExternalLink, Square, X, Play } from 'lucide-react';
import type { ChatMessage, ClaudeClient } from '../lib/claude-client';

interface Props {
  message: ChatMessage;
  sessionId: string;
  client: ClaudeClient | null;
  /** Called when the user hits "Show logs" — parent should route the
   *  bottom panel to this terminal's tab and ensure the panel is open. */
  onShowLogs: (procId: string) => void;
  /** Called when the user hits the trash/× to drop the chip + bubble
   *  from this session permanently (BE-persisted dismiss). */
  onDismiss: (procId: string) => void;
}

export function TerminalLaunchChip({ message, sessionId, client, onShowLogs, onDismiss }: Props) {
  const procId = message.procId || message.id;
  const initialExited = !!message.terminalExited || message.terminalExitCode !== undefined || message.exitCode !== undefined;
  const [exited, setExited] = useState<boolean>(initialExited);
  const [exitCode, setExitCode] = useState<number | undefined>(
    message.terminalExitCode ?? message.exitCode,
  );
  // The action's optimistic URL ships in the message; `portless_url_resolved`
  // events later refine it to the actual proxy port (e.g. :1355). Listen
  // here so the chip's link is the one that actually works.
  const [url, setUrl] = useState<string | undefined>(message.terminalUrl);

  useEffect(() => {
    if (!client) return;
    const unsubExit = client.onTerminalExitForProc(procId, (code: number) => {
      setExited(true);
      setExitCode(code);
    });
    return () => { try { unsubExit(); } catch {} };
  }, [client, procId]);

  useEffect(() => {
    const onResolved = (e: Event) => {
      const detail = (e as CustomEvent<{ key: string; groupId: string; actionId: string; url: string }>).detail;
      if (!detail || !message.terminalUrl) return;
      // Match by hostname — the action's URL ships before portless picks
      // the actual proxy port, so the host portion is stable.
      try {
        const targetHost = new URL(detail.url).hostname;
        const ownHost = new URL(message.terminalUrl).hostname;
        if (targetHost === ownHost) setUrl(detail.url);
      } catch {}
    };
    window.addEventListener('portless_url_resolved', onResolved);
    return () => window.removeEventListener('portless_url_resolved', onResolved);
  }, [message.terminalUrl]);

  const name = message.terminalName || 'terminal';
  const command = message.terminalCommand || '';
  const running = !exited;
  const failed = exited && exitCode !== undefined && exitCode !== 0;

  const dotClass = running
    ? 'bg-emerald-400 animate-pulse'
    : failed ? 'bg-red-400'
    : 'bg-zinc-600';
  const accentClass = running
    ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
    : failed ? 'border-red-500/30 bg-red-500/10 text-red-300'
    : 'border-border bg-surface-light text-zinc-500';
  const statusLabel = running
    ? 'running'
    : failed ? `exit ${exitCode}` : 'exited';

  const stop = () => {
    if (!client || exited) return;
    try { client.killTerminal(sessionId, procId); } catch {}
  };

  return (
    <div className="rounded-lg border border-violet-500/30 bg-gradient-to-b from-violet-500/[0.06] to-violet-500/[0.02] px-3 py-2.5 flex items-center gap-3">
      {/* Leading status badge */}
      <div className={`w-7 h-7 rounded-md ${accentClass} flex items-center justify-center shrink-0 border`}>
        {running ? (
          <Play className="w-3.5 h-3.5" fill="currentColor" strokeWidth={0} />
        ) : (
          <Square className="w-3 h-3" fill="currentColor" strokeWidth={0} />
        )}
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[12.5px] font-medium text-zinc-100 truncate">
            {exited ? 'Stopped ' : 'Started '}
            <span className="font-mono text-violet-300">{name}</span>
          </span>
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider shrink-0">
            <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
            <span className={running ? 'text-emerald-400' : failed ? 'text-red-300' : 'text-zinc-500'}>
              {statusLabel}
            </span>
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 min-w-0">
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-[11.5px] font-mono text-violet-200/90 hover:text-violet-100 underline-offset-2 hover:underline truncate"
              title={url}
            >
              {url.replace(/^https?:\/\//, '')}
            </a>
          )}
          {command && (
            <span
              className="text-[10.5px] text-zinc-500 font-mono truncate"
              title={command}
            >
              {url ? '· ' : ''}{command}
            </span>
          )}
        </div>
      </div>

      {/* Trailing actions */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={() => onShowLogs(procId)}
          className="h-7 px-2.5 rounded-md text-[11px] text-white bg-violet-600 hover:bg-violet-500 inline-flex items-center gap-1.5"
          title="Open this terminal in the bottom panel"
        >
          <ExternalLink className="w-3 h-3" />
          Show logs
        </button>
        {running && (
          <button
            type="button"
            onClick={stop}
            className="h-7 w-7 rounded-md bg-surface-light hover:bg-surface-lighter border border-border text-zinc-400 hover:text-zinc-200 inline-flex items-center justify-center"
            title="Stop (SIGTERM)"
          >
            <Square className="w-3 h-3" fill="currentColor" strokeWidth={0} />
          </button>
        )}
        <button
          type="button"
          onClick={() => onDismiss(procId)}
          className="h-7 w-7 rounded-md hover:bg-red-500/10 text-zinc-500 hover:text-red-300 inline-flex items-center justify-center"
          title="Dismiss from chat (also closes the bubble)"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
