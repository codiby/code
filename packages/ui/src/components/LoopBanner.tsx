/**
 * Loop-mode banner — sits above the composer whenever a session is looping.
 *
 * It is intentionally not dismissible. Loop is bypass permissions plus
 * unattended auto-continuation: the iteration, cost and time budgets are the
 * only thing between it and an agent editing the repo all night, so the state
 * stays on screen while it runs.
 */

import { Button } from '@heroui/react';
import { LOOP_PAUSE_LABEL, type LoopState, type RequirementProgress } from '../lib/requirements';

export type LoopBannerProps = {
  loop: LoopState;
  progress: RequirementProgress | null;
  onOpenRequirements: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
};

const TONE = {
  looping: 'border-cyan-400/35 bg-cyan-400/[0.09]',
  bootstrap: 'border-amber-400/35 bg-amber-400/[0.09]',
  paused: 'border-amber-400/35 bg-amber-400/[0.09]',
  done: 'border-emerald-400/35 bg-emerald-400/[0.09]',
} as const;

export function LoopBanner({ loop, progress, onOpenRequirements, onPause, onResume, onStop }: LoopBannerProps) {
  const passing = progress?.passing ?? 0;
  const locked = progress?.locked ?? 0;

  return (
    // Wraps rather than squeezing: the chat column gets narrow when the panel
    // workspace is open, and a clipped "Detener" is worse than a second row.
    <div className={`flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3 py-2 mb-2 rounded-lg border text-[12px] ${TONE[loop.phase]}`}>
      <span className={loop.phase === 'looping' ? 'inline-block animate-[spin_3s_linear_infinite]' : ''}>
        {loop.phase === 'done' ? '✅' : loop.phase === 'looping' ? '🔁' : '⏸'}
      </span>

      {loop.phase === 'looping' && (
        <>
          <span className="text-zinc-400">
            <b className="text-zinc-200 font-semibold">Loop</b> · iteración{' '}
            <b className="text-zinc-200 font-semibold">{loop.iteration}</b>/{loop.maxIterations}
          </span>
          <span className="text-border-light">·</span>
          <span className="text-zinc-400"><b className="text-zinc-200 font-semibold">{passing}</b>/{locked} passing</span>
          <span className="text-border-light">·</span>
          <span className="text-zinc-400">${loop.costUsd.toFixed(2)}</span>
        </>
      )}

      {loop.phase === 'bootstrap' && (
        <span className="text-zinc-400">
          <b className="text-zinc-200 font-semibold">Loop armado</b> — esperando que apruebes al menos un requerimiento.
        </span>
      )}

      {loop.phase === 'paused' && (
        <span className="text-zinc-400">
          <b className="text-zinc-200 font-semibold">Loop pausado</b>
          {loop.pauseReason ? ` — ${LOOP_PAUSE_LABEL[loop.pauseReason]}.` : '.'}
        </span>
      )}

      {loop.phase === 'done' && (
        <span className="text-zinc-400">
          <b className="text-zinc-200 font-semibold">Loop completo</b> — {passing}/{locked} passing
          {loop.iteration > 0 ? ` en ${loop.iteration} iteracion${loop.iteration === 1 ? '' : 'es'}` : ''}
          {loop.costUsd > 0 ? ` · $${loop.costUsd.toFixed(2)}` : ''}
        </span>
      )}

      <div className="flex-1" />

      <Button
        size="sm"
        className="text-[11px] h-auto px-2 py-1 rounded border border-border-light text-zinc-300 bg-surface-light hover:bg-surface-lighter"
        onPress={onOpenRequirements}
      >
        Ver requerimientos
      </Button>

      {loop.phase === 'looping' && (
        <>
          <Button
            size="sm"
            className="text-[11px] h-auto px-2 py-1 rounded border border-border-light text-zinc-300 bg-surface-light hover:bg-surface-lighter"
            onPress={onPause}
          >
            Pausar
          </Button>
          <Button
            size="sm"
            className="text-[11px] h-auto px-2 py-1 rounded border border-red-400/40 text-red-300 bg-transparent hover:bg-red-400/10"
            onPress={onStop}
          >
            Detener
          </Button>
        </>
      )}

      {(loop.phase === 'paused' || loop.phase === 'bootstrap') && (
        <>
          <Button
            size="sm"
            className="text-[11px] h-auto px-2 py-1 rounded border border-cyan-400/45 text-cyan-300 bg-transparent hover:bg-cyan-400/10"
            onPress={onResume}
          >
            Continuar loop
          </Button>
          {/* Stop clears the loop entirely — this is also what dismisses the
              banner, so a paused loop is never stuck on screen. */}
          <Button
            size="sm"
            className="text-[11px] h-auto px-2 py-1 rounded border border-red-400/40 text-red-300 bg-transparent hover:bg-red-400/10"
            onPress={onStop}
          >
            Salir de Loop
          </Button>
        </>
      )}

      {loop.phase === 'done' && (
        <Button
          size="sm"
          className="text-[11px] h-auto px-2 py-1 rounded text-zinc-400 hover:text-zinc-200 bg-transparent"
          onPress={onStop}
        >
          Cerrar
        </Button>
      )}
    </div>
  );
}
