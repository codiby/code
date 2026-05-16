import { useEffect, useMemo, useState, useRef, type ReactNode } from 'react';
import {
  X, Settings as SettingsIcon, Folder, Send, Mic, Smartphone, Plug,
  ArrowRight, Pin, ExternalLink, Plus, Trash2, Check, Terminal,
  ShieldCheck, Globe, Server, Zap, Variable,
} from 'lucide-react';
import { Button, TextField, Input, Switch, SwitchControl, SwitchThumb } from '@heroui/react';
import {
  resolveServerUrl,
  type ClaudeClient,
  type HookScope,
  type HookEvent,
  type HookEntry,
  type ClaudeHooks,
} from '../lib/claude-client';
import { PairPhoneModal } from './PairPhoneModal';
import { PluginSettingsSections } from './PluginExtensionPoints';
import { RemotesSection } from './RemotesSection';
import { ICON_MAP, ICON_MAP_QUICK } from '../lib/group-icons';
import {
  GROUP_COLORS, GROUP_HEX_COLOR, GROUP_DOT_COLOR,
  type TabGroupInfo,
  type ProjectEnvVar,
  type ProjectAutoApproveRule,
} from '../lib/tab-groups';

interface ProjectSettingsModalProps {
  open: boolean;
  onClose: () => void;
  tabGroups: Record<string, TabGroupInfo>;
  tabGroupMap: Record<string, string>;
  autoGroupSessions: boolean;
  onToggleAutoGroup: (next: boolean) => void;
  showTelegramSession: boolean;
  onToggleShowTelegramSession: (next: boolean) => void;
  globalEnvVars: ProjectEnvVar[];
  onChangeGlobalEnvVars: (next: ProjectEnvVar[]) => void;
  /** Needed for the hooks editor to call getClaudeHooks/setClaudeHooks. */
  client: ClaudeClient | null;
  onDeleteGroup: (groupId: string) => void;
  onPatchGroup: (groupId: string, patch: Partial<TabGroupInfo>) => void;
}

type GlobalSection =
  | 'general'
  | 'telegram'
  | 'deepgram'
  | 'tailscale'
  | 'mobile'
  | 'remotes'
  | 'plugins'
  | 'hooks'
  | 'environment'
  | 'tab-groups'
  | 'about';

const HOOK_EVENTS: { id: HookEvent; label: string; supportsMatcher: boolean; hint: string }[] = [
  { id: 'PreToolUse',       label: 'PreToolUse',       supportsMatcher: true,  hint: 'Runs before Claude invokes a tool. Match by tool name (e.g. Bash, Edit).' },
  { id: 'PostToolUse',      label: 'PostToolUse',      supportsMatcher: true,  hint: 'Runs after a tool finishes. Match by tool name.' },
  { id: 'UserPromptSubmit', label: 'UserPromptSubmit', supportsMatcher: false, hint: 'Runs each time you send a message.' },
  { id: 'Notification',     label: 'Notification',     supportsMatcher: false, hint: 'Runs when Claude emits a UI notification (idle, awaiting input, etc.).' },
  { id: 'Stop',             label: 'Stop',             supportsMatcher: false, hint: 'Runs when the main agent stops or returns control.' },
  { id: 'SubagentStop',     label: 'SubagentStop',     supportsMatcher: false, hint: 'Runs when a Task() subagent finishes.' },
  { id: 'PreCompact',       label: 'PreCompact',       supportsMatcher: false, hint: 'Runs before the conversation is auto-compacted.' },
  { id: 'SessionStart',     label: 'SessionStart',     supportsMatcher: false, hint: 'Runs once when the session boots.' },
  { id: 'SessionEnd',       label: 'SessionEnd',       supportsMatcher: false, hint: 'Runs when the session is closed cleanly.' },
];

/** Flat row used for editing — the on-disk shape nests commands under
 *  matchers, which is awkward to render as a form. We flatten on load
 *  and re-nest on save. */
interface HookRow {
  id: string;
  event: HookEvent;
  matcher: string;
  command: string;
  timeout?: number;
}

function flattenHooks(hooks: ClaudeHooks): HookRow[] {
  const out: HookRow[] = [];
  for (const event of HOOK_EVENTS.map(e => e.id)) {
    const entries = hooks[event];
    if (!entries) continue;
    for (const entry of entries) {
      for (const cmd of entry.hooks || []) {
        out.push({
          id: crypto.randomUUID(),
          event,
          matcher: entry.matcher || '',
          command: cmd.command || '',
          timeout: typeof cmd.timeout === 'number' ? cmd.timeout : undefined,
        });
      }
    }
  }
  return out;
}

function nestHooks(rows: HookRow[]): ClaudeHooks {
  const out: ClaudeHooks = {};
  for (const row of rows) {
    if (!row.command.trim()) continue;
    const event = row.event;
    const matcher = row.matcher.trim() || undefined;
    const bucket = (out[event] ||= []);
    let entry = bucket.find(e => (e.matcher || '') === (matcher || ''));
    if (!entry) {
      entry = { hooks: [] };
      if (matcher) entry.matcher = matcher;
      bucket.push(entry);
    }
    const cmd: HookEntry['hooks'][number] = { type: 'command', command: row.command.trim() };
    if (typeof row.timeout === 'number' && row.timeout > 0) cmd.timeout = row.timeout;
    entry.hooks.push(cmd);
  }
  return out;
}

type SelectedNav =
  | { kind: 'global'; id: GlobalSection }
  | { kind: 'project'; id: string };

const MODEL_OPTIONS = [
  { id: '', label: '— Use global default —' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7 (recommended)' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];

const AGENT_OPTIONS = [
  { id: '', label: '— Use global default —' },
  { id: 'claude', label: 'claude (default)' },
  { id: 'Plan', label: 'Plan' },
  { id: 'Explore', label: 'Explore' },
  { id: 'general-purpose', label: 'general-purpose' },
];

/* ============================================================
 *  Shared primitives
 * ============================================================ */

function SectionHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h3 className="text-[13px] font-semibold text-zinc-200">{title}</h3>
        {subtitle && <p className="mt-1 text-[12px] text-zinc-500 max-w-[60ch]">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[220px_1fr] gap-6 items-start py-3.5 border-t border-border first:border-t-0 first:pt-0">
      <div className="text-[12.5px] text-zinc-200 flex flex-col gap-1">
        <span>{label}</span>
        {hint && <span className="text-[11.5px] text-zinc-500 font-normal leading-snug">{hint}</span>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function InheritNote({ overriding, fallback, onReset }: { overriding: boolean; fallback: string; onReset: () => void }) {
  if (!overriding) {
    return (
      <div className="mt-1.5 text-[11px] text-zinc-600">
        Inherits global: <span className="text-zinc-500">{fallback}</span>
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-zinc-500">
      <ArrowRight className="w-3 h-3 -rotate-180" />
      Overrides global <span className="text-zinc-400">{fallback}</span>
      <button onClick={onReset} className="ml-1 text-violet-400 hover:text-violet-300 underline underline-offset-2">
        reset
      </button>
    </div>
  );
}

/* ============================================================
 *  Global sections (ported from old SettingsPanel)
 * ============================================================ */

function TelegramSection({ serverUrl, showTelegramSession, onToggleShowTelegramSession }: { serverUrl: string | null; showTelegramSession: boolean; onToggleShowTelegramSession: (v: boolean) => void }) {
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [running, setRunning] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverUrl) return;
    (async () => {
      try {
        const res = await fetch(`${serverUrl}/telegram/settings`);
        if (res.ok) {
          const data = await res.json();
          setBotToken(data.botToken || '');
          setChatId(data.chatId || '');
          setRunning(!!data.running);
        }
      } catch {}
      setLoaded(true);
    })();
  }, [serverUrl]);

  const onSave = async () => {
    if (!serverUrl) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const res = await fetch(`${serverUrl}/telegram/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken: botToken.trim(), chatId: chatId.trim() }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      const data = await res.json();
      setRunning(!!data.running);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  };

  return (
    <>
      <SectionHeader
        title="Telegram Bot"
        subtitle={<>Chat with Claude from Telegram. Create a bot with <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-zinc-300 underline">@BotFather</a> to get a token.</> as unknown as string}
        action={running ? (
          <span className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-green-400">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
            Running
          </span>
        ) : null}
      />

      {!loaded ? (
        <div className="text-[12px] text-zinc-600">Loading…</div>
      ) : (
        <div className="space-y-4">
          <Field label="Bot token" hint="Paste the token returned by @BotFather. Stored encrypted on disk.">
            <div className="relative">
              <TextField type={showToken ? 'text' : 'password'} value={botToken} onChange={setBotToken} aria-label="Bot Token">
                <Input placeholder="123456:ABC-DEF..." className="font-mono text-[12px] pr-14" />
              </TextField>
              <button
                onClick={() => setShowToken(v => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
              >
                {showToken ? 'Hide' : 'Show'}
              </button>
            </div>
          </Field>

          <Field label="Chat ID" hint="Optional. Restrict the bot to a single chat. Leave blank to accept any chat — send /start to discover the ID.">
            <TextField value={chatId} onChange={setChatId} aria-label="Chat ID">
              <Input placeholder="123456789" className="font-mono text-[12px]" />
            </TextField>
          </Field>

          <Field
            label="Show in sidebar & tabs"
            hint="The Telegram bot opens a special pseudo-session that can't be closed from the regular UI. Turn this off to hide it from the sidebar and horizontal tab strip — the bot keeps running."
          >
            <Switch
              isSelected={showTelegramSession}
              onChange={onToggleShowTelegramSession}
              className="inline-flex items-center gap-3 px-3 py-2 rounded-md bg-surface-light border border-border cursor-pointer"
            >
              <span className="text-[12.5px] text-zinc-200">{showTelegramSession ? 'Visible' : 'Hidden'}</span>
              <SwitchControl><SwitchThumb /></SwitchControl>
            </Switch>
          </Field>

          <div className="flex items-center gap-3 pt-2 border-t border-border">
            <Button onPress={onSave} isDisabled={saving} className="text-[12px] px-3 py-1.5 h-auto rounded-md font-medium text-white bg-violet-600 hover:bg-violet-500 border border-violet-600">
              {saving ? 'Saving…' : saved ? 'Saved' : 'Save & restart bot'}
            </Button>
            {error && <div className="text-[11px] text-red-400">{error}</div>}
          </div>
        </div>
      )}
    </>
  );
}

function DeepgramSection({ serverUrl }: { serverUrl: string | null }) {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('nova-3');
  const [language, setLanguage] = useState('multi');
  const [configured, setConfigured] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverUrl) return;
    (async () => {
      try {
        const res = await fetch(`${serverUrl}/deepgram/settings`);
        if (res.ok) {
          const data = await res.json();
          setApiKey(data.apiKey || '');
          setModel(data.model || 'nova-3');
          setLanguage(data.language || 'multi');
          setConfigured(!!data.configured);
        }
      } catch {}
      setLoaded(true);
    })();
  }, [serverUrl]);

  const onSave = async () => {
    if (!serverUrl) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const res = await fetch(`${serverUrl}/deepgram/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim(), model: model.trim() || 'nova-3', language: language.trim() || 'multi' }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      const data = await res.json();
      setConfigured(!!data.configured);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  };

  return (
    <>
      <SectionHeader
        title="Deepgram (Voice)"
        action={configured ? (
          <span className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-green-400">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
            Configured
          </span>
        ) : null}
      />
      <p className="text-[12px] text-zinc-500 max-w-[60ch] -mt-2 mb-4">
        Transcribe Telegram voice notes with Deepgram and forward the text to Claude. Get an API key at{' '}
        <a href="https://console.deepgram.com/signup" target="_blank" rel="noreferrer" className="text-zinc-300 underline">console.deepgram.com</a>.
      </p>

      {!loaded ? (
        <div className="text-[12px] text-zinc-600">Loading…</div>
      ) : (
        <div className="space-y-4">
          <Field label="API key">
            <div className="relative">
              <TextField type={showKey ? 'text' : 'password'} value={apiKey} onChange={setApiKey} aria-label="Deepgram API Key">
                <Input placeholder="Your Deepgram API key" className="font-mono text-[12px] pr-14" />
              </TextField>
              <button
                onClick={() => setShowKey(v => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
          </Field>
          <Field label="Model" hint="Defaults to nova-3, the recommended Deepgram general-purpose model.">
            <TextField value={model} onChange={setModel} aria-label="Deepgram Model">
              <Input placeholder="nova-3" className="font-mono text-[12px]" />
            </TextField>
          </Field>
          <Field label="Language" hint={<>Use <code className="text-zinc-400">multi</code> for auto-detect, or a BCP-47 code (e.g. <code className="text-zinc-400">en</code>, <code className="text-zinc-400">es</code>).</> as unknown as string}>
            <TextField value={language} onChange={setLanguage} aria-label="Deepgram Language">
              <Input placeholder="multi" className="font-mono text-[12px]" />
            </TextField>
          </Field>

          <div className="flex items-center gap-3 pt-2 border-t border-border">
            <Button onPress={onSave} isDisabled={saving} className="text-[12px] px-3 py-1.5 h-auto rounded-md font-medium text-white bg-violet-600 hover:bg-violet-500 border border-violet-600">
              {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
            </Button>
            {error && <div className="text-[11px] text-red-400">{error}</div>}
          </div>
        </div>
      )}
    </>
  );
}

function TailscaleSection({ serverUrl }: { serverUrl: string | null }) {
  const [loaded, setLoaded] = useState(false);
  const [available, setAvailable] = useState(false);
  const [funnelEnabled, setFunnelEnabled] = useState(false);
  const [hostname, setHostname] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverUrl) return;
    (async () => {
      try {
        const res = await fetch(`${serverUrl}/tailscale/settings`);
        if (res.ok) {
          const data = await res.json();
          setAvailable(!!data.available);
          setFunnelEnabled(!!data.funnelEnabled);
          setHostname(data.hostname || null);
        }
      } catch {}
      setLoaded(true);
    })();
  }, [serverUrl]);

  const onToggle = async (next: boolean) => {
    if (!serverUrl) return;
    setToggling(true); setError(null);
    try {
      const res = await fetch(`${serverUrl}/tailscale/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ funnelEnabled: next }),
      });
      const data = await res.json();
      setFunnelEnabled(!!data.funnelEnabled);
      setHostname(data.hostname || null);
      setAvailable(!!data.available);
      if (!res.ok || data.error) setError(data.error || `Failed (${res.status})`);
    } catch (e) { setError(String(e)); }
    finally { setToggling(false); }
  };

  return (
    <>
      <SectionHeader
        title="Tailscale Funnel"
        action={funnelEnabled ? (
          <span className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-green-400">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
            On
          </span>
        ) : null}
      />
      <p className="text-[12px] text-zinc-500 max-w-[60ch] -mt-2 mb-4">
        Expose this UI publicly via{' '}
        <a href="https://tailscale.com/kb/1223/funnel" target="_blank" rel="noreferrer" className="text-zinc-300 underline">Tailscale Funnel</a>
        {' '}so your phone can connect from any network. Pairing still requires the bearer token.
      </p>

      {!loaded ? (
        <div className="text-[12px] text-zinc-600">Loading…</div>
      ) : !available ? (
        <div className="text-[11.5px] text-zinc-500 bg-surface-light border border-border rounded-md px-3 py-2.5">
          Tailscale CLI not found. Install Tailscale and sign in to enable Funnel.
        </div>
      ) : (
        <div className="space-y-3">
          <Switch
            isSelected={funnelEnabled}
            onChange={onToggle}
            isDisabled={toggling}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md bg-surface-light border border-border hover:border-border-light transition-colors cursor-pointer"
          >
            <span className="flex-1 text-left text-[12.5px] text-zinc-200">
              {toggling ? 'Updating…' : funnelEnabled ? 'Funnel enabled' : 'Enable Funnel'}
            </span>
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
          </Switch>
          {hostname && (
            <div className="text-[11px] text-zinc-500">
              Host: <span className="font-mono text-zinc-400">{hostname}</span>
            </div>
          )}
          {error && (
            <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5 whitespace-pre-wrap">
              {error}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function MobileSection() {
  const [pairOpen, setPairOpen] = useState(false);
  return (
    <>
      <SectionHeader title="Mobile pairing" subtitle="Open this UI on your phone to approve permission requests remotely. Generates a QR code with the connection info." />
      <Button
        onPress={() => setPairOpen(true)}
        className="flex items-center justify-center gap-2 px-3 py-2 h-auto rounded-md text-[12.5px] font-medium text-zinc-100 bg-surface-light hover:bg-surface-lighter border border-border hover:border-border-light"
      >
        <Smartphone className="w-3.5 h-3.5" />
        Pair phone…
      </Button>
      {pairOpen && <PairPhoneModal onClose={() => setPairOpen(false)} />}
    </>
  );
}

function TabGroupsListSection({ tabGroups, tabGroupMap, onDeleteGroup, onSelect }: {
  tabGroups: Record<string, TabGroupInfo>;
  tabGroupMap: Record<string, string>;
  onDeleteGroup: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const entries = Object.values(tabGroups);
  const memberCount: Record<string, number> = {};
  for (const gid of Object.values(tabGroupMap)) memberCount[gid] = (memberCount[gid] || 0) + 1;

  return (
    <>
      <SectionHeader
        title="Tab groups"
        subtitle="All projects shown in the sidebar. Open one to edit its settings, or delete to ungroup its sessions (the sessions themselves are kept)."
      />
      {entries.length === 0 ? (
        <div className="text-[12px] text-zinc-500 bg-surface-light border border-border rounded-md px-3 py-3">
          No tab groups yet. Drag a tab onto another in the sidebar to create one.
        </div>
      ) : (
        <div className="space-y-1.5">
          {entries.map(g => {
            const count = memberCount[g.id] || 0;
            const dot = GROUP_DOT_COLOR[g.color] || 'bg-zinc-400';
            const Icon = g.icon ? ICON_MAP[g.icon] : null;
            const isConfirm = confirming === g.id;
            return (
              <div key={g.id} className="flex items-center gap-2.5 px-2.5 py-2 rounded-md bg-surface-light border border-border hover:border-border-light transition-colors">
                {Icon ? <Icon className="w-4 h-4 shrink-0 text-zinc-400" strokeWidth={1.75} />
                      : <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dot}`} />}
                <button
                  onClick={() => onSelect(g.id)}
                  className="flex-1 min-w-0 text-left"
                >
                  <div className="text-[12.5px] text-zinc-100 truncate">{g.name}</div>
                  <div className="text-[10.5px] text-zinc-500 font-mono truncate">
                    {g.cwd || '—'} · {count} session{count === 1 ? '' : 's'}
                  </div>
                </button>
                {isConfirm ? (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={() => setConfirming(null)} className="text-[11px] px-2 py-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-surface-lighter">Cancel</button>
                    <button
                      onClick={() => { onDeleteGroup(g.id); setConfirming(null); }}
                      className="text-[11px] px-2 py-1 rounded font-medium text-red-300 bg-red-500/15 hover:bg-red-500/25 border border-red-500/30"
                    >Delete</button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirming(g.id)}
                    aria-label="Delete group"
                    className="shrink-0 p-1.5 rounded text-zinc-500 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function GeneralSection({ autoGroupSessions, onToggleAutoGroup }: { autoGroupSessions: boolean; onToggleAutoGroup: (v: boolean) => void }) {
  return (
    <>
      <SectionHeader title="General" subtitle="App-wide behavior. Per-project overrides live under each project in the sidebar to the left." />
      <div className="space-y-3">
        <Switch
          isSelected={autoGroupSessions}
          onChange={onToggleAutoGroup}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md bg-surface-light border border-border hover:border-border-light transition-colors cursor-pointer"
        >
          <div className="flex-1 min-w-0 text-left">
            <div className="text-[12.5px] text-zinc-100">Auto-group new sessions</div>
            <div className="text-[11px] text-zinc-500 mt-0.5">Bucket new sessions into a tab group named after the project folder.</div>
          </div>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
      </div>
    </>
  );
}

function AboutSection() {
  return (
    <>
      <SectionHeader title="About" />
      <div className="space-y-2 text-[12.5px] text-zinc-400">
        <div>taskr · local Claude Code companion</div>
        <div className="text-zinc-500">
          Built on Electron + bun. Source at{' '}
          <a href="https://github.com" target="_blank" rel="noreferrer" className="text-zinc-300 underline">GitHub</a>.
        </div>
      </div>
    </>
  );
}

/* ============================================================
 *  Per-project panes
 * ============================================================ */

type ProjectTab = 'general' | 'defaults' | 'permissions' | 'environment' | 'mcp' | 'hooks' | 'sessions';

const PROJECT_TABS: { id: ProjectTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'defaults', label: 'Defaults' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'environment', label: 'Environment' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'sessions', label: 'Sessions' },
];

function ProjectGeneralPane({ group, onPatch }: { group: TabGroupInfo; onPatch: (patch: Partial<TabGroupInfo>) => void }) {
  const [name, setName] = useState(group.name);
  const [cwd, setCwd] = useState(group.cwd || '');
  const [iconPickerOpen, setIconPickerOpen] = useState(false);

  useEffect(() => { setName(group.name); setCwd(group.cwd || ''); }, [group.id]);

  const onNameBlur = () => { if (name.trim() && name.trim() !== group.name) onPatch({ name: name.trim() }); };
  const onCwdBlur = () => { const t = cwd.trim(); if (t !== (group.cwd || '')) onPatch({ cwd: t || undefined }); };

  return (
    <>
      <SectionHeader title="Project identity" subtitle="How this project appears in the sidebar and tab list." />
      <Field label="Name" hint="Shown in the tab group header.">
        <TextField value={name} onChange={setName} aria-label="Group name">
          <Input className="text-[12.5px]" onBlur={onNameBlur} onKeyDown={(e: any) => e.key === 'Enter' && onNameBlur()} />
        </TextField>
      </Field>

      <Field label="Working directory" hint="All sessions opened from this group default to this folder.">
        <div className="flex items-center gap-2">
          <TextField value={cwd} onChange={setCwd} aria-label="cwd" className="flex-1">
            <Input className="font-mono text-[12px]" onBlur={onCwdBlur} onKeyDown={(e: any) => e.key === 'Enter' && onCwdBlur()} placeholder="/Users/you/src/project" />
          </TextField>
          <button
            onClick={async () => {
              try {
                const electron = (window as any).electronAPI || (window as any).electron;
                if (electron?.pickFolder) {
                  const picked = await electron.pickFolder();
                  if (picked) { setCwd(picked); onPatch({ cwd: picked }); }
                }
              } catch {}
            }}
            className="text-[12px] px-3 py-1.5 rounded-md text-zinc-200 bg-surface-light hover:bg-surface-lighter border border-border hover:border-border-light"
          >
            Browse…
          </button>
        </div>
      </Field>

      <Field label="Color & icon" hint="Used for the group dot, tabs, and project chip.">
        <div className="flex items-center gap-4">
          <div className="flex gap-1.5">
            {GROUP_COLORS.map(c => (
              <button
                key={c}
                onClick={() => onPatch({ color: c })}
                aria-label={c}
                className={`w-6 h-6 rounded-full border-2 transition-shadow ${group.color === c ? 'border-zinc-100 shadow-[0_0_0_2px_var(--color-surface)_inset]' : 'border-transparent hover:border-zinc-700'}`}
                style={{ background: GROUP_HEX_COLOR[c] }}
              />
            ))}
          </div>
          <button
            onClick={() => setIconPickerOpen(v => !v)}
            className="w-9 h-9 rounded-md bg-surface-light border border-border hover:border-border-light flex items-center justify-center text-zinc-300"
            title="Pick icon"
          >
            {group.icon && ICON_MAP[group.icon]
              ? (() => { const Ico = ICON_MAP[group.icon!]; return <Ico className="w-4 h-4" strokeWidth={1.75} />; })()
              : <Folder className="w-4 h-4" strokeWidth={1.75} />}
          </button>
          {group.icon && (
            <button onClick={() => onPatch({ icon: undefined })} className="text-[11px] text-zinc-500 hover:text-zinc-300 underline">
              Clear icon
            </button>
          )}
        </div>

        {iconPickerOpen && (
          <div className="mt-3 p-3 bg-surface-light border border-border rounded-md">
            <div className="text-[10.5px] uppercase tracking-wider text-zinc-500 mb-2">Quick pick</div>
            <div className="grid grid-cols-12 gap-1.5">
              {Object.entries(ICON_MAP_QUICK).map(([key, Ico]) => (
                <button
                  key={key}
                  onClick={() => { onPatch({ icon: key }); setIconPickerOpen(false); }}
                  className={`w-7 h-7 rounded flex items-center justify-center hover:bg-surface-lighter border ${group.icon === key ? 'border-violet-500/50 bg-violet-500/10' : 'border-transparent'}`}
                  title={key}
                >
                  <Ico className="w-3.5 h-3.5 text-zinc-300" strokeWidth={1.75} />
                </button>
              ))}
            </div>
            <div className="text-[10.5px] uppercase tracking-wider text-zinc-500 mt-3 mb-2">All</div>
            <div className="grid grid-cols-12 gap-1.5 max-h-40 overflow-y-auto">
              {Object.entries(ICON_MAP).map(([key, Ico]) => (
                <button
                  key={key}
                  onClick={() => { onPatch({ icon: key }); setIconPickerOpen(false); }}
                  className={`w-7 h-7 rounded flex items-center justify-center hover:bg-surface-lighter border ${group.icon === key ? 'border-violet-500/50 bg-violet-500/10' : 'border-transparent'}`}
                  title={key}
                >
                  <Ico className="w-3.5 h-3.5 text-zinc-300" strokeWidth={1.75} />
                </button>
              ))}
            </div>
          </div>
        )}
      </Field>

      <Field label="Auto-claim new sessions" hint="Sessions opened inside this folder automatically join this group. Independent of the global auto-group toggle.">
        <Switch
          isSelected={!!group.autoClaim}
          onChange={(next) => onPatch({ autoClaim: next || undefined })}
          className="inline-flex items-center gap-3 px-3 py-2 rounded-md bg-surface-light border border-border cursor-pointer"
        >
          <span className="text-[12.5px] text-zinc-200">{group.autoClaim ? 'Enabled' : 'Disabled'}</span>
          <SwitchControl><SwitchThumb /></SwitchControl>
        </Switch>
      </Field>
    </>
  );
}

function ProjectDefaultsPane({ group, onPatch }: { group: TabGroupInfo; onPatch: (patch: Partial<TabGroupInfo>) => void }) {
  const [systemPrompt, setSystemPrompt] = useState(group.systemPromptAddition || '');
  useEffect(() => { setSystemPrompt(group.systemPromptAddition || ''); }, [group.id]);

  return (
    <>
      <SectionHeader title="Session defaults" subtitle="Applied when new sessions are spawned in this project. Each field overrides the global default." />

      <Field label="Model" hint="Default Claude model when starting a new session here.">
        <select
          value={group.defaultModel || ''}
          onChange={e => onPatch({ defaultModel: e.target.value || undefined })}
          className="w-full bg-surface-light border border-border rounded-md text-zinc-100 text-[12.5px] px-3 py-2 focus:outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20"
        >
          {MODEL_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <InheritNote
          overriding={!!group.defaultModel}
          fallback={MODEL_OPTIONS.find(o => o.id === 'claude-sonnet-4-6')!.label}
          onReset={() => onPatch({ defaultModel: undefined })}
        />
      </Field>

      <Field label="System prompt addition" hint="Prepended to every session opened in this project. Useful for project conventions or context Claude should always know.">
        <textarea
          value={systemPrompt}
          onChange={e => setSystemPrompt(e.target.value)}
          onBlur={() => { const v = systemPrompt.trim(); if (v !== (group.systemPromptAddition || '')) onPatch({ systemPromptAddition: v || undefined }); }}
          placeholder="Optional instructions for Claude when working in this folder."
          rows={5}
          className="w-full bg-surface-light border border-border rounded-md text-zinc-100 text-[12px] font-mono px-3 py-2.5 leading-relaxed resize-y focus:outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20"
        />
      </Field>

      <Field label="Default agent" hint="Auto-selected in the agent picker when starting a session here.">
        <select
          value={group.defaultAgent || ''}
          onChange={e => onPatch({ defaultAgent: e.target.value || undefined })}
          className="w-full bg-surface-light border border-border rounded-md text-zinc-100 text-[12.5px] px-3 py-2 focus:outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20"
        >
          {AGENT_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </Field>
    </>
  );
}

function ProjectPermissionsPane({ group, onPatch }: { group: TabGroupInfo; onPatch: (patch: Partial<TabGroupInfo>) => void }) {
  const rules = group.autoApproveRules || [];
  const [editing, setEditing] = useState<string | null>(null);
  const [draftTool, setDraftTool] = useState('');
  const [draftPatterns, setDraftPatterns] = useState('');

  const startAdd = () => {
    setEditing('__new__');
    setDraftTool('');
    setDraftPatterns('');
  };

  const startEdit = (rule: ProjectAutoApproveRule) => {
    setEditing(rule.id);
    setDraftTool(rule.tool);
    setDraftPatterns(rule.patterns.join(', '));
  };

  const commit = () => {
    const tool = draftTool.trim();
    if (!tool) { setEditing(null); return; }
    const patterns = draftPatterns.split(',').map(s => s.trim()).filter(Boolean);
    if (editing === '__new__') {
      const next: ProjectAutoApproveRule = { id: crypto.randomUUID(), tool, patterns };
      onPatch({ autoApproveRules: [...rules, next] });
    } else if (editing) {
      const next = rules.map(r => r.id === editing ? { ...r, tool, patterns } : r);
      onPatch({ autoApproveRules: next });
    }
    setEditing(null);
  };

  const remove = (id: string) => onPatch({ autoApproveRules: rules.filter(r => r.id !== id) });

  return (
    <>
      <SectionHeader
        title="Auto-approve rules"
        subtitle="Tools and commands allowed without prompting in this project. Read, Grep, and Glob are always allowed."
        action={
          <button onClick={startAdd} className="text-[12px] px-3 py-1.5 rounded-md text-zinc-200 bg-surface-light hover:bg-surface-lighter border border-border hover:border-border-light flex items-center gap-1.5">
            <Plus className="w-3 h-3" />
            Add rule
          </button>
        }
      />

      <div className="border border-border rounded-lg overflow-hidden">
        <div className="bg-surface-light px-3 py-2.5 border-b border-border flex items-center gap-2.5">
          <span className="w-7 h-7 rounded-md bg-surface-lighter flex items-center justify-center text-zinc-400">
            <ShieldCheck className="w-3.5 h-3.5" />
          </span>
          <div className="flex-1">
            <div className="text-[12.5px] text-zinc-200">Read, Grep, Glob</div>
            <div className="text-[10.5px] text-zinc-500 font-mono">— always allowed —</div>
          </div>
          <span className="text-[10.5px] text-zinc-600 uppercase tracking-wider">Locked</span>
        </div>

        {rules.length === 0 && editing !== '__new__' && (
          <div className="px-3 py-6 text-center text-[12px] text-zinc-500 bg-surface-light border-t border-border">
            No additional auto-approve rules. New sessions will prompt for every tool call outside the locked allowlist.
          </div>
        )}

        {rules.map(rule => (
          <div key={rule.id} className="px-3 py-2.5 bg-surface-light border-t border-border flex items-center gap-2.5">
            {editing === rule.id ? (
              <div className="flex-1 flex items-center gap-2">
                <input
                  value={draftTool}
                  onChange={e => setDraftTool(e.target.value)}
                  placeholder="Tool (Bash, Edit, …)"
                  className="w-40 bg-surface-lighter border border-border rounded px-2 py-1.5 text-[12px] font-mono text-zinc-100"
                />
                <input
                  value={draftPatterns}
                  onChange={e => setDraftPatterns(e.target.value)}
                  placeholder="bun run *, git status, src/**"
                  className="flex-1 bg-surface-lighter border border-border rounded px-2 py-1.5 text-[12px] font-mono text-zinc-100"
                />
                <button onClick={commit} className="text-[11px] px-2 py-1 rounded text-white bg-violet-600 hover:bg-violet-500">Save</button>
                <button onClick={() => setEditing(null)} className="text-[11px] px-2 py-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-surface-lighter">Cancel</button>
              </div>
            ) : (
              <>
                <span className="w-7 h-7 rounded-md bg-surface-lighter flex items-center justify-center text-zinc-400">
                  <Terminal className="w-3.5 h-3.5" />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] text-zinc-200">{rule.tool}</div>
                  <div className="text-[10.5px] text-zinc-500 font-mono truncate">
                    {rule.patterns.length > 0 ? rule.patterns.join(', ') : '— all —'}
                  </div>
                </div>
                <button onClick={() => startEdit(rule)} className="text-[11px] px-2 py-1 rounded text-zinc-300 hover:text-zinc-100 hover:bg-surface-lighter">Edit</button>
                <button onClick={() => remove(rule.id)} className="p-1.5 rounded text-zinc-500 hover:text-red-300 hover:bg-red-500/10" aria-label="Remove rule">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        ))}

        {editing === '__new__' && (
          <div className="px-3 py-2.5 bg-surface-light border-t border-border flex items-center gap-2">
            <input
              autoFocus
              value={draftTool}
              onChange={e => setDraftTool(e.target.value)}
              placeholder="Tool (Bash, Edit, …)"
              className="w-40 bg-surface-lighter border border-border rounded px-2 py-1.5 text-[12px] font-mono text-zinc-100"
            />
            <input
              value={draftPatterns}
              onChange={e => setDraftPatterns(e.target.value)}
              placeholder="Comma-separated patterns"
              className="flex-1 bg-surface-lighter border border-border rounded px-2 py-1.5 text-[12px] font-mono text-zinc-100"
            />
            <button onClick={commit} className="text-[11px] px-2 py-1 rounded text-white bg-violet-600 hover:bg-violet-500">Add</button>
            <button onClick={() => setEditing(null)} className="text-[11px] px-2 py-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-surface-lighter">Cancel</button>
          </div>
        )}
      </div>
    </>
  );
}

function ProjectEnvironmentPane({ group, onPatch }: { group: TabGroupInfo; onPatch: (patch: Partial<TabGroupInfo>) => void }) {
  const [rows, setRows] = useState<ProjectEnvVar[]>(group.envVars || []);
  useEffect(() => { setRows(group.envVars || []); }, [group.id]);

  const commit = (next: ProjectEnvVar[]) => {
    setRows(next);
    const cleaned = next.filter(r => r.key.trim());
    onPatch({ envVars: cleaned.length ? cleaned : undefined });
  };

  const updateRow = (i: number, patch: Partial<ProjectEnvVar>) => {
    const next = rows.map((r, idx) => idx === i ? { ...r, ...patch } : r);
    setRows(next);
  };

  const removeRow = (i: number) => {
    const next = rows.filter((_, idx) => idx !== i);
    commit(next);
  };

  const addRow = () => commit([...rows, { key: '', value: '' }]);

  return (
    <>
      <SectionHeader
        title="Environment variables"
        subtitle="Injected when launching Claude or terminal sessions inside this project. Overrides match by key."
      />

      <div className="grid grid-cols-[1fr_1.4fr_auto] gap-2 text-[10.5px] uppercase tracking-wider text-zinc-500 mb-2 px-2.5">
        <div>Key</div>
        <div>Value</div>
        <div />
      </div>

      {rows.length === 0 ? (
        <div className="text-[12px] text-zinc-500 bg-surface-light border border-border rounded-md px-3 py-4 text-center">
          No environment variables set for this project.
        </div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] gap-2 items-center">
              <input
                value={row.key}
                onChange={e => updateRow(i, { key: e.target.value })}
                onBlur={() => commit(rows)}
                placeholder="VARIABLE_NAME"
                className="bg-surface-light border border-border rounded px-2.5 py-2 text-[12px] font-mono text-zinc-100 focus:outline-none focus:border-violet-500"
              />
              <input
                value={row.value}
                onChange={e => updateRow(i, { value: e.target.value })}
                onBlur={() => commit(rows)}
                placeholder="value"
                className="bg-surface-light border border-border rounded px-2.5 py-2 text-[12px] font-mono text-zinc-100 focus:outline-none focus:border-violet-500"
              />
              <button onClick={() => removeRow(i)} className="p-1.5 rounded text-zinc-500 hover:text-red-300 hover:bg-red-500/10" aria-label="Remove">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <button onClick={addRow} className="mt-3 text-[12px] px-3 py-1.5 rounded-md text-zinc-200 bg-surface-light hover:bg-surface-lighter border border-border hover:border-border-light flex items-center gap-1.5">
        <Plus className="w-3 h-3" />
        Add variable
      </button>
    </>
  );
}

function ProjectMcpPane({ group, onPatch }: { group: TabGroupInfo; onPatch: (patch: Partial<TabGroupInfo>) => void }) {
  const disabled = new Set(group.mcpOverrides?.disabled || []);

  // For now, list global MCP servers as informational. Real server list could
  // come from the bun sidecar later — this is a placeholder showing the
  // shape the override storage takes.
  const KNOWN_SERVERS = [
    { name: 'chrome-devtools', kind: 'global', color: 'text-blue-400' },
    { name: 'codiby-code-sdk', kind: 'auto', color: 'text-emerald-400' },
    { name: 'Atlassian', kind: 'global', color: 'text-amber-400' },
    { name: 'Gmail', kind: 'global', color: 'text-rose-400' },
  ];

  const toggle = (name: string, next: boolean) => {
    const set = new Set(disabled);
    if (next) set.delete(name); else set.add(name);
    const list = Array.from(set);
    onPatch({ mcpOverrides: list.length ? { disabled: list } : undefined });
  };

  return (
    <>
      <SectionHeader
        title="MCP servers"
        subtitle="Enable specific MCP servers just for this project. Global servers stay available unless disabled here."
      />

      <div className="border border-border rounded-lg overflow-hidden">
        {KNOWN_SERVERS.map((srv, i) => {
          const enabled = !disabled.has(srv.name);
          return (
            <div key={srv.name} className={`flex items-center gap-3 px-3 py-2.5 bg-surface-light ${i > 0 ? 'border-t border-border' : ''}`}>
              <span className={`w-7 h-7 rounded-md bg-surface-lighter flex items-center justify-center ${srv.color}`}>
                <Server className="w-3.5 h-3.5" />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-zinc-200 font-mono">{srv.name}</div>
                <div className="text-[10.5px] text-zinc-500">
                  {srv.kind === 'auto' ? 'auto-launch · project-aware' : enabled ? 'global · enabled here' : 'global · disabled in this project'}
                </div>
              </div>
              <Switch isSelected={enabled} onChange={(v) => toggle(srv.name, v)} className="cursor-pointer">
                <SwitchControl><SwitchThumb /></SwitchControl>
              </Switch>
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-[11.5px] text-zinc-500">
        Project-only servers can be added via <code className="text-zinc-400">~/.codiby/plugins/</code>. Custom server entries from this UI are coming soon.
      </p>
    </>
  );
}

/** Editor for Claude Code's `hooks` block — works against the global
 *  ~/.claude/settings.json or a per-project <cwd>/.claude/settings.json,
 *  selected via the `scope` + `cwd` props. Loads on mount, autosaves on
 *  Save click, surfaces the on-disk path so the user knows what file
 *  they're touching. */
function HooksEditor({ scope, cwd, client }: { scope: HookScope; cwd?: string; client: ClaudeClient | null }) {
  const [loaded, setLoaded] = useState(false);
  const [path, setPath] = useState<string>('');
  const [exists, setExists] = useState(false);
  const [rows, setRows] = useState<HookRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false); setError(null); setDirty(false); setSaved(false);
    if (!client) return;
    if (scope === 'project' && !cwd) { setLoaded(true); return; }
    (async () => {
      try {
        const res = await client.getClaudeHooks(scope, cwd);
        if (cancelled) return;
        setPath(res.path);
        setExists(res.exists);
        setRows(flattenHooks(res.hooks));
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [scope, cwd, client]);

  const addRow = (event: HookEvent) => {
    setRows(prev => [...prev, { id: crypto.randomUUID(), event, matcher: '', command: '' }]);
    setDirty(true); setSaved(false);
  };
  const updateRow = (id: string, patch: Partial<HookRow>) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
    setDirty(true); setSaved(false);
  };
  const removeRow = (id: string) => {
    setRows(prev => prev.filter(r => r.id !== id));
    setDirty(true); setSaved(false);
  };

  const onSave = async () => {
    if (!client) return;
    setSaving(true); setError(null);
    try {
      const cleaned = rows.filter(r => r.command.trim());
      const nested = nestHooks(cleaned);
      const res = await client.setClaudeHooks(scope, cwd, nested);
      setPath(res.path);
      setExists(true);
      setRows(cleaned);
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (scope === 'project' && !cwd) {
    return (
      <div className="text-[12px] text-zinc-500 bg-surface-light border border-border rounded-md px-3 py-3">
        Set a working directory on this project to enable per-project hooks.
      </div>
    );
  }

  if (!loaded) return <div className="text-[12px] text-zinc-600">Loading…</div>;

  return (
    <>
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-mono text-zinc-500 break-all">{path}</p>
          {!exists && <p className="text-[11px] text-amber-400 mt-1">File doesn't exist yet — saving will create it.</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {dirty && <span className="text-[10.5px] uppercase tracking-wider text-amber-400">Unsaved</span>}
          <button
            onClick={onSave}
            disabled={!dirty || saving}
            className="text-[12px] px-3 py-1.5 rounded-md font-medium text-white bg-violet-600 hover:bg-violet-500 border border-violet-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : saved ? 'Saved' : 'Save hooks'}
          </button>
        </div>
      </div>

      {error && (
        <div className="text-[11.5px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2 mb-4 whitespace-pre-wrap">
          {error}
        </div>
      )}

      <div className="space-y-6">
        {HOOK_EVENTS.map(evt => {
          const eventRows = rows.filter(r => r.event === evt.id);
          return (
            <div key={evt.id}>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="text-[12.5px] font-medium text-zinc-100">{evt.label}</div>
                  <div className="text-[11px] text-zinc-500">{evt.hint}</div>
                </div>
                <button onClick={() => addRow(evt.id)} className="text-[11.5px] inline-flex items-center gap-1 px-2 py-1 rounded text-zinc-300 hover:text-zinc-100 hover:bg-surface-lighter">
                  <Plus className="w-3 h-3" />
                  Add
                </button>
              </div>

              {eventRows.length === 0 ? (
                <div className="text-[11.5px] text-zinc-600 bg-surface-light/40 border border-dashed border-border rounded-md px-3 py-2">
                  No {evt.label} hooks.
                </div>
              ) : (
                <div className="space-y-2">
                  {eventRows.map(row => (
                    <div key={row.id} className="bg-surface-light border border-border rounded-md p-2.5 space-y-2">
                      {evt.supportsMatcher && (
                        <div className="flex items-center gap-2">
                          <span className="text-[10.5px] uppercase tracking-wider text-zinc-500 w-16">Matcher</span>
                          <input
                            value={row.matcher}
                            onChange={e => updateRow(row.id, { matcher: e.target.value })}
                            placeholder="Bash, Edit, *  — blank = any"
                            className="flex-1 bg-surface-lighter border border-border rounded px-2.5 py-1.5 text-[12px] font-mono text-zinc-100 focus:outline-none focus:border-violet-500"
                          />
                        </div>
                      )}
                      <div className="flex items-start gap-2">
                        <span className="text-[10.5px] uppercase tracking-wider text-zinc-500 w-16 pt-2">Command</span>
                        <textarea
                          value={row.command}
                          onChange={e => updateRow(row.id, { command: e.target.value })}
                          placeholder="e.g. echo hook fired for $TOOL_NAME"
                          rows={Math.max(1, Math.min(4, row.command.split('\n').length))}
                          className="flex-1 bg-surface-lighter border border-border rounded px-2.5 py-1.5 text-[12px] font-mono text-zinc-100 focus:outline-none focus:border-violet-500 resize-y leading-relaxed"
                        />
                        <button onClick={() => removeRow(row.id)} className="p-1.5 rounded text-zinc-500 hover:text-red-300 hover:bg-red-500/10 mt-1" aria-label="Remove">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10.5px] uppercase tracking-wider text-zinc-500 w-16">Timeout</span>
                        <input
                          type="number"
                          value={row.timeout ?? ''}
                          onChange={e => updateRow(row.id, { timeout: e.target.value ? Number(e.target.value) : undefined })}
                          placeholder="seconds (optional)"
                          className="w-40 bg-surface-lighter border border-border rounded px-2.5 py-1.5 text-[12px] font-mono text-zinc-100 focus:outline-none focus:border-violet-500"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function ProjectHooksPane({ group, client }: { group: TabGroupInfo; client: ClaudeClient | null }) {
  return (
    <>
      <SectionHeader
        title="Hooks"
        subtitle={`Run shell commands before/after tool calls and session events. Edits go to ${group.cwd ? `${group.cwd}/.claude/settings.json` : 'this project’s .claude/settings.json'} — committable so the team uses the same hooks.`}
      />
      <HooksEditor scope="project" cwd={group.cwd} client={client} />
    </>
  );
}

function GlobalHooksSection({ client }: { client: ClaudeClient | null }) {
  return (
    <>
      <SectionHeader
        title="Hooks"
        subtitle="User-level hooks that run for every Claude session on this machine. Stored in ~/.claude/settings.json — the same file the Claude CLI reads."
      />
      <HooksEditor scope="global" client={client} />
    </>
  );
}

function GlobalEnvironmentSection({ envVars, onChange }: { envVars: ProjectEnvVar[]; onChange: (next: ProjectEnvVar[]) => void }) {
  const [rows, setRows] = useState<ProjectEnvVar[]>(envVars);
  useEffect(() => { setRows(envVars); }, [envVars]);

  const commit = (next: ProjectEnvVar[]) => {
    setRows(next);
    const cleaned = next.filter(r => r.key.trim());
    onChange(cleaned);
  };
  const updateRow = (i: number, patch: Partial<ProjectEnvVar>) => setRows(rows.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  return (
    <>
      <SectionHeader
        title="Environment variables"
        subtitle="Injected on top of process.env into every Bash tool call and terminal Claude or you open. Per-project envs are layered on top of these and win on conflict."
      />

      <div className="grid grid-cols-[1fr_1.4fr_auto] gap-2 text-[10.5px] uppercase tracking-wider text-zinc-500 mb-2 px-2.5">
        <div>Key</div>
        <div>Value</div>
        <div />
      </div>

      {rows.length === 0 ? (
        <div className="text-[12px] text-zinc-500 bg-surface-light border border-border rounded-md px-3 py-4 text-center">
          No global env vars set. Add API keys, NODE_OPTIONS, etc. that every shell should see.
        </div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] gap-2 items-center">
              <input
                value={row.key}
                onChange={e => updateRow(i, { key: e.target.value })}
                onBlur={() => commit(rows)}
                placeholder="VARIABLE_NAME"
                className="bg-surface-light border border-border rounded px-2.5 py-2 text-[12px] font-mono text-zinc-100 focus:outline-none focus:border-violet-500"
              />
              <input
                value={row.value}
                onChange={e => updateRow(i, { value: e.target.value })}
                onBlur={() => commit(rows)}
                placeholder="value"
                className="bg-surface-light border border-border rounded px-2.5 py-2 text-[12px] font-mono text-zinc-100 focus:outline-none focus:border-violet-500"
              />
              <button onClick={() => commit(rows.filter((_, idx) => idx !== i))} className="p-1.5 rounded text-zinc-500 hover:text-red-300 hover:bg-red-500/10" aria-label="Remove">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={() => commit([...rows, { key: '', value: '' }])}
        className="mt-3 text-[12px] px-3 py-1.5 rounded-md text-zinc-200 bg-surface-light hover:bg-surface-lighter border border-border hover:border-border-light flex items-center gap-1.5"
      >
        <Plus className="w-3 h-3" />
        Add variable
      </button>
    </>
  );
}

function ProjectSessionsPane({ group, tabGroupMap }: { group: TabGroupInfo; tabGroupMap: Record<string, string> }) {
  const memberIds = useMemo(
    () => Object.entries(tabGroupMap).filter(([, gid]) => gid === group.id).map(([sid]) => sid),
    [tabGroupMap, group.id],
  );
  return (
    <>
      <SectionHeader title="Sessions" subtitle={`${memberIds.length} session${memberIds.length === 1 ? '' : 's'} currently belong to this project.`} />
      {memberIds.length === 0 ? (
        <div className="text-[12px] text-zinc-500 bg-surface-light border border-border rounded-md px-3 py-4 text-center">
          No sessions in this project yet. Open one from the sidebar.
        </div>
      ) : (
        <div className="space-y-1.5">
          {memberIds.map(sid => (
            <div key={sid} className="flex items-center gap-3 px-3 py-2 rounded-md bg-surface-light border border-border">
              <Pin className="w-3.5 h-3.5 text-zinc-500" />
              <div className="flex-1 min-w-0 text-[12px] font-mono text-zinc-300 truncate">{sid}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* ============================================================
 *  Sidebar nav
 * ============================================================ */

function NavLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="px-2.5 pt-3 pb-1.5 text-[10px] uppercase tracking-[0.1em] text-zinc-500 flex items-center justify-between">
      <span>{children}</span>
      {action}
    </div>
  );
}

function NavItem({ icon, label, active, badge, onClick }: { icon: ReactNode; label: string; active?: boolean; badge?: ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2.5 py-1.5 my-px rounded-md text-[12.5px] border transition-colors text-left ${
        active
          ? 'bg-surface-lighter text-zinc-100 border-border-light'
          : 'text-zinc-400 hover:text-zinc-200 hover:bg-surface-light border-transparent'
      }`}
    >
      <span className={`w-3.5 h-3.5 shrink-0 ${active ? 'text-zinc-300' : 'text-zinc-500'}`}>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {badge}
    </button>
  );
}

function NavProject({ group, memberCount, active, onClick }: { group: TabGroupInfo; memberCount: number; active: boolean; onClick: () => void }) {
  const Icon = group.icon ? ICON_MAP[group.icon] : null;
  const hex = GROUP_HEX_COLOR[group.color] || '#a78bfa';
  return (
    <button
      onClick={onClick}
      className={`w-full grid grid-cols-[14px_1fr_auto] items-center gap-2 px-2.5 py-1.5 my-px rounded-md border transition-colors text-left ${
        active
          ? 'bg-violet-500/10 border-violet-500/30'
          : 'border-transparent hover:bg-surface-light'
      }`}
    >
      {Icon
        ? <Icon className="w-3.5 h-3.5 text-zinc-400" strokeWidth={1.75} />
        : <span className="w-2 h-2 rounded-full" style={{ background: hex }} />}
      <span className="min-w-0 flex flex-col">
        <span className={`text-[12.5px] leading-tight truncate ${active ? 'text-zinc-100' : 'text-zinc-200'}`}>{group.name}</span>
        <span className="text-[10px] font-mono text-zinc-500 truncate">{group.cwd || '—'}</span>
      </span>
      <span className="text-[9.5px] tracking-wide bg-surface-lighter text-zinc-400 px-1.5 py-0.5 rounded">{memberCount}</span>
    </button>
  );
}

/* ============================================================
 *  Modal shell
 * ============================================================ */

export function ProjectSettingsModal({
  open, onClose, tabGroups, tabGroupMap,
  autoGroupSessions, onToggleAutoGroup,
  showTelegramSession, onToggleShowTelegramSession,
  globalEnvVars, onChangeGlobalEnvVars,
  client,
  onDeleteGroup, onPatchGroup,
}: ProjectSettingsModalProps) {
  const [selected, setSelected] = useState<SelectedNav>({ kind: 'global', id: 'general' });
  const [projectTab, setProjectTab] = useState<ProjectTab>('general');
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => { resolveServerUrl().then(setServerUrl); }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Reset project tab when switching projects so we always land on General.
  useEffect(() => { if (selected.kind === 'project') setProjectTab('general'); }, [selected.kind === 'project' ? selected.id : null]);

  const memberCount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const gid of Object.values(tabGroupMap)) m[gid] = (m[gid] || 0) + 1;
    return m;
  }, [tabGroupMap]);

  const projectEntries = useMemo(() => Object.values(tabGroups), [tabGroups]);

  if (!open) return null;

  const handleSelectProject = (id: string) => setSelected({ kind: 'project', id });

  const activeProject = selected.kind === 'project' ? tabGroups[selected.id] : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={onClose} aria-hidden />

      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-settings-title"
        className="relative w-full max-w-[1180px] h-full max-h-[780px] bg-surface border border-border rounded-xl shadow-[0_30px_80px_rgba(0,0,0,0.55)] grid grid-rows-[44px_1fr_52px] overflow-hidden"
      >
        {/* Titlebar */}
        <div className="flex items-center justify-between px-4 border-b border-border bg-gradient-to-b from-white/[0.02] to-transparent">
          <h1 id="project-settings-title" className="m-0 text-[13px] font-semibold flex items-center gap-2 text-zinc-100">
            <SettingsIcon className="w-3.5 h-3.5 text-zinc-400" strokeWidth={1.75} />
            Settings
            <span className="text-zinc-600 font-normal mx-1">/</span>
            <span className="text-zinc-300 font-medium">
              {selected.kind === 'project' ? (activeProject?.name || 'Project') : 'Global'}
            </span>
          </h1>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-zinc-500">
              Press <kbd className="bg-surface-lighter border border-border border-b-2 rounded px-1.5 py-px text-[10.5px] font-mono text-zinc-400">Esc</kbd> to close
            </span>
            <button onClick={onClose} aria-label="Close" className="w-7 h-7 inline-flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-100 hover:bg-surface-lighter">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Body: sidebar + content */}
        <div className="grid grid-cols-[240px_1fr] min-h-0">
          {/* Sidebar */}
          <aside className="bg-base border-r border-border overflow-y-auto py-2 px-2">
            <NavLabel>Global</NavLabel>
            <NavItem icon={<SettingsIcon className="w-3.5 h-3.5" strokeWidth={1.75} />} label="General" active={selected.kind === 'global' && selected.id === 'general'} onClick={() => setSelected({ kind: 'global', id: 'general' })} />
            <NavItem icon={<Send className="w-3.5 h-3.5" strokeWidth={1.75} />} label="Telegram Bot" active={selected.kind === 'global' && selected.id === 'telegram'} onClick={() => setSelected({ kind: 'global', id: 'telegram' })} />
            <NavItem icon={<Mic className="w-3.5 h-3.5" strokeWidth={1.75} />} label="Deepgram (Voice)" active={selected.kind === 'global' && selected.id === 'deepgram'} onClick={() => setSelected({ kind: 'global', id: 'deepgram' })} />
            <NavItem icon={<Globe className="w-3.5 h-3.5" strokeWidth={1.75} />} label="Tailscale Funnel" active={selected.kind === 'global' && selected.id === 'tailscale'} onClick={() => setSelected({ kind: 'global', id: 'tailscale' })} />
            <NavItem icon={<Smartphone className="w-3.5 h-3.5" strokeWidth={1.75} />} label="Mobile Pairing" active={selected.kind === 'global' && selected.id === 'mobile'} onClick={() => setSelected({ kind: 'global', id: 'mobile' })} />
            <NavItem icon={<ArrowRight className="w-3.5 h-3.5" strokeWidth={1.75} />} label="Remote Workstations" active={selected.kind === 'global' && selected.id === 'remotes'} onClick={() => setSelected({ kind: 'global', id: 'remotes' })} />
            <NavItem icon={<Plug className="w-3.5 h-3.5" strokeWidth={1.75} />} label="Plugins" active={selected.kind === 'global' && selected.id === 'plugins'} onClick={() => setSelected({ kind: 'global', id: 'plugins' })} />
            <NavItem icon={<Zap className="w-3.5 h-3.5" strokeWidth={1.75} />} label="Hooks" active={selected.kind === 'global' && selected.id === 'hooks'} onClick={() => setSelected({ kind: 'global', id: 'hooks' })} />
            <NavItem icon={<Variable className="w-3.5 h-3.5" strokeWidth={1.75} />} label="Environment" active={selected.kind === 'global' && selected.id === 'environment'} onClick={() => setSelected({ kind: 'global', id: 'environment' })} />

            <NavLabel>
              Projects
            </NavLabel>
            {projectEntries.length === 0 ? (
              <div className="px-2.5 py-2 text-[11.5px] text-zinc-500">
                No projects yet. Drag tabs together in the sidebar to create one.
              </div>
            ) : (
              projectEntries.map(g => (
                <NavProject
                  key={g.id}
                  group={g}
                  memberCount={memberCount[g.id] || 0}
                  active={selected.kind === 'project' && selected.id === g.id}
                  onClick={() => handleSelectProject(g.id)}
                />
              ))
            )}

            <NavLabel>Other</NavLabel>
            <NavItem icon={<Folder className="w-3.5 h-3.5" strokeWidth={1.75} />} label="Tab Groups" active={selected.kind === 'global' && selected.id === 'tab-groups'} onClick={() => setSelected({ kind: 'global', id: 'tab-groups' })} />
            <NavItem icon={<ExternalLink className="w-3.5 h-3.5" strokeWidth={1.75} />} label="About" active={selected.kind === 'global' && selected.id === 'about'} onClick={() => setSelected({ kind: 'global', id: 'about' })} />
          </aside>

          {/* Content */}
          <main className="overflow-y-auto bg-surface relative">
            {selected.kind === 'project' && activeProject
              ? (
                <ProjectContent
                  group={activeProject}
                  tab={projectTab}
                  onTabChange={setProjectTab}
                  onPatch={(patch) => onPatchGroup(activeProject.id, patch)}
                  onDelete={() => { onDeleteGroup(activeProject.id); setSelected({ kind: 'global', id: 'tab-groups' }); }}
                  tabGroupMap={tabGroupMap}
                  memberCount={memberCount[activeProject.id] || 0}
                  client={client}
                />
              )
              : (
                <GlobalContent
                  section={selected.kind === 'global' ? selected.id : 'general'}
                  serverUrl={serverUrl}
                  tabGroups={tabGroups}
                  tabGroupMap={tabGroupMap}
                  autoGroupSessions={autoGroupSessions}
                  onToggleAutoGroup={onToggleAutoGroup}
                  showTelegramSession={showTelegramSession}
                  onToggleShowTelegramSession={onToggleShowTelegramSession}
                  globalEnvVars={globalEnvVars}
                  onChangeGlobalEnvVars={onChangeGlobalEnvVars}
                  client={client}
                  onDeleteGroup={onDeleteGroup}
                  onSelectGroup={handleSelectProject}
                />
              )}
          </main>
        </div>

        {/* Modal footer — attached to the bottom of the modal, outside the
         *  scrolling content. */}
        <div className="flex items-center justify-between px-6 bg-base border-t border-border">
          <span className="text-[11.5px] text-zinc-500 inline-flex items-center gap-1.5">
            <Check className="w-3 h-3 text-emerald-400" />
            All changes saved
          </span>
          <button onClick={onClose} className="text-[12.5px] px-4 py-1.5 rounded-md font-medium text-white bg-violet-600 hover:bg-violet-500 border border-violet-600">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/* Global content router (right pane when no project selected) */
function GlobalContent({ section, serverUrl, tabGroups, tabGroupMap, autoGroupSessions, onToggleAutoGroup, showTelegramSession, onToggleShowTelegramSession, globalEnvVars, onChangeGlobalEnvVars, client, onDeleteGroup, onSelectGroup }: {
  section: GlobalSection;
  serverUrl: string | null;
  tabGroups: Record<string, TabGroupInfo>;
  tabGroupMap: Record<string, string>;
  autoGroupSessions: boolean;
  onToggleAutoGroup: (v: boolean) => void;
  showTelegramSession: boolean;
  onToggleShowTelegramSession: (v: boolean) => void;
  globalEnvVars: ProjectEnvVar[];
  onChangeGlobalEnvVars: (next: ProjectEnvVar[]) => void;
  client: ClaudeClient | null;
  onDeleteGroup: (id: string) => void;
  onSelectGroup: (id: string) => void;
}) {
  return (
    <div className="px-8 pt-6 pb-8">
      {section === 'general'     && <GeneralSection autoGroupSessions={autoGroupSessions} onToggleAutoGroup={onToggleAutoGroup} />}
      {section === 'telegram'    && <TelegramSection serverUrl={serverUrl} showTelegramSession={showTelegramSession} onToggleShowTelegramSession={onToggleShowTelegramSession} />}
      {section === 'deepgram'    && <DeepgramSection serverUrl={serverUrl} />}
      {section === 'tailscale'   && <TailscaleSection serverUrl={serverUrl} />}
      {section === 'mobile'      && <MobileSection />}
      {section === 'remotes'     && <RemotesSection serverUrl={serverUrl} />}
      {section === 'plugins'     && <PluginsContent />}
      {section === 'hooks'       && <GlobalHooksSection client={client} />}
      {section === 'environment' && <GlobalEnvironmentSection envVars={globalEnvVars} onChange={onChangeGlobalEnvVars} />}
      {section === 'tab-groups'  && <TabGroupsListSection tabGroups={tabGroups} tabGroupMap={tabGroupMap} onDeleteGroup={onDeleteGroup} onSelect={onSelectGroup} />}
      {section === 'about'       && <AboutSection />}
    </div>
  );
}

function PluginsContent() {
  return (
    <>
      <SectionHeader title="Plugins" subtitle="Sideloaded plugins from ~/.codiby/plugins/. Each plugin can contribute its own settings section below." />
      <div className="space-y-6">
        <PluginSettingsSections />
      </div>
    </>
  );
}

/* Project content (right pane when a project is selected) */
function ProjectContent({ group, tab, onTabChange, onPatch, onDelete, tabGroupMap, memberCount, client }: {
  group: TabGroupInfo;
  tab: ProjectTab;
  onTabChange: (t: ProjectTab) => void;
  onPatch: (patch: Partial<TabGroupInfo>) => void;
  onDelete: () => void;
  tabGroupMap: Record<string, string>;
  memberCount: number;
  client: ClaudeClient | null;
}) {
  const hex = GROUP_HEX_COLOR[group.color] || '#a78bfa';
  const Icon = group.icon ? ICON_MAP[group.icon] : Folder;
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="px-8 pt-6 pb-8">
      {/* Page header */}
      <div className="flex items-center justify-between gap-4 pb-4 border-b border-border mb-5">
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center text-white shrink-0"
            style={{ background: `linear-gradient(135deg, ${hex}, ${shade(hex, -30)})` }}
          >
            <Icon className="w-4 h-4" strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <h2 className="m-0 text-[18px] font-semibold text-zinc-100 truncate">{group.name}</h2>
            <div className="text-[12px] text-zinc-500 font-mono truncate">
              {group.cwd || '—'} · {memberCount} session{memberCount === 1 ? '' : 's'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={async () => {
              try {
                const electron = (window as any).electronAPI || (window as any).electron;
                if (electron?.openPath && group.cwd) await electron.openPath(group.cwd);
              } catch {}
            }}
            className="text-[11.5px] inline-flex items-center gap-1.5 px-2 py-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-surface-lighter"
          >
            <ExternalLink className="w-3 h-3" />
            Open in Finder
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0.5 border-b border-border mb-5 -mt-1">
        {PROJECT_TABS.map(t => (
          <button
            key={t.id}
            onClick={() => onTabChange(t.id)}
            className={`px-3 py-2 text-[12.5px] -mb-px border-b-2 transition-colors ${
              tab === t.id
                ? 'text-zinc-100 border-violet-500'
                : 'text-zinc-500 border-transparent hover:text-zinc-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Pane */}
      {tab === 'general'     && <ProjectGeneralPane group={group} onPatch={onPatch} />}
      {tab === 'defaults'    && <ProjectDefaultsPane group={group} onPatch={onPatch} />}
      {tab === 'permissions' && <ProjectPermissionsPane group={group} onPatch={onPatch} />}
      {tab === 'environment' && <ProjectEnvironmentPane group={group} onPatch={onPatch} />}
      {tab === 'mcp'         && <ProjectMcpPane group={group} onPatch={onPatch} />}
      {tab === 'hooks'       && <ProjectHooksPane group={group} client={client} />}
      {tab === 'sessions'    && <ProjectSessionsPane group={group} tabGroupMap={tabGroupMap} />}

      {/* Danger zone (always present, at the bottom) */}
      {tab === 'general' && (
        <div className="mt-8 border border-red-500/25 rounded-lg p-4 bg-red-500/[0.04]">
          <h4 className="m-0 text-[13px] font-semibold text-red-400 mb-1">Danger zone</h4>
          <p className="text-[12px] text-zinc-400 mb-3">
            Deleting this project ungroups its sessions and clears the per-project overrides — the sessions themselves are kept.
          </p>
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <button onClick={onDelete} className="text-[12px] px-3 py-1.5 rounded-md font-medium text-white bg-red-600 hover:bg-red-500">
                Yes, delete "{group.name}"
              </button>
              <button onClick={() => setConfirmDelete(false)} className="text-[12px] px-3 py-1.5 rounded-md text-zinc-300 hover:text-zinc-100 hover:bg-surface-lighter">
                Cancel
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirmDelete(true)} className="text-[12px] px-3 py-1.5 rounded-md text-red-300 bg-transparent border border-red-500/30 hover:bg-red-500/10">
              Delete project
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* Lighten/darken a hex color by `amount` percent (-100..100). */
function shade(hex: string, amount: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  let r = (num >> 16) + Math.round(255 * amount / 100);
  let g = ((num >> 8) & 0xff) + Math.round(255 * amount / 100);
  let b = (num & 0xff) + Math.round(255 * amount / 100);
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}
