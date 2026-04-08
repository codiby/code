import { useState, useMemo, useRef } from 'react';
import type { ChatMessage } from '../lib/claude-client';

interface Props {
  message: ChatMessage;
  onOpenTerminal?: (msgId: string) => void;
}

function parseTableRows(raw: string): { headers: string[]; rows: string[][] } | null {
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length < 2) return null;
  const parse = (line: string) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  const headers = parse(lines[0]!);
  // Second line must be separator (dashes)
  if (!/^[\s|:-]+$/.test(lines[1]!)) return null;
  const rows = lines.slice(2).map(parse);
  return { headers, rows };
}

/** Renders text with inline `code`, ```code blocks```, **bold**, and tables */
function FormattedText({ text, className }: { text: string; className?: string }) {
  type Part = string | { type: 'code' | 'codeblock' | 'bold' | 'table'; content: string; lang?: string };
  const parts: Part[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Markdown table: lines starting with |
    const tableMatch = remaining.match(/^(\|[^\n]+\|\n)(\|[-:\s|]+\|\n)((?:\|[^\n]+\|\n?)+)/);
    if (tableMatch) {
      parts.push({ type: 'table', content: tableMatch[0] });
      remaining = remaining.slice(tableMatch[0].length);
      continue;
    }

    // Code block: ```lang\n...\n```
    const blockMatch = remaining.match(/^```(\w*)\n([\s\S]*?)```/);
    if (blockMatch) {
      parts.push({ type: 'codeblock', content: blockMatch[2]!, lang: blockMatch[1] });
      remaining = remaining.slice(blockMatch[0].length);
      continue;
    }

    // Inline code: `...`
    const inlineMatch = remaining.match(/^`([^`\n]+)`/);
    if (inlineMatch) {
      parts.push({ type: 'code', content: inlineMatch[1]! });
      remaining = remaining.slice(inlineMatch[0].length);
      continue;
    }

    // Bold: **...**
    const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
    if (boldMatch) {
      parts.push({ type: 'bold', content: boldMatch[1]! });
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Plain text until next special char
    const nextSpecial = remaining.slice(1).search(/[`*|]/);
    if (nextSpecial === -1) {
      parts.push(remaining);
      break;
    }
    parts.push(remaining.slice(0, nextSpecial + 1));
    remaining = remaining.slice(nextSpecial + 1);
  }

  return (
    <span className={className}>
      {parts.map((part, i) => {
        if (typeof part === 'string') {
          return <span key={i}>{part}</span>;
        }
        if (part.type === 'code') {
          return (
            <code key={i} className="bg-blue-950/60 text-amber-300/90 text-[12px] px-1.5 py-0.5 rounded font-mono border border-blue-900/30">
              {part.content}
            </code>
          );
        }
        if (part.type === 'codeblock') {
          return (
            <pre key={i} className="bg-blue-950/40 border border-blue-900/30 rounded-md px-3 py-2 my-1.5 text-[12px] font-mono text-zinc-300 overflow-x-auto leading-snug">
              <code>{part.content}</code>
            </pre>
          );
        }
        if (part.type === 'bold') {
          return <strong key={i} className="text-zinc-100 font-semibold">{part.content}</strong>;
        }
        if (part.type === 'table') {
          const table = parseTableRows(part.content);
          if (!table) return <span key={i}>{part.content}</span>;
          return (
            <div key={i} className="my-2 overflow-x-auto rounded border border-border-light">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="bg-surface-light">
                    {table.headers.map((h, j) => (
                      <th key={j} className="px-3 py-1.5 text-left font-medium text-zinc-200 border-b border-border-light whitespace-nowrap"><FormattedText text={h} /></th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, ri) => (
                    <tr key={ri} className="border-b border-border last:border-0 hover:bg-surface-light/30">
                      {row.map((cell, ci) => (
                        <td key={ci} className="px-3 py-1 text-zinc-400 whitespace-nowrap"><FormattedText text={cell} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return null;
      })}
    </span>
  );
}

function toolSummary(message: ChatMessage): string {
  const input = message.toolInput;
  if (!input) return '';
  if (typeof input === 'string') return input.slice(0, 80);
  // Common tool patterns
  if (input.command) return String(input.command).slice(0, 80);
  if (input.file_path) return String(input.file_path);
  if (input.path) return String(input.path);
  if (input.pattern) return String(input.pattern).slice(0, 60);
  if (input.query) return String(input.query).slice(0, 60);
  if (input.url) return String(input.url).slice(0, 80);
  const json = JSON.stringify(input);
  return json.length > 80 ? json.slice(0, 77) + '...' : json;
}

function ToolBubble({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const summary = toolSummary(message);

  return (
    <div
      className="py-0.5 pl-3 ml-1 border-l-2 border-border cursor-pointer select-none"
      onClick={() => setExpanded(e => !e)}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-zinc-600">{expanded ? '▾' : '▸'}</span>
        <span className="text-[11px] font-mono text-violet-400">{message.toolName}</span>
        {!expanded && summary && (
          <span className="text-[11px] text-zinc-600 font-mono truncate max-w-md">{summary}</span>
        )}
      </div>
      {expanded && message.toolInput && (
        <pre className="text-[11px] text-zinc-600 whitespace-pre-wrap break-all m-0 mt-0.5 bg-transparent p-0 max-h-24 overflow-auto leading-tight">
          {typeof message.toolInput === 'string'
            ? message.toolInput
            : JSON.stringify(message.toolInput, null, 2)}
        </pre>
      )}
    </div>
  );
}

const ANSI_COLORS: Record<number, string> = {
  30: '#6b7280', 31: '#ef4444', 32: '#22c55e', 33: '#eab308', 34: '#3b82f6',
  35: '#a855f7', 36: '#06b6d4', 37: '#d4d4d8', 39: '',
  90: '#71717a', 91: '#f87171', 92: '#4ade80', 93: '#facc15', 94: '#60a5fa',
  95: '#c084fc', 96: '#22d3ee', 97: '#f4f4f5',
};

export function AnsiText({ text }: { text: string }) {
  const parts = useMemo(() => {
    const result: { text: string; color?: string; bold?: boolean; dim?: boolean }[] = [];
    // eslint-disable-next-line no-control-regex
    const re = /\x1b\[([0-9;]*)m/g;
    let lastIndex = 0;
    let color: string | undefined;
    let bold = false;
    let dim = false;

    let match;
    while ((match = re.exec(text)) !== null) {
      if (match.index > lastIndex) {
        result.push({ text: text.slice(lastIndex, match.index), color, bold, dim });
      }
      const codes = match[1]!.split(';').map(Number);
      for (const code of codes) {
        if (code === 0) { color = undefined; bold = false; dim = false; }
        else if (code === 1) bold = true;
        else if (code === 2) dim = true;
        else if (code === 22) { bold = false; dim = false; }
        else if (ANSI_COLORS[code] !== undefined) color = ANSI_COLORS[code] || undefined;
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      result.push({ text: text.slice(lastIndex), color, bold, dim });
    }
    return result;
  }, [text]);

  return (
    <>
      {parts.map((p, i) => (
        <span
          key={i}
          style={{
            color: p.color,
            fontWeight: p.bold ? 700 : undefined,
            opacity: p.dim ? 0.6 : undefined,
          }}
        >
          {p.text}
        </span>
      ))}
    </>
  );
}

function openTerminalWindow(command: string, content: string, exitCode?: number) {
  const running = exitCode === undefined;
  // Strip ANSI for plain text, but keep for the HTML version
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>$ ${command}</title>
<style>
  body { margin: 0; background: #1b1b1b; color: #a1a1aa; font-family: 'SF Mono','Fira Code',monospace; font-size: 13px; }
  .header { padding: 8px 12px; background: #2a2a2a; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 8px; position: sticky; top: 0; }
  .cmd { color: #e4e4e7; }
  .status { font-size: 11px; }
  .ok { color: #4ade80; } .fail { color: #f87171; } .run { color: #fbbf24; }
  pre { margin: 0; padding: 12px; white-space: pre-wrap; word-break: break-all; line-height: 1.5; }
</style></head><body>
<div class="header"><span style="color:#71717a;font-size:11px">$</span><span class="cmd">${command.replace(/</g, '&lt;')}</span>
${running ? '<span class="status run">running...</span>' : exitCode === 0 ? '<span class="status ok">exit 0</span>' : `<span class="status fail">exit ${exitCode}</span>`}
</div><pre>${content.replace(/</g, '&lt;')}</pre></body></html>`;
  const win = window.open('', '_blank', 'width=800,height=600');
  if (win) { win.document.write(html); win.document.close(); }
}

function TerminalBubble({ message, onOpenInPanel }: { message: ChatMessage; onOpenInPanel?: (msgId: string) => void }) {
  const running = message.exitCode === undefined;
  const [collapsed, setCollapsed] = useState(!running && message.content.length > 0);

  // Auto-collapse when done
  const prevRunning = useRef(running);
  if (prevRunning.current && !running) {
    prevRunning.current = false;
  }

  return (
    <div className="py-1">
      <div className="rounded-lg border border-border-light overflow-hidden">
        <div
          className="flex items-center gap-2 px-3 py-1.5 bg-surface-light border-b border-border-light cursor-pointer select-none"
          onClick={() => setCollapsed(c => !c)}
        >
          <span className="text-[10px] text-zinc-500 w-3 text-center shrink-0">{collapsed ? '▸' : '▾'}</span>
          <span className="text-[10px] text-zinc-500">$</span>
          <span className="text-[12px] font-mono text-zinc-200 flex-1 truncate">{message.terminalCommand}</span>
          {running && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />}
          {!running && message.exitCode === 0 && <span className="text-[10px] text-green-400 shrink-0">exit 0</span>}
          {!running && message.exitCode !== 0 && <span className="text-[10px] text-red-400 shrink-0">exit {message.exitCode}</span>}
          {onOpenInPanel && (
            <button
              className="text-zinc-600 hover:text-zinc-300 text-[11px] shrink-0 px-1"
              onClick={(e) => { e.stopPropagation(); onOpenInPanel(message.id); }}
              title="Open in panel"
            >
              &#x2197;
            </button>
          )}
        </div>
        {!collapsed && (
          <>
            {message.content && (
              <pre className="px-3 py-2 text-[12px] font-mono text-zinc-400 whitespace-pre-wrap break-all leading-snug max-h-64 overflow-auto m-0 bg-transparent">
                <AnsiText text={message.content} />
                {running && <span className="inline-block w-1.5 h-3 bg-zinc-500/60 animate-pulse ml-0.5 align-text-bottom" />}
              </pre>
            )}
            {!message.content && running && (
              <div className="px-3 py-2 text-[11px] text-zinc-600">Running...</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function MessageBubble({ message, onOpenTerminal }: Props) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isToolUse = !!message.toolName;

  if (message.isTerminal) {
    return <TerminalBubble message={message} onOpenInPanel={onOpenTerminal} />;
  }

  if (isSystem) {
    return (
      <div className="flex items-center gap-2 py-1.5 px-2">
        <div className="h-px flex-1 bg-surface" />
        <span className="text-[11px] text-zinc-600 shrink-0">{message.content}</span>
        {message.costUsd != null && (
          <span className="text-[11px] text-zinc-600">${message.costUsd.toFixed(4)}</span>
        )}
        {message.durationMs != null && (
          <span className="text-[11px] text-zinc-600">{(message.durationMs / 1000).toFixed(1)}s</span>
        )}
        {message.usage && (
          <span className="text-[11px] text-zinc-600">
            {message.usage.input_tokens + message.usage.output_tokens} tok
          </span>
        )}
        <div className="h-px flex-1 bg-surface" />
      </div>
    );
  }

  if (isToolUse) {
    return <ToolBubble message={message} />;
  }

  if (isUser) {
    return (
      <div className="flex justify-end py-1">
        <div className="max-w-[75%] bg-blue-600/15 rounded-2xl rounded-br-sm px-3.5 py-2">
          {message.images && message.images.length > 0 && (
            <div className="flex gap-1.5 flex-wrap mb-1.5">
              {message.images.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.media_type};base64,${img.data}`}
                  alt=""
                  className="max-h-40 rounded border border-blue-900/30 object-cover"
                />
              ))}
            </div>
          )}
          {message.content && (
            <div className="text-[13px] text-zinc-200 whitespace-pre-wrap break-words leading-relaxed">
              <FormattedText text={message.content} />
            </div>
          )}
        </div>
      </div>
    );
  }

  // Assistant
  return (
    <div className="py-1">
      <div className="text-[13px] text-zinc-300 whitespace-pre-wrap break-words leading-relaxed">
        <FormattedText text={message.content} />
      </div>
    </div>
  );
}
