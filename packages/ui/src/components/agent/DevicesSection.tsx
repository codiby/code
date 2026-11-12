/**
 * Agent view → Devices (workstream 6, push): the Firebase key the bridge
 * sends pushes with, the phones registered to receive them, and what gets
 * pushed. The key is write-only here — the bridge never sends it back.
 */

import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Check, ChevronRight, ExternalLink, KeyRound, Pencil, Send, Smartphone, Trash2, Upload, X } from 'lucide-react';
import { agentPush, type PushDevice, type PushDeliveryResult, type PushStatus } from '../../lib/agent/push';
import { Button, Card, EmptyNote, ErrorNote, INPUT_CLASS, Pill, Section, Spinner, Toggle, relativeTime, usePolled, type AgentSectionProps } from './ui';

const ANDROID_PACKAGE = 'com.codiby.code';
const IOS_BUNDLE_ID = 'com.codiby.code';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function summarizeResults(results: PushDeliveryResult[]): { ok: boolean; text: string } {
  const failed = results.filter(r => !r.ok);
  if (!results.length) return { ok: false, text: 'No device received it.' };
  if (!failed.length) return { ok: true, text: `Sent to ${results.length} device${results.length === 1 ? '' : 's'} — it should arrive in a few seconds.` };
  const first = failed[0]!;
  const disabled = failed.filter(r => r.disabled).length;
  return {
    ok: false,
    text: `${failed.length} of ${results.length} failed: ${first.error ?? 'unknown error'}${disabled ? ` (${disabled} switched off — reinstalled or signed out)` : ''}`,
  };
}

export function DevicesSection({ api, refreshKey }: AgentSectionProps) {
  const status = usePolled(() => agentPush.status(api), [api, refreshKey], 15_000);
  const devices = usePolled(() => agentPush.devices(api), [api, refreshKey], 15_000);
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (status.loading && !status.data) return <Spinner />;
  if (status.error && !status.data) return <ErrorNote message={`Couldn't read push settings on this host: ${status.error}`} onRetry={() => void status.reload()} />;
  const s = status.data!;
  const list = devices.data?.devices ?? [];

  const reloadAll = async () => {
    await Promise.all([status.reload(), devices.reload()]);
  };

  const sendTest = async (deviceId?: string) => {
    setTesting(true);
    setTestNote(null);
    try {
      const res = await agentPush.test(api, deviceId);
      setTestNote(summarizeResults(res.results));
    } catch (err) {
      setTestNote({ ok: false, text: errorText(err) });
    } finally {
      setTesting(false);
      await reloadAll();
    }
  };

  const saveSetting = async (patch: Partial<PushStatus['settings']>) => {
    setError(null);
    try {
      status.setData(await agentPush.saveSettings(api, patch));
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <>
      {error && <div className="mb-3"><ErrorNote message={error} /></div>}

      <Section title="Firebase" hint="Pushes go out through Firebase Cloud Messaging — Android directly, iPhone through Apple's APNs.">
        <FirebaseCard status={s} api={api} onChanged={reloadAll} />
      </Section>

      <Section
        title="Devices"
        hint="Phones register themselves when the Codiby app opens its Agent tab while it can reach this host."
        action={
          <Button onClick={() => void sendTest()} disabled={testing || !s.configured || s.devices === 0} title={!s.configured ? 'Upload the Firebase key first' : s.devices === 0 ? 'No enabled devices' : undefined}>
            <Send size={12} /> {testing ? 'Sending…' : 'Send test push'}
          </Button>
        }
      >
        {testNote && (
          <div className={`mb-2 text-[11.5px] px-3 py-2 rounded-md border ${testNote.ok ? 'border-green-500/30 bg-green-500/5 text-green-300' : 'border-amber-500/30 bg-amber-500/5 text-amber-300'}`}>
            {testNote.text}
          </div>
        )}
        {devices.error && !devices.data && <ErrorNote message={devices.error} onRetry={() => void devices.reload()} />}
        {list.length === 0 ? (
          <EmptyNote>
            No phones yet. Install the Codiby app, add this host in its Settings, and open the Agent tab.
          </EmptyNote>
        ) : (
          <div className="flex flex-col gap-1.5">
            {list.map(d => (
              <DeviceRow
                key={d.id}
                device={d}
                canTest={s.configured && !testing}
                onTest={() => void sendTest(d.id)}
                onChange={async patch => {
                  setError(null);
                  try {
                    await agentPush.updateDevice(api, d.id, patch);
                  } catch (err) {
                    setError(errorText(err));
                  }
                  await reloadAll();
                }}
                onDelete={async () => {
                  if (!window.confirm(`Remove ${d.name || 'this device'}? It stops getting pushes until the app registers again.`)) return;
                  setError(null);
                  try {
                    await agentPush.deleteDevice(api, d.id);
                  } catch (err) {
                    setError(errorText(err));
                  }
                  await reloadAll();
                }}
              />
            ))}
          </div>
        )}
      </Section>

      <Section title="What gets pushed">
        <Card className="flex flex-col gap-3">
          <SettingRow
            title="Approvals from every session"
            detail="Off: only the agent's own permission requests reach your phone; coding sessions keep asking here."
            on={s.settings.approvalsForAllSessions}
            onToggle={() => void saveSetting({ approvalsForAllSessions: !s.settings.approvalsForAllSessions })}
          />
          <SettingRow
            title="Messages and reminders"
            detail="What the agent sends you on its own, and your scheduled reminders. Quiet hours make them silent."
            on={s.settings.notifications}
            onToggle={() => void saveSetting({ notifications: !s.settings.notifications })}
          />
        </Card>
      </Section>

      <SetupSteps open={!s.configured} />
    </>
  );
}

function SettingRow({ title, detail, on, onToggle }: { title: string; detail: string; on: boolean; onToggle: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] text-zinc-200">{title}</div>
        <div className="text-[11px] text-zinc-500">{detail}</div>
      </div>
      <Toggle on={on} onClick={onToggle} label={title} />
    </div>
  );
}

function FirebaseCard({ status, api, onChanged }: { status: PushStatus; api: AgentSectionProps['api']; onChanged: () => Promise<void> }) {
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (!window.confirm('Remove the Firebase key? No pushes will go out until you upload one again.')) return;
    setBusy(true);
    setError(null);
    try {
      await agentPush.removeServiceAccount(api);
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (!status.configured || replacing) {
    return (
      <Card>
        <UploadForm
          api={api}
          onCancel={status.configured ? () => setReplacing(false) : undefined}
          onSaved={async () => {
            setReplacing(false);
            await onChanged();
          }}
        />
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center gap-3">
        <KeyRound size={15} className="text-zinc-500 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px] text-zinc-200 flex items-center gap-2">
            {status.projectId}
            {status.lastError ? <Pill tone="amber">Failing</Pill> : <Pill tone="green">Ready</Pill>}
          </div>
          <div className="text-[11px] text-zinc-500 truncate">
            {status.clientEmail} · {status.lastSuccessAt ? `last push ${relativeTime(status.lastSuccessAt)}` : 'no push sent yet'}
          </div>
        </div>
        <Button onClick={() => setReplacing(true)} disabled={busy}>Replace key</Button>
        <Button tone="danger" onClick={() => void remove()} disabled={busy}>Remove</Button>
      </div>
      {status.lastError && (
        <div className="mt-2.5">
          <ErrorNote message={`${status.lastError}${status.lastErrorAt ? ` (${relativeTime(status.lastErrorAt)})` : ''}`} />
        </div>
      )}
      {error && <div className="mt-2.5"><ErrorNote message={error} /></div>}
    </Card>
  );
}

function UploadForm({ api, onSaved, onCancel }: { api: AgentSectionProps['api']; onSaved: () => Promise<void>; onCancel?: () => void }) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const pickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 64 * 1024) {
      setError('That file is too large to be a service account key.');
      return;
    }
    setError(null);
    setFileName(file.name);
    setText(await file.text());
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await agentPush.uploadServiceAccount(api, text);
      // Don't keep the private key in the page any longer than needed.
      setText('');
      setFileName(null);
      await onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="text-[12.5px] text-zinc-200 mb-1">Service account key</div>
      <p className="text-[11px] text-zinc-500 mb-2.5">
        Firebase console → Project settings → Service accounts → <span className="text-zinc-300">Generate new private key</span>.
        It is stored encrypted on this host and never shown again.
      </p>
      <input ref={fileInput} type="file" accept="application/json,.json" className="hidden" onChange={e => void pickFile(e)} />
      <div className="flex items-center gap-2 mb-2">
        <Button onClick={() => fileInput.current?.click()} disabled={busy}>
          <Upload size={12} /> Choose JSON file…
        </Button>
        <span className="text-[11px] text-zinc-500 truncate">{fileName ?? 'or paste it below'}</span>
      </div>
      <textarea
        value={text}
        onChange={e => { setText(e.target.value); setFileName(null); }}
        placeholder='{ "type": "service_account", "project_id": "…", … }'
        rows={4}
        spellCheck={false}
        autoComplete="off"
        className={`${INPUT_CLASS} font-mono text-[11px] resize-y`}
      />
      {error && <div className="mt-2"><ErrorNote message={error} /></div>}
      <div className="flex items-center gap-2 mt-2.5">
        <Button tone="primary" onClick={() => void save()} disabled={busy || !text.trim()}>
          {busy ? 'Checking…' : 'Save key'}
        </Button>
        {onCancel && <Button onClick={onCancel} disabled={busy}>Cancel</Button>}
      </div>
    </div>
  );
}

function DeviceRow({ device, canTest, onTest, onChange, onDelete }: {
  device: PushDevice;
  canTest: boolean;
  onTest: () => void;
  onChange: (patch: { name?: string | null; disabled?: boolean }) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name ?? '');
  const off = device.disabledAt !== null;
  const label = device.name || (device.platform === 'ios' ? 'iPhone' : 'Android phone');

  const saveName = async () => {
    setEditing(false);
    const next = name.trim();
    if (next !== (device.name ?? '')) await onChange({ name: next || null });
  };

  return (
    <Card className={`py-2 ${off ? 'opacity-70' : ''}`}>
      <div className="flex items-center gap-3">
        <Smartphone size={15} className="text-zinc-500 shrink-0" />
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={name}
                maxLength={80}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void saveName();
                  if (e.key === 'Escape') { setEditing(false); setName(device.name ?? ''); }
                }}
                className={INPUT_CLASS}
                aria-label="Device name"
              />
              <button type="button" onClick={() => void saveName()} className="text-zinc-400 hover:text-zinc-200" aria-label="Save name"><Check size={14} /></button>
              <button type="button" onClick={() => { setEditing(false); setName(device.name ?? ''); }} className="text-zinc-500 hover:text-zinc-300" aria-label="Cancel rename"><X size={14} /></button>
            </div>
          ) : (
            <div className="text-[12.5px] text-zinc-200 flex items-center gap-2 min-w-0">
              <span className="truncate">{label}</span>
              <button type="button" onClick={() => setEditing(true)} className="text-zinc-600 hover:text-zinc-300 shrink-0" aria-label={`Rename ${label}`}><Pencil size={11} /></button>
              {off && <Pill tone={device.lastError ? 'red' : 'zinc'}>{device.lastError ? 'Unreachable' : 'Off'}</Pill>}
            </div>
          )}
          <div className="text-[11px] text-zinc-500 truncate">
            {device.platform === 'ios' ? 'iOS' : 'Android'}
            {device.appVersion ? ` · app ${device.appVersion}` : ''} · {device.tokenHint} · seen {relativeTime(device.lastSeenAt)}
          </div>
          {device.lastError && <div className="text-[11px] text-red-300 mt-0.5 break-words">{device.lastError}</div>}
        </div>
        <Button onClick={onTest} disabled={!canTest} title="Send a test push to this device">
          <Send size={12} /> Test
        </Button>
        <Toggle on={!off} onClick={() => void onChange({ disabled: !off })} label={off ? `Turn pushes on for ${label}` : `Turn pushes off for ${label}`} />
        <button type="button" onClick={() => void onDelete()} className="text-zinc-600 hover:text-red-300 p-1" aria-label={`Remove ${label}`} title="Remove device">
          <Trash2 size={13} />
        </button>
      </div>
    </Card>
  );
}

/** Inline identifiers in the setup steps, styled like the Rules tab's chips (the bare global `code` is just a font). */
function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[10.5px] text-zinc-300 bg-base border border-border rounded px-1 py-px break-words">{children}</code>;
}

function SetupSteps({ open }: { open: boolean }) {
  return (
    <Section title="Setup">
      {/* Own chevron instead of the native disclosure triangle, so it matches the other cards. */}
      <details open={open} className="group bg-surface border border-border rounded-lg px-3.5 py-3 text-[11.5px] text-zinc-400">
        <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer select-none flex items-center gap-1.5 text-[12.5px] text-zinc-200 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50">
          <ChevronRight size={13} className="text-zinc-500 transition-transform group-open:rotate-90" />
          How to set up push notifications
        </summary>
        <ol className="list-decimal pl-5 mt-2.5 flex flex-col gap-2 leading-relaxed marker:text-zinc-600">
          <li>
            Open the <a className="text-indigo-400 hover:underline inline-flex items-center gap-0.5" href="https://console.firebase.google.com" target="_blank" rel="noreferrer">Firebase console <ExternalLink size={10} /></a> and
            add Firebase to the Google Cloud project you already use for the agent (or create a new one).
          </li>
          <li>
            Add an <span className="text-zinc-200">Android app</span> with package name <Code>{ANDROID_PACKAGE}</Code>. Download{' '}
            <Code>google-services.json</Code> into <Code>packages/mobile/android/app/</Code>.
          </li>
          <li>
            Add an <span className="text-zinc-200">iOS app</span> with bundle ID <Code>{IOS_BUNDLE_ID}</Code>. Download{' '}
            <Code>GoogleService-Info.plist</Code> into <Code>packages/mobile/ios/CodibyCode/</Code>, then run{' '}
            <Code>bun run mobile:pods</Code> and commit the updated <Code>Podfile.lock</Code>.
          </li>
          <li>
            In the Apple Developer portal, enable <span className="text-zinc-200">Push Notifications</span> for <Code>{IOS_BUNDLE_ID}</Code>, regenerate
            the provisioning profile, and create an <span className="text-zinc-200">APNs authentication key</span> (.p8). Upload it in Firebase → Project settings →
            Cloud Messaging → Apple app configuration, with its Key ID and your Team ID.
          </li>
          <li>
            In Firebase → Project settings → Service accounts, choose <span className="text-zinc-200">Generate new private key</span> and upload the JSON above.
          </li>
          <li>
            Rebuild the app (<Code>bun run mobile:android</Code>, or the iOS build / TestFlight), open its <span className="text-zinc-200">Agent</span> tab
            and allow notifications. The phone shows up in the list; use <span className="text-zinc-200">Send test push</span> to check.
          </li>
        </ol>
        <p className="mt-2.5 text-[11px] text-zinc-500">
          Approvals arrive with Approve / Deny buttons; the answer goes straight back to this host. On Android the buttons are hidden on a locked screen; on
          iPhone they ask for Face ID first.
        </p>
      </details>
    </Section>
  );
}
