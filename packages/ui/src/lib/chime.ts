/**
 * Synthesize a short two-note chime via WebAudio — no asset needed. Played
 * when Claude finishes a turn or requests permission, so the user knows to
 * look at the window. Silently no-ops in environments without AudioContext
 * (e.g. SSR prerender) and on iOS until the user has interacted with the
 * page (Safari blocks audio playback before the first gesture).
 *
 * Self-throttles to one chime per 800ms across all callers so back-to-back
 * permission prompts don't double-chime.
 */
let _lastChimeAt = 0;

export function playChime(): void {
  try {
    if (typeof window === 'undefined') return;
    const now = Date.now();
    if (now - _lastChimeAt < 800) return;
    _lastChimeAt = now;
    const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx: AudioContext = new AC();
    const t0 = ctx.currentTime;
    const tone = (freq: number, start: number, dur: number, peak = 0.18) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.start(start);
      osc.stop(start + dur + 0.04);
    };
    // Pleasant "ding-ding" — E6 then B6 (rising perfect fifth).
    tone(1318.5, t0, 0.18);
    tone(1975.5, t0 + 0.09, 0.22);
    setTimeout(() => { try { ctx.close(); } catch {} }, 700);
  } catch {/* swallow audio errors */}
}
