/**
 * Agent view → Connections: the Google account the agent uses for Gmail and
 * Calendar (guided OAuth setup, access levels, connect/disconnect), and the
 * saved website logins the agent can type into pages with browser_fill_secret.
 *
 * Secrets are write-only here: the client secret and passwords are sent to
 * the agent's host, stored encrypted, and never shown again.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  CalendarDays, Check, Copy, ExternalLink, Globe, KeyRound, Loader2, Lock, Mail, Plus, RefreshCw, Trash2, Unplug, WandSparkles,
} from 'lucide-react';
import {
  CALENDAR_LEVELS,
  GMAIL_LEVELS,
  domainFromInput,
  googleApi,
  savedLoginsApi,
  scopeLabel,
  type GoogleStatus,
} from '../../lib/agent/google';
import { Button, Card, EmptyNote, ErrorNote, Field, INPUT_CLASS, Pill, Section, Spinner, relativeTime, usePolled, type AgentSectionProps } from './ui';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function ConnectionsSection({ api, refreshKey }: AgentSectionProps) {
  return (
    <>
      <GoogleConnection api={api} refreshKey={refreshKey} />
      <SavedLogins api={api} refreshKey={refreshKey} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

interface PendingConnect {
  url: string;
  expiresAt: number;
  /** Status fingerprint when Connect was clicked; any change while connected means Google came back. */
  before: string;
}

const fingerprint = (s: GoogleStatus | null) => (s ? `${s.connected}|${s.email}|${s.scopes.join(' ')}` : '');

function GoogleConnection({ api, refreshKey }: Pick<AgentSectionProps, 'api' | 'refreshKey'>) {
  const [pending, setPending] = useState<PendingConnect | null>(null);
  const status = usePolled(() => googleApi.status(api), [api, refreshKey, !!pending], pending ? 2500 : 0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const s = status.data;

  // Finish (or give up on) a connect started from this screen.
  useEffect(() => {
    if (!pending || !s) return;
    if (s.connected && fingerprint(s) !== pending.before) {
      setPending(null);
    } else if (Date.now() > pending.expiresAt) {
      setPending(null);
      setError('The Google sign-in link expired. Click Connect to try again.');
    }
  }, [pending, s]);

  const act = async (id: string, fn: () => Promise<GoogleStatus | void>) => {
    setBusy(id);
    setError(null);
    try {
      const next = await fn();
      if (next) status.setData(next);
      else await status.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const connect = () => act('connect', async () => {
    const start = await googleApi.startAuth(api);
    setPending({ url: start.url, expiresAt: start.expiresAt, before: fingerprint(s) });
    window.open(start.url, '_blank', 'noopener');
  });

  if (status.loading && !s) return <Spinner />;
  if (!s) return <ErrorNote message={`Couldn't load the Google connection: ${status.error ?? 'unknown error'}`} onRetry={() => void status.reload()} />;

  return (
    <Section title="Google" hint="Gmail and Calendar for the agent. The OAuth client and tokens are stored encrypted on the agent's host.">
      {error && <div className="mb-2.5"><ErrorNote message={error} /></div>}

      <Card className="mb-2.5">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-md bg-surface-light border border-border grid place-items-center shrink-0">
            <Mail size={15} className="text-indigo-300" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-zinc-100 flex items-center gap-2 flex-wrap">
              Google account
              <ConnectionPill s={s} connecting={!!pending} />
            </div>
            <div className="text-[11.5px] text-zinc-500 mt-0.5 truncate">
              {s.connected ? s.email || 'Connected' : s.configured ? 'Ready to connect' : 'Finish the setup below, then connect'}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {s.connected && s.needsReconnect && !pending && (
              <Button tone="primary" onClick={() => void connect()} disabled={!!busy}>
                <RefreshCw size={12} /> Reconnect
              </Button>
            )}
            {!s.connected && !pending && (
              <Button tone="primary" onClick={() => void connect()} disabled={!s.configured || !!busy} title={s.configured ? undefined : 'Add the OAuth client and public URL first'}>
                {busy === 'connect' ? <Loader2 size={12} className="animate-spin" /> : <ExternalLink size={12} />} Connect
              </Button>
            )}
            {pending && <Button onClick={() => setPending(null)}>Cancel</Button>}
            {s.connected && (
              <ConfirmButton label="Disconnect" confirmLabel="Confirm disconnect" icon={<Unplug size={12} />} disabled={!!busy}
                onConfirm={() => void act('disconnect', async () => { await googleApi.disconnect(api); })} />
            )}
          </div>
        </div>

        {pending && (
          <div className="mt-3 px-3 py-2 rounded-md border border-indigo-400/30 bg-indigo-400/5 text-[11.5px] text-indigo-200 flex items-center gap-2">
            <Loader2 size={12} className="animate-spin shrink-0" />
            <span className="flex-1">Waiting for Google — finish signing in in the browser tab that opened.</span>
            <a href={pending.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 shrink-0">Open it again</a>
          </div>
        )}
        {!s.connected && s.lastError && !pending && (
          <div className="mt-3"><ErrorNote message={`${s.lastError.message} (${relativeTime(s.lastError.at)})`} /></div>
        )}
        {s.connected && s.needsReconnect && (
          <div className="mt-3 text-[11.5px] text-amber-300">
            Google hasn't granted {s.missingScopes.map(scopeLabel).join(', ')} yet. Click Reconnect and leave every box ticked on Google's screen.
          </div>
        )}
        {s.connected && s.scopes.length > 0 && (
          <div className="mt-3 flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] uppercase tracking-wide text-zinc-600 font-semibold mr-1">Granted</span>
            {s.scopes.map(scope => <Pill key={scope}>{scopeLabel(scope)}</Pill>)}
          </div>
        )}
      </Card>

      <AccessLevels api={api} s={s} onChange={next => status.setData(next)} onError={setError} />
      <GoogleSetup api={api} s={s} onChange={next => status.setData(next)} onError={setError} />
    </Section>
  );
}

function ConnectionPill({ s, connecting }: { s: GoogleStatus; connecting: boolean }) {
  if (connecting) return <Pill tone="indigo">Connecting</Pill>;
  if (s.connected && s.needsReconnect) return <Pill tone="amber">Needs reconnect</Pill>;
  if (s.connected) return <Pill tone="green">Connected</Pill>;
  if (s.lastError) return <Pill tone="red">Disconnected</Pill>;
  return <Pill>{s.configured ? 'Not connected' : 'Setup needed'}</Pill>;
}

interface PartProps {
  api: AgentSectionProps['api'];
  s: GoogleStatus;
  onChange: (next: GoogleStatus) => void;
  onError: (message: string | null) => void;
}

function AccessLevels({ api, s, onChange, onError }: PartProps) {
  const [saving, setSaving] = useState(false);
  const save = async (patch: Parameters<typeof googleApi.saveSettings>[1]) => {
    setSaving(true);
    onError(null);
    try { onChange(await googleApi.saveSettings(api, patch)); } catch (err) { onError(errorText(err)); } finally { setSaving(false); }
  };
  const gmailMeta = GMAIL_LEVELS.find(l => l.id === s.services.gmail)!;
  const calendarMeta = CALENDAR_LEVELS.find(l => l.id === s.services.calendar)!;
  return (
    <Card className="mb-2.5">
      <div className="text-[12.5px] font-semibold text-zinc-200 mb-0.5">What the agent may do</div>
      <p className="text-[11px] text-zinc-500 mb-3">
        Lowering a level applies right away. Raising one after connecting needs a reconnect so Google can ask you for the extra permission.
        Sending email or inviting people may still ask for your approval.
      </p>
      <LevelRow icon={<Mail size={13} />} label="Gmail" hint={gmailMeta.hint}>
        <Segmented label="Gmail access" value={s.services.gmail} options={GMAIL_LEVELS} disabled={saving} onChange={level => void save({ gmail: level })} />
      </LevelRow>
      <LevelRow icon={<CalendarDays size={13} />} label="Calendar" hint={calendarMeta.hint}>
        <Segmented label="Calendar access" value={s.services.calendar} options={CALENDAR_LEVELS} disabled={saving} onChange={level => void save({ calendar: level })} />
      </LevelRow>
    </Card>
  );
}

function LevelRow({ icon, label, hint, children }: { icon: ReactNode; label: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1.5 flex-wrap">
      <span className="text-zinc-500 shrink-0">{icon}</span>
      <div className="w-[70px] text-[12px] text-zinc-300 shrink-0">{label}</div>
      {children}
      <span className="text-[11px] text-zinc-500 min-w-0 flex-1">{hint}</span>
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange, disabled }: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-border bg-base p-0.5 shrink-0">
      {options.map(o => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          disabled={disabled}
          onClick={() => { if (o.id !== value) onChange(o.id); }}
          className={`px-2.5 h-[24px] text-[11.5px] rounded transition-colors disabled:opacity-60 ${
            o.id === value ? 'bg-indigo-400/20 text-indigo-200' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const CONSOLE = 'https://console.cloud.google.com';

function GoogleSetup({ api, s, onChange, onError }: PartProps) {
  const [open, setOpen] = useState(!s.configured);
  const [baseUrl, setBaseUrl] = useState(s.publicBaseUrl ?? '');
  const [detectNote, setDetectNote] = useState<string | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [json, setJson] = useState('');
  const [useJson, setUseJson] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { setBaseUrl(s.publicBaseUrl ?? ''); }, [s.publicBaseUrl]);

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    onError(null);
    try { await fn(); } catch (err) { onError(errorText(err)); } finally { setBusy(null); }
  };

  const detect = () => run('detect', async () => {
    const res = await googleApi.detectBaseUrl(api);
    setDetectNote(res.detail);
    if (res.url) setBaseUrl(res.url);
  });

  const saveBase = () => run('base', async () => {
    onChange(await googleApi.saveSettings(api, { publicBaseUrl: baseUrl }));
    setDetectNote(null);
  });

  const saveClient = () => run('client', async () => {
    const next = await googleApi.saveClient(api, useJson ? { credentialsJson: json } : { clientId, clientSecret });
    onChange(next);
    // The secret never stays in the page once the host has it.
    setClientSecret('');
    setJson('');
    setClientId('');
  });

  const removeClient = () => run('remove', async () => { onChange(await googleApi.removeClient(api)); });

  const baseDirty = (s.publicBaseUrl ?? '') !== baseUrl.trim().replace(/\/+$/, '');

  return (
    <Card>
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between text-left" aria-expanded={open}>
        <span className="text-[12.5px] font-semibold text-zinc-200 flex items-center gap-2">
          Setup
          {s.configured ? <Pill tone="green">Done</Pill> : <Pill tone="amber">{s.clientConfigured || s.publicBaseUrl ? 'In progress' : 'Not started'}</Pill>}
        </span>
        <span className="text-[11px] text-zinc-500">{open ? 'Hide' : 'Show steps'}</span>
      </button>

      {open && (
        <ol className="mt-3 flex flex-col gap-3.5">
          <Step n={1} title="Give this bridge a public https address" done={!!s.redirectUri}>
            <p>
              Google sends you back to the agent's host after you sign in, so it needs an https URL that reaches this bridge from
              the internet — usually its Tailscale Funnel address.
            </p>
            <div className="flex gap-2 mt-2">
              <input
                className={INPUT_CLASS}
                placeholder="https://my-server.tailnet.ts.net"
                value={baseUrl}
                onChange={e => setBaseUrl(e.target.value)}
                aria-label="Public base URL"
                spellCheck={false}
              />
              <Button onClick={() => void detect()} disabled={!!busy} title="Look for a Tailscale Funnel that points at this bridge">
                {busy === 'detect' ? <Loader2 size={12} className="animate-spin" /> : <WandSparkles size={12} />} Detect
              </Button>
              <Button tone="primary" onClick={() => void saveBase()} disabled={!!busy || !baseDirty}>Save</Button>
            </div>
            {detectNote && <p className="mt-1.5 text-zinc-400">{detectNote}</p>}
            {s.redirectUri && (
              <div className="mt-2">
                <span className="text-zinc-500">Redirect URI (you'll paste it in step 4):</span>
                <CopyField value={s.redirectUri} />
              </div>
            )}
          </Step>

          <Step n={2} title="Create a Google Cloud project and enable the APIs">
            <p>
              <Ext href={`${CONSOLE}/projectcreate`}>Create a project</Ext> (any name, e.g. "Codiby Agent"), then enable the{' '}
              <Ext href={`${CONSOLE}/apis/library/gmail.googleapis.com`}>Gmail API</Ext> and the{' '}
              <Ext href={`${CONSOLE}/apis/library/calendar-json.googleapis.com`}>Google Calendar API</Ext> in it.
            </p>
          </Step>

          <Step n={3} title="Set up the OAuth consent screen">
            <p>
              In <Ext href={`${CONSOLE}/auth/overview`}>Google Auth Platform</Ext>, choose audience <b className="text-zinc-300">External</b>,
              fill in the app name and your email, then under Audience click <b className="text-zinc-300">Publish app</b> so it is
              "In production". In "Testing" Google expires the connection every 7 days.
            </p>
            <p className="mt-1">
              Google won't review a personal app, so when you connect you'll see "Google hasn't verified this app": choose
              Advanced → Go to (app name). That's expected — the app is yours.
            </p>
          </Step>

          <Step n={4} title='Create a "Web application" OAuth client' done={s.clientConfigured}>
            <p>
              In <Ext href={`${CONSOLE}/auth/clients`}>Clients</Ext> → Create client → Application type{' '}
              <b className="text-zinc-300">Web application</b>. Under Authorized redirect URIs add exactly:
            </p>
            {s.redirectUri ? <CopyField value={s.redirectUri} /> : <p className="mt-1 text-amber-300">Finish step 1 first to get the redirect URI.</p>}
          </Step>

          <Step n={5} title="Paste the client here" done={s.clientConfigured}>
            {s.clientConfigured && (
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <KeyRound size={12} className="text-zinc-500" />
                <code className="font-mono text-[11px] text-zinc-300">{s.clientIdHint}</code>
                <span className="text-zinc-500">· secret saved</span>
                <span className="flex-1" />
                <ConfirmButton label="Remove" confirmLabel={s.connected ? 'Remove and disconnect' : 'Confirm remove'} icon={<Trash2 size={12} />}
                  disabled={!!busy} onConfirm={() => void removeClient()} />
              </div>
            )}
            <p className="mb-2">
              {s.clientConfigured ? 'To replace it, paste' : 'Paste'} the client ID and secret Google shows after creating the client, or the
              JSON file it lets you download.{' '}
              <button type="button" className="text-indigo-400 hover:underline" onClick={() => setUseJson(v => !v)}>
                {useJson ? 'Enter ID and secret instead' : 'Paste the JSON instead'}
              </button>
            </p>
            {useJson ? (
              <Field label="client_secret_….json">
                <textarea
                  className={`${INPUT_CLASS} font-mono h-[84px] resize-y`}
                  value={json}
                  onChange={e => setJson(e.target.value)}
                  placeholder='{"web":{"client_id":"…","client_secret":"…"}}'
                  spellCheck={false}
                  autoComplete="off"
                />
              </Field>
            ) : (
              <div className="grid grid-cols-2 gap-2.5">
                <Field label="Client ID">
                  <input className={INPUT_CLASS} value={clientId} onChange={e => setClientId(e.target.value)}
                    placeholder="1234-abc.apps.googleusercontent.com" spellCheck={false} autoComplete="off" />
                </Field>
                <Field label="Client secret">
                  <input className={INPUT_CLASS} type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)}
                    placeholder="GOCSPX-…" autoComplete="new-password" />
                </Field>
              </div>
            )}
            <Button tone="primary" onClick={() => void saveClient()}
              disabled={!!busy || (useJson ? !json.trim() : !clientId.trim() || !clientSecret.trim())}>
              {busy === 'client' ? <Loader2 size={12} className="animate-spin" /> : <Lock size={12} />} Save client
            </Button>
          </Step>

          <Step n={6} title="Choose access levels above, then click Connect" done={s.connected} />
        </ol>
      )}
    </Card>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className={`w-5 h-5 rounded-full grid place-items-center text-[10.5px] font-semibold shrink-0 mt-px ${
        done ? 'bg-green-500/15 text-green-300 border border-green-500/30' : 'bg-surface-light text-zinc-400 border border-border'
      }`}>
        {done ? <Check size={11} /> : n}
      </span>
      <div className="flex-1 min-w-0 text-[11.5px] text-zinc-500 leading-relaxed">
        <div className="text-[12px] text-zinc-200 font-medium mb-0.5">{title}</div>
        {children}
      </div>
    </li>
  );
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline inline-flex items-center gap-0.5">
      {children}<ExternalLink size={10} />
    </a>
  );
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked: the text is selectable */ }
  };
  return (
    <div className="mt-1 flex items-center gap-2 bg-base border border-border rounded-md px-2.5 py-1.5">
      <code className="font-mono text-[11px] text-zinc-300 flex-1 min-w-0 truncate select-all" title={value}>{value}</code>
      <button type="button" onClick={() => void copy()} className="text-zinc-500 hover:text-zinc-200 shrink-0" aria-label="Copy" title="Copy">
        {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
      </button>
    </div>
  );
}

/** Two-click destructive action: the first click arms it for a few seconds. */
function ConfirmButton({ label, confirmLabel, icon, onConfirm, disabled }: {
  label: string;
  confirmLabel: string;
  icon?: ReactNode;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button tone="danger" disabled={disabled} onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      {icon}{armed ? confirmLabel : label}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Saved logins
// ---------------------------------------------------------------------------

function SavedLogins({ api, refreshKey }: Pick<AgentSectionProps, 'api' | 'refreshKey'>) {
  const list = usePolled(() => savedLoginsApi.list(api), [api, refreshKey]);
  const [domain, setDomain] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logins = list.data?.secrets ?? [];
  const host = domainFromInput(domain);

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      await savedLoginsApi.save(api, host, username, password);
      setDomain('');
      setUsername('');
      setPassword('');
      await list.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (d: string) => {
    setBusy(d);
    setError(null);
    try {
      await savedLoginsApi.remove(api, d);
      await list.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const replacing = !!host && logins.some(l => l.domain === host);

  return (
    <Section
      title="Saved logins"
      hint="Usernames and passwords the agent can type into websites for you. It never sees a password, and nothing saved here can be read back."
    >
      {error && <div className="mb-2.5"><ErrorNote message={error} /></div>}
      {list.error && !list.data && <div className="mb-2.5"><ErrorNote message={list.error} onRetry={() => void list.reload()} /></div>}

      {list.loading && !list.data ? <Spinner /> : logins.length === 0 ? (
        <div className="mb-2.5"><EmptyNote>No saved logins yet.</EmptyNote></div>
      ) : (
        <div className="flex flex-col gap-1.5 mb-2.5">
          {logins.map(l => (
            <Card key={l.name} className="flex items-center gap-3 py-2">
              <Globe size={13} className="text-zinc-500 shrink-0" />
              <span className="text-[12.5px] text-zinc-200 flex-1 min-w-0 truncate font-mono">{l.domain}</span>
              <span className="text-[11px] text-zinc-500 shrink-0">updated {relativeTime(l.updatedAt)}</span>
              <ConfirmButton label="Delete" confirmLabel="Confirm delete" icon={<Trash2 size={12} />} disabled={!!busy} onConfirm={() => void remove(l.domain)} />
            </Card>
          ))}
        </div>
      )}

      <Card>
        <form
          onSubmit={e => { e.preventDefault(); if (host && password) void save(); }}
          autoComplete="off"
        >
          <div className="grid grid-cols-3 gap-2.5">
            <Field label="Website" hint={host && host !== domain.trim().toLowerCase() ? `Saved as ${host}` : undefined}>
              <input className={INPUT_CLASS} value={domain} onChange={e => setDomain(e.target.value)} placeholder="github.com" spellCheck={false} autoComplete="off" />
            </Field>
            <Field label="Username">
              <input className={INPUT_CLASS} value={username} onChange={e => setUsername(e.target.value)} placeholder="you@example.com" spellCheck={false} autoComplete="off" />
            </Field>
            <Field label="Password">
              <input className={INPUT_CLASS} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
            </Field>
          </div>
          <div className="flex items-center gap-3">
            <Button tone="primary" type="submit" disabled={!!busy || !host || !password}>
              {busy === 'save' ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} {replacing ? 'Replace login' : 'Save login'}
            </Button>
            <span className="text-[11px] text-zinc-500">
              {replacing ? `This replaces the saved login for ${host}.` : 'Use the exact host you sign in on, e.g. accounts.google.com.'}
            </span>
          </div>
        </form>
      </Card>
    </Section>
  );
}
