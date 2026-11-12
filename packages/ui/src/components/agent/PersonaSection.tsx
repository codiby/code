/**
 * Agent view → Persona: who the agent is (name, language, timezone, style),
 * who it serves (the owner's verified accounts), where it works and which
 * model it runs. Saved with PUT /agent/config.
 *
 * Also exports `ListInput`, the chip editor the Memory tab's people cards use.
 */

import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Check, RotateCcw, X } from 'lucide-react';
import { agentCore, type AgentConfig } from '../../lib/agent/api';
import {
  isValidEmail,
  isValidTelegramChatId,
  isValidTimeZone,
  listTimeZones,
  localTimeZone,
  normalizeWhatsAppInput,
} from '../../lib/agent/memory';
import { Button, Card, ErrorNote, Field, INPUT_CLASS, LABEL_CLASS, Section, Spinner, usePolled, type AgentSectionProps } from './ui';

const PROVIDER_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };

// ---------------------------------------------------------------------------
// ListInput — chips + a text box; Enter, comma or leaving the box commits
// ---------------------------------------------------------------------------

export function ListInput({ values, onChange, normalize, invalidMessage, placeholder, label, onPendingChange }: {
  values: string[];
  onChange: (next: string[]) => void;
  /** Canonical form of one entry, or null when it isn't valid. */
  normalize: (raw: string) => string | null;
  invalidMessage: string;
  placeholder?: string;
  label: string;
  /** True while the box holds text that hasn't become a chip (so forms can hold off saving). */
  onPendingChange?: (pending: boolean) => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { onPendingChange?.(text.trim().length > 0); }, [text, onPendingChange]);

  const commit = (): boolean => {
    const parts = text.split(/[,\n;]+/).map(s => s.trim()).filter(Boolean);
    if (!parts.length) { setText(''); return true; }
    const next = [...values];
    const bad: string[] = [];
    for (const p of parts) {
      const v = normalize(p);
      if (!v) bad.push(p);
      else if (!next.includes(v)) next.push(v);
    }
    if (next.length !== values.length) onChange(next);
    setText(bad.join(', '));
    setError(bad.length ? `${invalidMessage}: ${bad.join(', ')}` : null);
    return bad.length === 0;
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && !text && values.length) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div>
      {/* Spelled out rather than INPUT_CLASS + overrides (two padding utilities
          don't reliably resolve by class order). focus-within: the real input
          inside has no outline, so the box shows keyboard focus. */}
      <div className="w-full bg-base border border-border rounded-md px-2 py-[3px] min-h-[30px] flex flex-wrap items-center gap-1 focus-within:border-indigo-400/50">
        {values.map(v => (
          <span key={v} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded bg-surface-light border border-border text-[11.5px] text-zinc-300 max-w-full">
            <span className="truncate">{v}</span>
            <button
              type="button"
              aria-label={`Remove ${v}`}
              onClick={() => onChange(values.filter(x => x !== v))}
              className="text-zinc-500 hover:text-zinc-200 shrink-0"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          aria-label={label}
          value={text}
          onChange={e => { setText(e.target.value); if (error) setError(null); }}
          onKeyDown={onKey}
          onBlur={() => { commit(); }}
          placeholder={values.length ? '' : placeholder}
          className="flex-1 min-w-[140px] bg-transparent text-[12px] leading-[18px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none px-0.5 py-px"
        />
      </div>
      {error && <span className="block text-[11px] text-amber-300 mt-1">{error}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Persona form
// ---------------------------------------------------------------------------

interface Draft {
  name: string;
  emoji: string;
  language: string;
  timezone: string;
  style: string;
  ownerName: string;
  telegramChatIds: string[];
  whatsappJids: string[];
  emails: string[];
  workspaceDir: string;
  model: string;
}

function toDraft(c: AgentConfig): Draft {
  return {
    name: c.persona.name,
    emoji: c.persona.emoji,
    language: c.persona.language,
    timezone: c.persona.timezone,
    style: c.persona.style,
    ownerName: c.owner.name,
    telegramChatIds: c.owner.telegramChatIds,
    whatsappJids: c.owner.whatsappJids,
    emails: c.owner.emails,
    workspaceDir: c.workspaceDir,
    model: c.model ?? '',
  };
}

const LANGUAGES: { value: string; label: string }[] = [
  { value: '', label: 'Mirror the owner (reply in their language)' },
  { value: 'es-MX', label: 'Spanish (Mexico)' },
  { value: 'es', label: 'Spanish' },
  { value: 'en', label: 'English' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
];
const OTHER = '__other__';

/** BCP-47-ish: "es", "es-MX", "zh-Hant-TW". */
const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const normalizeChatId = (s: string) => (isValidTelegramChatId(s) ? s.trim() : null);
const normalizeEmail = (s: string) => (isValidEmail(s) ? s.trim().toLowerCase() : null);

function nowIn(tz: string): string | null {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date());
  } catch {
    return null;
  }
}

export function PersonaSection({ api, refreshKey }: AgentSectionProps) {
  const cfg = usePolled(() => agentCore.config(api), [api, refreshKey]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [customLanguage, setCustomLanguage] = useState(false);

  useEffect(() => {
    if (cfg.data) {
      setDraft(toDraft(cfg.data));
      setCustomLanguage(!LANGUAGES.some(l => l.value === cfg.data!.persona.language));
    }
  }, [cfg.data]);

  const zones = useMemo(() => listTimeZones(), []);
  const pendingSetters = useMemo(() => ({
    telegram: (p: boolean) => setPending(s => (s.telegram === p ? s : { ...s, telegram: p })),
    whatsapp: (p: boolean) => setPending(s => (s.whatsapp === p ? s : { ...s, whatsapp: p })),
    email: (p: boolean) => setPending(s => (s.email === p ? s : { ...s, email: p })),
  }), []);

  if (cfg.loading && !cfg.data) return <Spinner />;
  if (cfg.error && !cfg.data) return <ErrorNote message={`Couldn't load the agent's settings: ${cfg.error}`} onRetry={() => void cfg.reload()} />;
  if (!draft || !cfg.data) return <Spinner />;

  const original = toDraft(cfg.data);
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft(d => (d ? { ...d, [key]: value } : d));
    setSavedAt(null);
  };

  const problems: string[] = [];
  if (!draft.name.trim()) problems.push('The agent needs a name.');
  if (!isValidTimeZone(draft.timezone)) problems.push('Pick a valid timezone (e.g. America/Mazatlan).');
  if (draft.language && !LANGUAGE_TAG.test(draft.language)) problems.push('Language must be a code like "es" or "es-MX", or blank to mirror the owner.');
  if (Object.values(pending).some(Boolean)) problems.push('Finish or clear the entry you are typing in the owner lists.');

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await agentCore.saveConfig(api, {
        persona: { name: draft.name.trim(), emoji: draft.emoji.trim(), language: draft.language.trim(), timezone: draft.timezone.trim(), style: draft.style.trim() },
        owner: { name: draft.ownerName.trim(), telegramChatIds: draft.telegramChatIds, whatsappJids: draft.whatsappJids, emails: draft.emails },
        workspaceDir: draft.workspaceDir.trim(),
        model: draft.model.trim() || null,
      });
      cfg.setData(next);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const tzNow = isValidTimeZone(draft.timezone) ? nowIn(draft.timezone) : null;
  const languageChoice = customLanguage ? OTHER : draft.language;

  return (
    <>
      <Section title="Persona" hint="How the agent introduces itself and talks to you.">
        <Card>
          <div className="grid grid-cols-[1fr_96px] gap-3">
            <Field label="Name">
              <input className={INPUT_CLASS} value={draft.name} maxLength={60} onChange={e => set('name', e.target.value)} placeholder="Codiby" />
            </Field>
            <Field label="Emoji">
              <input className={`${INPUT_CLASS} text-center`} value={draft.emoji} maxLength={8} onChange={e => set('emoji', e.target.value)} placeholder="🤖" />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Language" hint={draft.language ? undefined : 'Replies in whatever language you write in.'}>
              <select
                className={INPUT_CLASS}
                value={languageChoice}
                onChange={e => {
                  if (e.target.value === OTHER) { setCustomLanguage(true); return; }
                  setCustomLanguage(false);
                  set('language', e.target.value);
                }}
              >
                {LANGUAGES.map(l => <option key={l.value || 'mirror'} value={l.value}>{l.label}</option>)}
                <option value={OTHER}>Other…</option>
              </select>
              {customLanguage && (
                <input
                  className={`${INPUT_CLASS} mt-1.5`}
                  aria-label="Language code"
                  value={draft.language}
                  onChange={e => set('language', e.target.value)}
                  placeholder="Language code, e.g. ja or nl-BE"
                />
              )}
            </Field>
            <Field label="Timezone" hint={tzNow ? `It's ${tzNow} there. Reminders, quiet hours and the daily fresh start use it.` : 'An IANA zone such as America/Mazatlan.'}>
              <div className="flex gap-1.5">
                <input
                  className={`${INPUT_CLASS} ${isValidTimeZone(draft.timezone) ? '' : 'border-amber-500/50'}`}
                  list="agent-timezones"
                  value={draft.timezone}
                  onChange={e => set('timezone', e.target.value)}
                  placeholder="America/Mazatlan"
                  spellCheck={false}
                />
                <Button title={`Use this computer's timezone (${localTimeZone()})`} onClick={() => set('timezone', localTimeZone())}>Local</Button>
              </div>
              <datalist id="agent-timezones">
                {zones.map(z => <option key={z} value={z} />)}
              </datalist>
            </Field>
          </div>

          <Field label="Style" hint="Tone and habits, in your words — e.g. “Brief and warm. Use emoji sparingly. Always confirm before sending emails.”">
            <textarea className={`${INPUT_CLASS} min-h-[72px] resize-y`} value={draft.style} maxLength={2000} onChange={e => set('style', e.target.value)} />
          </Field>
        </Card>
      </Section>

      <Section title="Owner" hint="Only these accounts can give the agent orders. Messages from anyone else are stored as untrusted and never followed.">
        <Card>
          <Field label="Your name">
            <input className={INPUT_CLASS} value={draft.ownerName} maxLength={80} onChange={e => set('ownerName', e.target.value)} placeholder="How the agent should call you" />
          </Field>
          <div className="mb-3">
            <span className={LABEL_CLASS}>Telegram chat ids</span>
            <ListInput
              label="Add a Telegram chat id"
              values={draft.telegramChatIds}
              onChange={v => set('telegramChatIds', v)}
              normalize={normalizeChatId}
              invalidMessage="Telegram chat ids are numbers"
              placeholder="123456789"
              onPendingChange={pendingSetters.telegram}
            />
          </div>
          <div className="mb-3">
            <span className={LABEL_CLASS}>WhatsApp</span>
            <ListInput
              label="Add a WhatsApp number or JID"
              values={draft.whatsappJids}
              onChange={v => set('whatsappJids', v)}
              normalize={normalizeWhatsAppInput}
              invalidMessage="Not a phone number or WhatsApp JID"
              placeholder="Phone number (667 780 5604) or JID"
              onPendingChange={pendingSetters.whatsapp}
            />
            <span className="block text-[11px] text-zinc-500 mt-1">Phone numbers become JIDs; 10-digit numbers are taken as Mexican (52 1 …).</span>
          </div>
          <div>
            <span className={LABEL_CLASS}>Emails</span>
            <ListInput
              label="Add an email address"
              values={draft.emails}
              onChange={v => set('emails', v)}
              normalize={normalizeEmail}
              invalidMessage="Not an email address"
              placeholder="you@example.com"
              onPendingChange={pendingSetters.email}
            />
          </div>
        </Card>
      </Section>

      <Section title="Workspace and model">
        <Card>
          <Field label="Workspace folder" hint="Where the agent keeps its notes, downloads and scratch files on this host. Blank uses the default.">
            <input className={`${INPUT_CLASS} font-mono`} value={draft.workspaceDir} onChange={e => set('workspaceDir', e.target.value)} placeholder="~/agent" spellCheck={false} />
          </Field>
          <Field label="Model" hint={`Provider: ${PROVIDER_LABELS[cfg.data.provider] ?? cfg.data.provider}. Blank uses the provider's default model.`}>
            <input className={`${INPUT_CLASS} font-mono`} value={draft.model} onChange={e => set('model', e.target.value)} placeholder="Default" spellCheck={false} />
          </Field>
        </Card>
      </Section>

      {problems.length > 0 && dirty && (
        <div className="mb-3 flex flex-col gap-1">
          {problems.map(p => <ErrorNote key={p} message={p} />)}
        </div>
      )}
      {error && <div className="mb-3"><ErrorNote message={error} /></div>}

      <div className="flex items-center gap-2">
        <Button tone="primary" onClick={() => void save()} disabled={!dirty || saving || problems.length > 0}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button onClick={() => { setDraft(original); setCustomLanguage(!LANGUAGES.some(l => l.value === original.language)); setError(null); }} disabled={!dirty || saving}>
          <RotateCcw size={12} /> Revert
        </Button>
        {savedAt && !dirty && <span className="text-[11.5px] text-green-400 inline-flex items-center gap-1"><Check size={12} /> Saved</span>}
        <span className="text-[11px] text-zinc-500 ml-auto">Persona, language and model apply from the agent's next fresh thread or restart.</span>
      </div>
    </>
  );
}
