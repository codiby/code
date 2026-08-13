import { useEffect, useState } from 'react';
import { Pin, PinOff, X } from 'lucide-react';
import { Button } from '@heroui/react';
import { BottomSheet } from './BottomSheet';
import type { SessionInfo } from '../../lib/claude-client';

interface Props {
  /** The long-pressed session, or null when the menu is closed. */
  session: SessionInfo | null;
  isPinned: boolean;
  /** Name of the group the session belongs to, shown as context since a
   *  pinned session is listed outside its group. */
  groupName?: string;
  onClose: () => void;
  onTogglePin: (id: string) => void;
  onCloseSession: (id: string) => void;
}

/**
 * Context menu for a session row, opened by long-pressing it on the home
 * list. Deliberately a sheet rather than a floating popover: the row can be
 * anywhere on a long list, and a bottom sheet always lands within thumb reach.
 */
export function MobileSessionMenu({ session, isPinned, groupName, onClose, onTogglePin, onCloseSession }: Props) {
  const project = session?.cwd.split('/').pop() || '';

  // The sheet slides up under a finger that's still pressing from the long
  // press, so releasing it would land a tap on whichever action ends up
  // beneath — closing a session by accident. Ignore presses until the
  // animation has settled.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!session) { setArmed(false); return; }
    const t = setTimeout(() => setArmed(true), 350);
    return () => clearTimeout(t);
  }, [session]);

  return (
    <BottomSheet open={!!session} onClose={onClose} title={session?.name} maxHeight={0.5} noSelect>
      {session && (
        <div className="select-none [-webkit-touch-callout:none]">
          <p className="text-[11px] text-zinc-500 -mt-2 mb-3 px-1 truncate">
            {groupName ? `${groupName} · ` : ''}
            <span className="font-mono">{project}</span>
          </p>

          <div className="flex flex-col gap-2" style={{ pointerEvents: armed ? 'auto' : 'none' }}>
            <Button
              variant="ghost"
              fullWidth
              onPress={() => { onTogglePin(session.id); onClose(); }}
              className="h-auto min-w-0 flex items-center gap-3 px-3 min-h-14 rounded-xl bg-white/5 border border-white/10 text-left justify-start! active:bg-white/10"
            >
              <span className="w-9 h-9 rounded-lg bg-amber-500/15 text-amber-300 flex items-center justify-center shrink-0">
                {isPinned ? <PinOff size={17} strokeWidth={2} /> : <Pin size={17} strokeWidth={2} />}
              </span>
              <span className="min-w-0 text-left">
                <span className="block text-[14px] font-medium text-zinc-100">
                  {isPinned ? 'Unpin' : 'Pin to top'}
                </span>
                <span className="block text-[11px] text-zinc-500">
                  {isPinned
                    ? 'Send it back to its group'
                    : 'Keep it above every group in the list'}
                </span>
              </span>
            </Button>

            <Button
              variant="ghost"
              fullWidth
              onPress={() => { onCloseSession(session.id); onClose(); }}
              className="h-auto min-w-0 flex items-center gap-3 px-3 min-h-14 rounded-xl bg-white/5 border border-white/10 text-left justify-start! active:bg-white/10"
            >
              <span className="w-9 h-9 rounded-lg bg-red-500/15 text-red-300 flex items-center justify-center shrink-0">
                <X size={17} strokeWidth={2.25} />
              </span>
              <span className="min-w-0 text-left">
                <span className="block text-[14px] font-medium text-zinc-100">Close session</span>
                <span className="block text-[11px] text-zinc-500">Stops the agent, keeps the history</span>
              </span>
            </Button>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}
