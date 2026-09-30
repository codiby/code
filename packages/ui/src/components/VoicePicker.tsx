/**
 * Voice picker for voice mode's spoken replies. The catalogue comes from the
 * provider through the bridge (`/deepgram/voices`, `/elevenlabs/voices`), so
 * it never drifts from what the TTS endpoint accepts. Every voice ships a
 * hosted sample, so "Listen" plays it without spending TTS credits.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Square } from 'lucide-react';

export interface PickerVoice {
  id: string;
  name: string;
  accent: string;
  sample: string | null;
  /** Deepgram: language code. */
  language?: string;
  /** Deepgram: descriptive tags. */
  tags?: string[];
  /** ElevenLabs: premade / cloned / generated / professional. */
  category?: string;
  gender?: string;
}

const LANGUAGE_NAMES: Record<string, string> = {
  es: 'Español', en: 'English', fr: 'Français', de: 'Deutsch',
  it: 'Italiano', nl: 'Nederlands', ja: '日本語',
};

/** Deepgram voices grouped by language, Spanish first — what voice mode is set up for. */
export const byLanguage = {
  group: (v: PickerVoice) => LANGUAGE_NAMES[v.language ?? ''] ?? (v.language || 'Other'),
  order: (v: PickerVoice) => (v.language === 'es' ? '0' : v.language === 'en' ? '1' : `2${v.language}`),
  detail: (v: PickerVoice) => (v.tags ?? []).slice(0, 4).join(', '),
};

/** ElevenLabs voices grouped by where they came from; the user's own first. */
export const byCategory = {
  // ElevenLabs refuses library voices over the API on the free plan
  // (402 payment_required), and nothing in /v1/voices says which plan you're on.
  group: (v: PickerVoice) => v.category === 'professional'
    ? 'Library — paid plan only'
    : (v.category ? v.category[0].toUpperCase() + v.category.slice(1) : 'Other'),
  order: (v: PickerVoice) => (v.category === 'premade' ? '1' : `0${v.category}`),
  detail: (v: PickerVoice) => [v.gender, v.accent].filter(Boolean).join(', '),
};

const selectCls = 'flex-1 min-w-0 bg-surface-light border border-border rounded-md text-zinc-100 text-[12.5px] px-3 py-2 focus:outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20';

interface Props {
  serverUrl: string | null;
  endpoint: '/deepgram/voices' | '/elevenlabs/voices';
  /** Bump to refetch (e.g. after saving a new API key). */
  reloadKey?: number;
  grouping: typeof byLanguage;
  value: string;
  placeholder: string;
  onChange: (id: string) => void;
}

export function VoicePicker({ serverUrl, endpoint, reloadKey, grouping, value, placeholder, onChange }: Props) {
  const [voices, setVoices] = useState<PickerVoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!serverUrl) return;
    let cancelled = false;
    setVoices(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`${serverUrl}${endpoint}`);
        const data = await res.json() as { voices?: PickerVoice[]; error?: string };
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setVoices(data.voices ?? []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [serverUrl, endpoint, reloadKey]);

  useEffect(() => () => { audioRef.current?.pause(); }, []);

  const groups = useMemo(() => {
    const map = new Map<string, { order: string; list: PickerVoice[] }>();
    for (const v of voices ?? []) {
      const key = grouping.group(v);
      const entry = map.get(key) ?? { order: grouping.order(v), list: [] };
      entry.list.push(v);
      map.set(key, entry);
    }
    return [...map.entries()].sort(([, a], [, b]) => a.order.localeCompare(b.order));
  }, [voices, grouping]);

  const selected = voices?.find((v) => v.id === value);

  const stopSample = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(false);
  };

  const toggleSample = () => {
    if (playing) { stopSample(); return; }
    if (!selected?.sample) return;
    const audio = new Audio(selected.sample);
    audio.onended = stopSample;
    audio.onerror = stopSample;
    audioRef.current = audio;
    setPlaying(true);
    void audio.play().catch(stopSample);
  };

  // No catalogue (no key yet, provider unreachable): the id can still be set
  // by hand, so the field never blocks saving.
  if (error || !voices) {
    return (
      <div className="space-y-1">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label="Voice"
          className={`${selectCls} w-full font-mono`}
        />
        <div className="text-[11px] text-zinc-500">
          {error ? `Couldn't load the voice list: ${error}` : 'Loading voices…'}
        </div>
      </div>
    );
  }

  const detail = selected ? grouping.detail(selected) : '';

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <select
          value={value}
          onChange={(e) => { stopSample(); onChange(e.target.value); }}
          aria-label="Voice"
          className={selectCls}
        >
          {/* An id the provider no longer lists (or none yet) stays visible
              instead of silently snapping to the first voice. */}
          {!selected && <option value={value}>{value || 'Choose a voice…'}</option>}
          {groups.map(([label, { list }]) => (
            <optgroup key={label} label={label}>
              {list.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}{v.accent ? ` — ${v.accent}` : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          onClick={toggleSample}
          disabled={!selected?.sample}
          className="shrink-0 inline-flex items-center gap-1.5 h-[34px] px-3 rounded-md border border-border text-[12px] text-zinc-300 hover:text-white hover:bg-white/5 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          {playing ? <Square className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          {playing ? 'Stop' : 'Listen'}
        </button>
      </div>
      {selected && (
        <div className="text-[11px] text-zinc-500">
          <code className="text-zinc-400">{selected.id}</code>
          {detail && <> · {detail}</>}
        </div>
      )}
    </div>
  );
}
