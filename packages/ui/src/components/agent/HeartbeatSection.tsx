/**
 * Agent view → Heartbeat & reminders (workstream 2, proactivity): the
 * periodic check-in, the morning brief, quiet hours and the reminder list.
 *
 * The heartbeat and the brief are managed automations on the agent's host;
 * this screen edits their settings (heartbeat.json) and shows their runs.
 * Quiet hours are part of the core agent config.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowUpRight, Play, RotateCcw, Trash2, X } from 'lucide-react';
import { agentCore } from '../../lib/agent/api';
import {
  buildHeartbeatCron,
  describeHeartbeatSchedule,
  HEARTBEAT_PRESETS,
  parseHeartbeatCron,
  proactiveApi,
  REMINDER_STATUS_TONE,
  type HeartbeatConfig,
  type HeartbeatPatch,
  type HeartbeatSnapshot,
  type ManagedKind,
  type ManagedScheduleStatus,
  type Reminder,
} from '../../lib/agent/proactive';
import { formatDuration, humanizeCron, RUN_STATUS_META } from '../../lib/automations';
import type { AutomationRun } from '../../lib/claude-client';
import {
  Button,
  Card,
  EmptyNote,
  ErrorNote,
  Field,
  INPUT_BASE_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  Pill,
  Section,
  Spinner,
  Toggle,
  relativeTime,
  usePolled,
  type AgentSectionProps,
} from './ui';

const POLL_MS = 15_000;
const AGENT_SESSION_ID = 'main-session';
const HOURS = Array.from({ length: 24 }, (_, h) => h);

function hourLabel(h: number): string {
  return `${String(h).padStart(2, '0')}:00`;
}

/** "Thu 13 Nov, 09:30" on the agent's clock, which may not be this computer's. */
function inZone(ts: number | null | undefined, timezone: string): string {
  if (!ts) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleString();
  }
}

/**
 * A local copy of server settings that polling doesn't clobber while the
 * person is typing, and that resyncs once the server has caught up.
 */
function useDraft<T>(source: T) {
  const sourceKey = JSON.stringify(source);
  const [draft, setDraft] = useState<T>(source);
  const [baseKey, setBaseKey] = useState(sourceKey);
  const draftKey = JSON.stringify(draft);
  const dirty = draftKey !== baseKey;
  useEffect(() => {
    if (!dirty || draftKey === sourceKey) {
      setDraft(JSON.parse(sourceKey) as T);
      setBaseKey(sourceKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);
  const reset = useCallback(() => {
    setDraft(JSON.parse(sourceKey) as T);
    setBaseKey(sourceKey);
  }, [sourceKey]);
  return { draft, setDraft, dirty, reset };
}

export function HeartbeatSection({ api, refreshKey, onOpenSession }: AgentSectionProps) {
  const snap = usePolled(() => proactiveApi.heartbeat(api), [api, refreshKey], POLL_MS);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6_000);
    return () => clearTimeout(timer);
  }, [notice]);

  if (snap.loading && !snap.data) return <Spinner />;
  if (!snap.data) return <ErrorNote message={snap.error ?? 'Could not load the heartbeat settings'} onRetry={() => void snap.reload()} />;
  const data = snap.data;

  const save = async (patch: HeartbeatPatch): Promise<boolean> => {
    try {
      snap.setData(await proactiveApi.saveHeartbeat(api, patch));
      return true;
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const runNow = async (kind: ManagedKind) => {
    try {
      const res = await proactiveApi.runNow(api, kind);
      const what = kind === 'heartbeat' ? 'Heartbeat' : 'Morning brief';
      setNotice(res.skipped
        ? `${what} skipped: ${res.run.error ?? 'the agent was busy'}.`
        : res.run.status === 'failed'
          ? `${what} failed to start: ${res.run.error ?? 'unknown error'}`
          : `${what} started — the agent is on it.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
    await snap.reload();
  };

  return (
    <div>
      {!data.agentEnabled && (
        <div className="mb-4">
          <ErrorNote message="The agent is turned off on this host. The heartbeat and the morning brief only run while it is on (Overview tab); message reminders still go out." />
        </div>
      )}
      {snap.error && <div className="mb-4"><ErrorNote message={snap.error} onRetry={() => void snap.reload()} /></div>}
      {notice && (
        <div className="mb-4 px-3 py-2 rounded-md border border-indigo-400/25 bg-indigo-400/8 text-[11.5px] text-indigo-200 flex items-center gap-2">
          <span className="flex-1 min-w-0">{notice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="text-indigo-300 hover:text-indigo-100"><X size={12} /></button>
        </div>
      )}

      <HeartbeatCard data={data} onSave={save} onRunNow={() => runNow('heartbeat')} onOpenSession={onOpenSession} />
      <MorningBriefCard data={data} onSave={save} onRunNow={() => runNow('morning_brief')} onOpenSession={onOpenSession} />
      <QuietHoursCard
        data={data}
        onSave={async quietHours => {
          try {
            await agentCore.saveConfig(api, { quietHours });
            await snap.reload();
            return true;
          } catch (err) {
            setNotice(err instanceof Error ? err.message : String(err));
            return false;
          }
        }}
      />
      <RemindersCard api={api} refreshKey={refreshKey} timezone={data.timezone} onNotice={setNotice} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

type HeartbeatDraft = Pick<HeartbeatConfig, 'interval' | 'checklist' | 'maxMessagesPerDay'>;

function HeartbeatCard({ data, onSave, onRunNow, onOpenSession }: {
  data: HeartbeatSnapshot;
  onSave: (patch: HeartbeatPatch) => Promise<boolean>;
  onRunNow: () => Promise<void>;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { config } = data;
  const { draft, setDraft, dirty, reset } = useDraft<HeartbeatDraft>({
    interval: config.interval,
    checklist: config.checklist,
    maxMessagesPerDay: config.maxMessagesPerDay,
  });
  const parsed = parseHeartbeatCron(draft.interval);
  const [custom, setCustom] = useState(() => parsed === null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const set = <K extends keyof HeartbeatDraft>(k: K, v: HeartbeatDraft[K]) => setDraft(d => ({ ...d, [k]: v }));
  const schedule = parsed ?? { presetId: '1h', from: 8, to: 22 };

  const submit = async () => {
    setSaving(true);
    await onSave(draft);
    setSaving(false);
  };

  return (
    <Section
      title="Heartbeat"
      hint="A periodic check-in: the agent looks at your calendar, email, inbox and reminders, and only messages you when something needs attention."
      action={<Toggle on={config.enabled} label={config.enabled ? 'Turn the heartbeat off' : 'Turn the heartbeat on'} onClick={() => void onSave({ enabled: !config.enabled })} />}
    >
      <Card>
        <div className="flex items-center gap-2 mb-3 text-[11.5px] text-zinc-500 flex-wrap">
          <Pill tone={config.enabled && data.agentEnabled ? 'green' : 'zinc'}>{config.enabled ? (data.agentEnabled ? 'On' : 'On · agent off') : 'Off'}</Pill>
          {config.enabled && data.heartbeat?.nextRunAt && (
            <span>Next beat {relativeTime(data.heartbeat.nextRunAt)} · {inZone(data.heartbeat.nextRunAt, data.timezone)}</span>
          )}
          <span className="text-zinc-700">·</span>
          <span>{data.today.sent} of {data.today.max} messages sent today</span>
        </div>

        <span className={LABEL_CLASS}>How often</span>
        <div className="flex gap-1.5 mb-2 flex-wrap">
          {HEARTBEAT_PRESETS.map(p => (
            <PresetButton
              key={p.id}
              active={!custom && parsed?.presetId === p.id}
              onClick={() => { setCustom(false); set('interval', buildHeartbeatCron({ ...schedule, presetId: p.id })); }}
            >
              {p.label}
            </PresetButton>
          ))}
          <PresetButton active={custom} onClick={() => setCustom(true)}>Custom</PresetButton>
        </div>

        {custom ? (
          <Field label="Cron expression" hint={`${humanizeCron(draft.interval)} — evaluated in ${data.timezone}. Beats must be at least 10 minutes apart.`}>
            <input className={`${INPUT_CLASS} font-mono`} value={draft.interval} onChange={e => set('interval', e.target.value)} />
          </Field>
        ) : (
          <div className="mb-3">
            <span className={LABEL_CLASS}>Active hours ({data.timezone})</span>
            <div className="flex items-center gap-2 text-[12px] text-zinc-400">
              <select
                aria-label="First active hour"
                className={`${INPUT_BASE_CLASS} w-[96px]`}
                value={schedule.from}
                onChange={e => {
                  const from = Number(e.target.value);
                  set('interval', buildHeartbeatCron({ ...schedule, from, to: Math.max(from, schedule.to) }));
                }}
              >
                {HOURS.map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
              <span>to</span>
              <select
                aria-label="Last active hour"
                className={`${INPUT_BASE_CLASS} w-[96px]`}
                value={schedule.to}
                onChange={e => set('interval', buildHeartbeatCron({ ...schedule, to: Math.max(schedule.from, Number(e.target.value)) }))}
              >
                {HOURS.filter(h => h >= schedule.from).map(h => <option key={h} value={h}>{`${String(h).padStart(2, '0')}:59`}</option>)}
              </select>
            </div>
            <span className="flex items-center gap-2 text-[11px] text-zinc-500 mt-1.5">
              {describeHeartbeatSchedule(schedule)}
              <code className="font-mono text-[10.5px] text-zinc-500 bg-base border border-border rounded px-1.5 py-px whitespace-nowrap">{draft.interval}</code>
            </span>
          </div>
        )}

        <Field
          label="Checklist"
          hint="What the agent checks on every beat. It messages you only when something needs attention, and otherwise stays silent."
        >
          <textarea
            className={`${INPUT_CLASS} min-h-[132px] resize-y`}
            value={draft.checklist}
            onChange={e => set('checklist', e.target.value)}
          />
        </Field>
        {draft.checklist !== data.defaults.checklist && (
          <button type="button" onClick={() => set('checklist', data.defaults.checklist)} className="-mt-2 mb-3 inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:underline">
            <RotateCcw size={10} /> Reset to the default checklist
          </button>
        )}

        <Field label="Messages per day" hint="The most notifications the heartbeat may send in a day. Urgent ones always go through. 0 = only urgent.">
          <input
            type="number"
            min={0}
            max={48}
            className={`${INPUT_BASE_CLASS} w-[96px]`}
            value={draft.maxMessagesPerDay}
            onChange={e => set('maxMessagesPerDay', Math.max(0, Math.min(48, Math.round(Number(e.target.value) || 0))))}
          />
        </Field>

        <div className="flex items-center gap-2">
          <Button tone="primary" disabled={!dirty || saving} onClick={() => void submit()}>{saving ? 'Saving…' : 'Save'}</Button>
          {dirty && <Button onClick={reset}>Discard</Button>}
          <div className="flex-1" />
          <Button
            disabled={running}
            title="Run one check now, whether or not the schedule is on"
            onClick={async () => { setRunning(true); try { await onRunNow(); } finally { setRunning(false); } }}
          >
            <Play size={11} fill="currentColor" /> Run now
          </Button>
        </div>
      </Card>

      <RunList status={data.heartbeat} timezone={data.timezone} onOpenSession={onOpenSession} empty="The heartbeat has not run yet." />
    </Section>
  );
}

function PresetButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-[11px] px-2.5 py-1.5 rounded-md border transition-colors ${
        active ? 'bg-surface-lighter border-indigo-400/50 text-zinc-100' : 'border-border text-zinc-500 hover:text-zinc-200'
      }`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Morning brief
// ---------------------------------------------------------------------------

function MorningBriefCard({ data, onSave, onRunNow, onOpenSession }: {
  data: HeartbeatSnapshot;
  onSave: (patch: HeartbeatPatch) => Promise<boolean>;
  onRunNow: () => Promise<void>;
  onOpenSession?: (sessionId: string) => void;
}) {
  const brief = data.config.morningBrief;
  const { draft, setDraft, dirty, reset } = useDraft({ time: brief.time, prompt: brief.prompt });
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  return (
    <Section
      title="Morning brief"
      hint="Once a day the agent sends you a short summary: your calendar, the weather, important email and what is due."
      action={<Toggle on={brief.enabled} label={brief.enabled ? 'Turn the morning brief off' : 'Turn the morning brief on'} onClick={() => void onSave({ morningBrief: { enabled: !brief.enabled } })} />}
    >
      <Card>
        <div className="flex items-center gap-2 mb-3 text-[11.5px] text-zinc-500 flex-wrap">
          <Pill tone={brief.enabled && data.agentEnabled ? 'green' : 'zinc'}>{brief.enabled ? (data.agentEnabled ? 'On' : 'On · agent off') : 'Off'}</Pill>
          {brief.enabled && data.morningBrief?.nextRunAt && (
            <span>Next {relativeTime(data.morningBrief.nextRunAt)} · {inZone(data.morningBrief.nextRunAt, data.timezone)}</span>
          )}
        </div>
        <Field label={`Time (${data.timezone})`}>
          <input
            type="time"
            className={`${INPUT_BASE_CLASS} w-[128px] [color-scheme:dark]`}
            value={draft.time}
            onChange={e => setDraft(d => ({ ...d, time: e.target.value }))}
          />
        </Field>
        <Field label="What to include">
          <textarea
            className={`${INPUT_CLASS} min-h-[132px] resize-y`}
            value={draft.prompt}
            onChange={e => setDraft(d => ({ ...d, prompt: e.target.value }))}
          />
        </Field>
        {draft.prompt !== data.defaults.briefPrompt && (
          <button type="button" onClick={() => setDraft(d => ({ ...d, prompt: data.defaults.briefPrompt }))} className="-mt-2 mb-3 inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:underline">
            <RotateCcw size={10} /> Reset to the default brief
          </button>
        )}
        <div className="flex items-center gap-2">
          <Button
            tone="primary"
            disabled={!dirty || saving || !/^\d{2}:\d{2}$/.test(draft.time) || !draft.prompt.trim()}
            onClick={async () => { setSaving(true); await onSave({ morningBrief: draft }); setSaving(false); }}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
          {dirty && <Button onClick={reset}>Discard</Button>}
          <div className="flex-1" />
          <Button
            disabled={running}
            title="Send today's brief now"
            onClick={async () => { setRunning(true); try { await onRunNow(); } finally { setRunning(false); } }}
          >
            <Play size={11} fill="currentColor" /> Run now
          </Button>
        </div>
      </Card>
      <RunList status={data.morningBrief} timezone={data.timezone} onOpenSession={onOpenSession} empty="No brief sent yet." limit={3} />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Run history (shared)
// ---------------------------------------------------------------------------

function RunList({ status, timezone, onOpenSession, empty, limit = 6 }: {
  status: ManagedScheduleStatus | null;
  timezone: string;
  onOpenSession?: (sessionId: string) => void;
  empty: string;
  limit?: number;
}) {
  const runs = status?.runs.slice(0, limit) ?? [];
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] uppercase tracking-wide text-zinc-600 font-semibold">Last runs</span>
        {runs.some(r => r.sessionId) && onOpenSession && (
          <button type="button" onClick={() => onOpenSession(AGENT_SESSION_ID)} className="inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:underline">
            Open the agent's chat <ArrowUpRight size={11} />
          </button>
        )}
      </div>
      {runs.length === 0 ? (
        <div className="text-[11.5px] text-zinc-600 py-1">{empty}</div>
      ) : (
        <div className="flex flex-col gap-px bg-border border border-border rounded-md overflow-hidden">
          {runs.map(run => <RunLine key={run.id} run={run} timezone={timezone} />)}
        </div>
      )}
    </div>
  );
}

function RunLine({ run, timezone }: { run: AutomationRun; timezone: string }) {
  const meta = RUN_STATUS_META[run.status];
  const detail = run.error || (run.resultText && run.resultText.trim() !== 'NO_REPLY' ? run.resultText : null)
    || (run.resultText?.trim() === 'NO_REPLY' ? 'Nothing needed your attention.' : null);
  return (
    <div className="bg-base px-3 py-2 text-[11.5px]">
      <div className="flex items-center gap-2.5">
        <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${meta.tick} ${run.status === 'running' ? 'animate-pulse' : ''}`} />
        <span className={`font-medium w-[72px] shrink-0 ${meta.tone}`}>{meta.label}</span>
        <span className="text-[9px] uppercase tracking-wide font-semibold px-1.5 py-px rounded bg-surface-lighter text-zinc-500 shrink-0">{run.trigger}</span>
        <span className="flex-1 min-w-0 text-zinc-500 truncate" title={inZone(run.createdAt, timezone)}>{relativeTime(run.createdAt)}</span>
        <span className="text-zinc-600 tabular-nums shrink-0">{formatDuration(run.durationMs)}</span>
      </div>
      {detail && (
        <div className={`mt-1 pl-[17px] line-clamp-2 ${run.error && run.status !== 'skipped' ? 'text-red-300/90' : 'text-zinc-500'}`}>{detail}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------

function QuietHoursCard({ data, onSave }: {
  data: HeartbeatSnapshot;
  onSave: (quiet: HeartbeatSnapshot['quietHours']) => Promise<boolean>;
}) {
  const quiet = data.quietHours;
  const { draft, setDraft, dirty, reset } = useDraft({ start: quiet.start, end: quiet.end });
  const [saving, setSaving] = useState(false);
  const valid = /^\d{2}:\d{2}$/.test(draft.start) && /^\d{2}:\d{2}$/.test(draft.end) && draft.start !== draft.end;

  return (
    <Section
      title="Quiet hours"
      hint={`During quiet hours, low-priority messages wait until they end, normal ones arrive silently, and urgent ones always ring. Times are in ${data.timezone}.`}
      action={<Toggle on={quiet.enabled} label={quiet.enabled ? 'Turn quiet hours off' : 'Turn quiet hours on'} onClick={() => void onSave({ ...quiet, enabled: !quiet.enabled })} />}
    >
      <Card>
        <div className="flex items-end gap-3 flex-wrap">
          <label className="block">
            <span className={LABEL_CLASS}>From</span>
            <input type="time" className={`${INPUT_BASE_CLASS} w-[128px] [color-scheme:dark]`} value={draft.start} onChange={e => setDraft(d => ({ ...d, start: e.target.value }))} />
          </label>
          <label className="block">
            <span className={LABEL_CLASS}>Until</span>
            <input type="time" className={`${INPUT_BASE_CLASS} w-[128px] [color-scheme:dark]`} value={draft.end} onChange={e => setDraft(d => ({ ...d, end: e.target.value }))} />
          </label>
          <Button tone="primary" disabled={!dirty || !valid || saving} onClick={async () => { setSaving(true); await onSave({ ...quiet, ...draft }); setSaving(false); }}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          {dirty && <Button onClick={reset}>Discard</Button>}
        </div>
        {!valid && <p className="text-[11px] text-amber-400 mt-2">Pick two different times.</p>}
        {data.queuedNotifications > 0 && (
          <p className="text-[11px] text-zinc-500 mt-2">
            {data.queuedNotifications === 1 ? '1 low-priority message is' : `${data.queuedNotifications} low-priority messages are`} waiting for quiet hours to end.
          </p>
        )}
      </Card>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

function RemindersCard({ api, refreshKey, timezone, onNotice }: {
  api: AgentSectionProps['api'];
  refreshKey: number;
  timezone: string;
  onNotice: (message: string) => void;
}) {
  const [showPast, setShowPast] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const list = usePolled(() => proactiveApi.reminders(api, showPast), [api, refreshKey, showPast], 30_000);
  const reminders = list.data?.reminders ?? [];

  const cancel = async (r: Reminder) => {
    if (!window.confirm(`Cancel the reminder “${r.text.slice(0, 80)}”?`)) return;
    setBusy(r.id);
    try {
      await proactiveApi.cancelReminder(api, r.id);
      await list.reload();
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      title="Reminders"
      hint="Set by the agent when you ask it (“remind me tomorrow at 9 to call Ana”)."
      action={
        <button type="button" onClick={() => setShowPast(v => !v)} className="text-[11px] text-indigo-400 hover:underline">
          {showPast ? 'Hide past' : 'Show past'}
        </button>
      }
    >
      {list.error && <div className="mb-2"><ErrorNote message={list.error} onRetry={() => void list.reload()} /></div>}
      {list.loading && !list.data ? (
        <Spinner />
      ) : reminders.length === 0 ? (
        <EmptyNote>{showPast ? 'No reminders yet.' : 'No upcoming reminders.'} Ask the agent on any channel to set one.</EmptyNote>
      ) : (
        <div className="flex flex-col gap-2">
          {reminders.map(r => (
            <ReminderRow key={r.id} reminder={r} timezone={timezone} busy={busy === r.id} onCancel={() => void cancel(r)} />
          ))}
        </div>
      )}
    </Section>
  );
}

function ReminderRow({ reminder: r, timezone, busy, onCancel }: { reminder: Reminder; timezone: string; busy: boolean; onCancel: () => void }) {
  const when = r.schedule === 'cron'
    ? `${humanizeCron(r.cron ?? '')}${r.timezone !== timezone ? ` (${r.timezone})` : ''}`
    : inZone(r.at ? Date.parse(r.at) : null, timezone);
  const next = r.enabled ? r.nextRunAt ?? (r.at ? Date.parse(r.at) : null) : null;
  return (
    <div className={`bg-surface border border-border rounded-lg px-3.5 py-2.5 flex items-start gap-3 ${r.enabled ? '' : 'opacity-70'}`}>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] text-zinc-200 whitespace-pre-wrap break-words line-clamp-3">{r.text}</div>
        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap text-[11px] text-zinc-500">
          <span>{when}</span>
          {next && <span className="text-zinc-600">· {relativeTime(next)}</span>}
          {r.mode === 'task' && <Pill tone="indigo">Task</Pill>}
          {r.priority !== 'normal' && <Pill tone={r.priority === 'urgent' ? 'red' : 'zinc'}>{r.priority}</Pill>}
          {r.status !== 'scheduled' && <Pill tone={REMINDER_STATUS_TONE[r.status] ?? 'zinc'}>{r.status.replace('_', ' ')}</Pill>}
        </div>
        {r.lastRun?.error && r.lastRun.status !== 'succeeded' && (
          <div className="text-[11px] text-amber-300/90 mt-1 line-clamp-2">{r.lastRun.error}</div>
        )}
      </div>
      {/* A quiet icon button, like the Rules rows: a column of red "Cancel"
          buttons shouted louder than the reminders themselves. */}
      {r.enabled && (
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          title="Cancel this reminder"
          aria-label={`Cancel the reminder “${r.text.slice(0, 60)}”`}
          className="w-7 h-7 grid place-items-center rounded-md shrink-0 text-zinc-500 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}
