import { forwardRef } from 'react';
import { X } from 'lucide-react';
import type { MessageReply } from '../lib/message-reply';
import { MAX_NOTE } from '../lib/message-reply';

/**
 * A quoted fragment. In a sent message it shows the quote and the note the
 * user wrote about it; in the composer (`onNoteChange`) the note is editable.
 * `index` numbers it when the message carries several quotes.
 */
export const ReplyQuote = forwardRef<HTMLInputElement, {
  reply: MessageReply;
  index?: number;
  onCancel?: () => void;
  onNoteChange?: (note: string) => void;
  onNoteDone?: () => void;
  onHover?: (hovered: boolean) => void;
  onJump?: () => void;
}>(function ReplyQuote({ reply, index, onCancel, onNoteChange, onNoteDone, onHover, onJump }, noteRef) {
  return (
    <div
      className="flex items-start gap-2 rounded-lg border-l-2 border-violet-400 bg-white/5 px-3 py-2 text-left"
      data-reply-to={reply.id}
      onMouseEnter={onHover && (() => onHover(true))}
      onMouseLeave={onHover && (() => onHover(false))}
    >
      {index !== undefined && (
        <span className="mt-0.5 grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-violet-600 px-1 text-[10.5px] font-bold text-white">
          {index + 1}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium text-violet-300">{reply.role === 'user' ? 'You' : 'Codiby'}</div>
        <p
          onClick={onJump}
          title={onJump ? 'Show in the conversation' : undefined}
          className={`mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-[12px] leading-5 text-zinc-400 ${onJump ? 'cursor-pointer hover:text-violet-300' : ''}`}
        >{reply.text}</p>
        {onNoteChange ? (
          <input
            ref={noteRef}
            value={reply.note ?? ''}
            maxLength={MAX_NOTE}
            onChange={e => onNoteChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); onNoteDone?.(); }
              if (e.key === 'Escape' && !reply.note) { e.preventDefault(); e.stopPropagation(); onCancel?.(); }
            }}
            placeholder="Your comment on this part (optional)…"
            aria-label="Comment on this quote"
            className="mt-1 w-full bg-transparent text-[13px] leading-5 text-zinc-100 outline-none placeholder:text-zinc-600"
          />
        ) : reply.note ? (
          <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-5 text-zinc-100">{reply.note}</p>
        ) : null}
      </div>
      {onCancel && (
        <button type="button" onClick={onCancel} title="Remove quote" aria-label="Cancel reply"
          className="shrink-0 rounded-md p-1.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-200 focus-visible:outline focus-visible:outline-violet-400">
          <X size={14} />
        </button>
      )}
    </div>
  );
});
