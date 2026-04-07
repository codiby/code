import { useState } from 'react';
import type { ChatMessage } from '../lib/claude-client';

interface Props {
  message: ChatMessage;
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

export function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isToolUse = !!message.toolName;

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
