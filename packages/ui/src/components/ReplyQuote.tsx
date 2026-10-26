import { X } from 'lucide-react';
import type { MessageReply } from '../lib/message-reply';

export function ReplyQuote({ reply, onCancel }: {
  reply: MessageReply;
  onCancel?: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border-l-2 border-violet-400 bg-white/5 px-3 py-2 text-left" data-reply-to={reply.id}>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium text-violet-300">{reply.role === 'user' ? 'You' : 'Codiby'}</div>
        <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-[12px] leading-5 text-zinc-400">{reply.text}</p>
      </div>
      {onCancel && (
        <button type="button" onClick={onCancel} title="Cancel reply (Esc)" aria-label="Cancel reply"
          className="shrink-0 rounded-md p-1.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-200 focus-visible:outline focus-visible:outline-violet-400">
          <X size={14} />
        </button>
      )}
    </div>
  );
}
