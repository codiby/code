import type { ChatMessage } from '../lib/claude-client';

interface Props {
  message: ChatMessage;
}

/** Renders text with inline `code`, ```code blocks```, and **bold** */
function FormattedText({ text, className }: { text: string; className?: string }) {
  const parts: (string | { type: 'code' | 'codeblock' | 'bold'; content: string; lang?: string })[] = [];
  let remaining = text;

  while (remaining.length > 0) {
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
    const nextSpecial = remaining.slice(1).search(/[`*]/);
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
        return null;
      })}
    </span>
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
    return (
      <div className="py-0.5 pl-3 ml-1 border-l-2 border-border">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-mono text-violet-400">{message.toolName}</span>
        </div>
        {message.toolInput && (
          <pre className="text-[11px] text-zinc-600 whitespace-pre-wrap break-all m-0 mt-0.5 bg-transparent p-0 max-h-24 overflow-auto leading-tight">
            {typeof message.toolInput === 'string'
              ? message.toolInput
              : JSON.stringify(message.toolInput, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  if (isUser) {
    return (
      <div className="flex justify-end py-1">
        <div className="max-w-[75%] bg-blue-600/15 rounded-2xl rounded-br-sm px-3.5 py-2">
          <div className="text-[13px] text-zinc-200 whitespace-pre-wrap break-words leading-relaxed">
            <FormattedText text={message.content} />
          </div>
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
