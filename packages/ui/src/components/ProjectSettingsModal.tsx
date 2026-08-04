import { useEffect, useMemo, useState, useRef, type ReactNode } from 'react';
import {
  X, Settings as SettingsIcon, Folder, Send, Mic, Smartphone, Plug,
  ArrowRight, Pin, ExternalLink, Plus, Trash2, Check, Terminal,
  ShieldCheck, Globe, Server, Zap, Variable,
  ChevronRight, Copy, RefreshCw, Webhook, Play, Square, ScanLine,
} from 'lucide-react';
import { Button, TextField, Input, Switch, SwitchControl, SwitchThumb } from '@heroui/react';
import {
  resolveServerUrl,
  type ClaudeClient,
  type HookScope,
  type HookEvent,
  type HookEntry,
  type ClaudeHooks,
  type PortlessActionStatus,
  type PortlessCliStatus,
} from '../lib/claude-client';
import { PairPhoneModal } from './PairPhoneModal';
import { PluginSettingsSections } from './PluginExtensionPoints';
import { RemotesSection } from './RemotesSection';
import { ICON_MAP, ICON_MAP_QUICK } from '../lib/group-icons';
import { resolveGroupColor } from '../lib/group-tree';
import {
  GROUP_COLORS, GROUP_HEX_COLOR, GROUP_DOT_COLOR,
  type TabGroupInfo,
  type ProjectEnvVar,
  type ProjectAutoApproveRule,
  type PortlessAction,
  type PortlessConfig,
  type PortlessExport,
  type PortlessExportFormat,
} from '../lib/tab-groups';

interface ProjectSettingsModalProps {
  open: boolean;
  onClose: () => void;
  tabGroups: Record<string, TabGroupInfo>;
  tabGroupMap: Record<string, string>;
  autoGroupSessions: boolean;
  onToggleAutoGroup: (next: boolean) => void;
  groupSessionsByWorktree: boolean;
  onToggleGroupByWorktree: (next: boolean) => void;
  autoFocusBrowserOnAction: boolean;
  onToggleAutoFocusBrowserOnAction: (next: boolean) => void;
  interruptOnSend: boolean;
  onToggleInterruptOnSend: (next: boolean) => void;
  colorChatBySession: boolean;
  onToggleColorChatBySession: (next: boolean) => void;
  tintChatBackground: boolean;
  onToggleTintChatBackground: (next: boolean) => void;
  showTelegramSession: boolean;
  onToggleShowTelegramSession: (next: boolean) => void;
  globalEnvVars: ProjectEnvVar[];
  onChangeGlobalEnvVars: (next: ProjectEnvVar[]) => void;
  /** Global Portless TLD (e.g. "localhost", "test") — applies project-wide
   *  because portless's proxy serves one TLD at a time. */
  portlessTld: string;
  onChangePortlessTld: (next: string) => void;
  /** Needed for the hooks editor to call getClaudeHooks/setClaudeHooks. */
  client: ClaudeClient | null;
  /** Cross-session snapshot of the Claude Agent SDK's supportedModels(). The
   *  "Default model" picker reads from this — the SDK is the only source of
   *  truth, no hardcoded list. Empty array on first launch before any Claude
   *  session has booted; the picker degrades to just the inherit option. */
  claudeModels: { id: string; label: string }[];
  onDeleteGroup: (groupId: string) => void;
  onPatchGroup: (groupId: string, patch: Partial<TabGroupInfo>) => void;
  /** The currently-focused session's working directory — i.e. where the user
   *  actually opened the session. When this session belongs to the project
   *  whose action is being run, actions spawn here instead of the group's root
   *  checkout, so a session opened in a git worktree runs the worktree's branch
   *  rather than the main repo. */
  activeSessionCwd?: string;
  /** The group the focused session belongs to. Used to confirm the session and
   *  the action's project are the same before honoring `activeSessionCwd`. */
  activeSessionGroupId?: string;
}

type GlobalSection =
  | 'general'
  | 'telegram'
  | 'deepgram'
  | 'tailscale'
  | 'portless'
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

const INHERIT_OPTION = { id: '', label: '— Use global default —' };

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
            const dot = GROUP_DOT_COLOR[resolveGroupColor(tabGroups, g.id, '')] || 'bg-zinc-400';
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

/** Two-message mock of a focus-mode pane, used to preview the
 *  "color chat by session" toggle. When `accent` is null it renders the
 *  default (untinted) look; otherwise it tints the frame, header and the
 *  user bubble with the accent, mirroring the real panes. */
function ChatColorPreview({ accent, tintBackground }: { accent: string | null; tintBackground?: boolean }) {
  return (
    <div
      style={accent ? { borderColor: `${accent}55` } : undefined}
      className={`rounded-lg border overflow-hidden ${accent ? '' : 'border-border bg-base'}`}
    >
      {accent && <div className="h-0.5" style={{ backgroundColor: accent }} />}
      <div className="flex items-center gap-2 px-2.5 h-7 border-b border-border/60">
        {accent && <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: accent }} />}
        <span className="text-[11px] text-zinc-300 font-medium">Partner-mapping</span>
        <span className="ml-auto text-[10px] text-zinc-600 font-mono">~/src/up</span>
      </div>
      <div
        className="px-3 py-2.5 space-y-2"
        style={accent && tintBackground ? { backgroundColor: `${accent}0d` } : undefined}
      >
        <p className="text-[12px] text-zinc-300 leading-relaxed">Sure — I’ll wire up the mapping sync now.</p>
        <div className="flex justify-end">
          <div
            style={accent ? { backgroundColor: `${accent}26` } : undefined}
            className={`max-w-[80%] rounded-2xl rounded-br-sm px-3 py-1.5 ${accent ? '' : 'bg-blue-600/15'}`}
          >
            <span className="text-[12px] text-zinc-200 leading-relaxed">Perfect, go ahead.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function GeneralSection({
  autoGroupSessions,
  onToggleAutoGroup,
  groupSessionsByWorktree,
  onToggleGroupByWorktree,
  autoFocusBrowserOnAction,
  onToggleAutoFocusBrowserOnAction,
  interruptOnSend,
  onToggleInterruptOnSend,
  colorChatBySession,
  onToggleColorChatBySession,
  tintChatBackground,
  onToggleTintChatBackground,
}: {
  autoGroupSessions: boolean;
  onToggleAutoGroup: (v: boolean) => void;
  groupSessionsByWorktree: boolean;
  onToggleGroupByWorktree: (v: boolean) => void;
  autoFocusBrowserOnAction: boolean;
  onToggleAutoFocusBrowserOnAction: (v: boolean) => void;
  interruptOnSend: boolean;
  onToggleInterruptOnSend: (v: boolean) => void;
  colorChatBySession: boolean;
  onToggleColorChatBySession: (v: boolean) => void;
  tintChatBackground: boolean;
  onToggleTintChatBackground: (v: boolean) => void;
}) {
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
        <Switch
          isSelected={groupSessionsByWorktree}
          onChange={onToggleGroupByWorktree}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md bg-surface-light border border-border hover:border-border-light transition-colors cursor-pointer"
        >
          <div className="flex-1 min-w-0 text-left">
            <div className="text-[12.5px] text-zinc-100">Group sessions by worktree</div>
            <div className="text-[11px] text-zinc-500 mt-0.5">Inside a project, sessions that share a working directory collapse under a folder named after it — the branch for a linked worktree, "main" for the repo itself. Needs two or more sessions on the same checkout; it dissolves on its own below that. Off: every session stays a direct child of its project.</div>
          </div>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
        <Switch
          isSelected={autoFocusBrowserOnAction}
          onChange={onToggleAutoFocusBrowserOnAction}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md bg-surface-light border border-border hover:border-border-light transition-colors cursor-pointer"
        >
          <div className="flex-1 min-w-0 text-left">
            <div className="text-[12.5px] text-zinc-100">Bring browser preview to front on agent actions</div>
            <div className="text-[11px] text-zinc-500 mt-0.5">When the agent clicks, types, scrolls, or navigates in a browser preview that isn't the active tab, switch to it so you see what's happening. Observational tools (snapshot, screenshot, evaluate, network/console reads) never trigger this.</div>
          </div>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
        <Switch
          isSelected={interruptOnSend}
          onChange={onToggleInterruptOnSend}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md bg-surface-light border border-border hover:border-border-light transition-colors cursor-pointer"
        >
          <div className="flex-1 min-w-0 text-left">
            <div className="text-[12.5px] text-zinc-100">Interrupt the agent when sending a new message</div>
            <div className="text-[11px] text-zinc-500 mt-0.5">If the agent is still working when you hit Enter, cancel the current turn and send your message right away. Off: the message waits in a queue and ships once the current turn finishes.</div>
          </div>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
        <div className="rounded-md bg-surface-light border border-border">
          <Switch
            isSelected={colorChatBySession}
            onChange={onToggleColorChatBySession}
            className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-surface-lighter/40 transition-colors cursor-pointer rounded-t-md"
          >
            <div className="flex-1 min-w-0 text-left">
              <div className="text-[12.5px] text-zinc-100">Color chat by session</div>
              <div className="text-[11px] text-zinc-500 mt-0.5">Give each session an accent color that tints its chat (message cards + background) in both the standard and Chat Focus layouts. Sessions inherit their group's color; set a per-session or per-group override from the right-click menu (or a pane header in focus mode).</div>
            </div>
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
          </Switch>
          {colorChatBySession && (
            <Switch
              isSelected={tintChatBackground}
              onChange={onToggleTintChatBackground}
              className="w-full flex items-center gap-3 px-3 py-2 border-t border-border hover:bg-surface-lighter/40 transition-colors cursor-pointer"
            >
              <div className="flex-1 min-w-0 text-left">
                <div className="text-[12px] text-zinc-200">Also tint the chat background</div>
                <div className="text-[11px] text-zinc-500 mt-0.5">Wash the whole chat area with the accent, not just the message cards.</div>
              </div>
              <SwitchControl>
                <SwitchThumb />
              </SwitchControl>
            </Switch>
          )}
          <div className="px-3 pb-3 pt-2">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1.5">Preview</div>
            <ChatColorPreview accent={colorChatBySession ? '#7c5cff' : null} tintBackground={tintChatBackground} />
          </div>
        </div>
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

type ProjectTab = 'general' | 'defaults' | 'permissions' | 'environment' | 'mcp' | 'hooks' | 'portless' | 'sessions';

const PROJECT_TABS: { id: ProjectTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'defaults', label: 'Defaults' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'environment', label: 'Environment' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'portless', label: 'Actions' },
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

      <Field label="Bring browser preview to front on agent actions" hint="Override the global default for this project. When the agent clicks/types/scrolls/navigates in a preview that isn't active, switch to it. Leave on 'Inherit' to use the global setting.">
        <select
          value={group.autoFocusBrowserOnAction === undefined ? 'inherit' : group.autoFocusBrowserOnAction ? 'on' : 'off'}
          onChange={(e) => {
            const v = e.target.value;
            onPatch({ autoFocusBrowserOnAction: v === 'inherit' ? undefined : v === 'on' });
          }}
          className="w-full bg-surface-light border border-border rounded-md text-zinc-100 text-[12.5px] px-3 py-2 focus:outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20"
        >
          <option value="inherit">Inherit (use global setting)</option>
          <option value="on">Always bring to front</option>
          <option value="off">Never bring to front</option>
        </select>
      </Field>
    </>
  );
}

function ProjectDefaultsPane({ group, onPatch, claudeModels }: { group: TabGroupInfo; onPatch: (patch: Partial<TabGroupInfo>) => void; claudeModels: { id: string; label: string }[] }) {
  const [systemPrompt, setSystemPrompt] = useState(group.systemPromptAddition || '');
  useEffect(() => { setSystemPrompt(group.systemPromptAddition || ''); }, [group.id]);

  // Currently-saved override always renders, even if the cache hasn't seen
  // it — otherwise editing an old project would silently drop the value.
  const overrideMissing = !!group.defaultModel && !claudeModels.some(m => m.id === group.defaultModel);
  const modelOptions = [
    INHERIT_OPTION,
    ...(overrideMissing ? [{ id: group.defaultModel!, label: group.defaultModel! }] : []),
    ...claudeModels,
  ];

  return (
    <>
      <SectionHeader title="Session defaults" subtitle="Applied when new sessions are spawned in this project. Each field overrides the global default." />

      <Field label="Model" hint="Default Claude model when starting a new session here.">
        <select
          value={group.defaultModel || ''}
          onChange={e => onPatch({ defaultModel: e.target.value || undefined })}
          className="w-full bg-surface-light border border-border rounded-md text-zinc-100 text-[12.5px] px-3 py-2 focus:outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20"
        >
          {modelOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <InheritNote
          overriding={!!group.defaultModel}
          fallback={claudeModels[0]?.label ?? 'global default'}
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

/** Global Portless settings — controls the system proxy (start/stop/mode)
 *  and the local CA trust. The proxy mode determines whether the user can
 *  visit `https://api.localhost` cleanly (HTTPS :443) or has to keep
 *  appending `:1355` (default mode). Privileged modes call sudo via
 *  osascript so the user sees a system password prompt. */
function PortlessProxySection({ client, tld, onChangeTld }: { client: ClaudeClient | null; tld: string; onChangeTld: (next: string) => void }) {
  const [tldDraft, setTldDraft] = useState(tld);
  useEffect(() => { setTldDraft(tld); }, [tld]);
  const [cli, setCli] = useState<{ available: boolean; bin: string | null; version: string | null } | null>(null);
  const [proxy, setProxy] = useState<{ running: boolean; port: number | null; mode: 'default' | 'http80' | 'https443' | null } | null>(null);
  const [busy, setBusy] = useState<null | 'start' | 'stop' | 'trust' | 'funnel'>(null);
  const [pickedMode, setPickedMode] = useState<'default' | 'http80' | 'https443'>('default');
  const [lastResult, setLastResult] = useState<{ ok: boolean; output: string; error?: string; conflict?: { port: number; funnelConflict: boolean } } | null>(null);

  const refresh = async () => {
    if (!client) return;
    const [c, p] = await Promise.all([
      client.getPortlessCliStatus(),
      client.getPortlessProxyStatus(),
    ]);
    setCli(c);
    setProxy(p);
    if (p.mode) setPickedMode(p.mode);
  };
  useEffect(() => { void refresh(); }, [client]);

  const onStart = async () => {
    if (!client) return;
    setBusy('start');
    setLastResult(null);
    try {
      const res = await client.startPortlessProxy(pickedMode);
      setLastResult(res);
    } finally {
      setBusy(null);
      void refresh();
    }
  };
  const onStop = async () => {
    if (!client) return;
    setBusy('stop');
    setLastResult(null);
    try {
      const res = await client.stopPortlessProxy();
      setLastResult(res);
    } finally {
      setBusy(null);
      void refresh();
    }
  };
  const onTrust = async () => {
    if (!client) return;
    setBusy('trust');
    setLastResult(null);
    try {
      const res = await client.trustPortlessCA();
      setLastResult(res);
    } finally {
      setBusy(null);
    }
  };
  const onDisableFunnelAndRetry = async () => {
    if (!client) return;
    setBusy('funnel');
    try {
      const res = await client.setTailscaleFunnel(false);
      if (!res.ok) {
        setLastResult({ ok: false, output: '', error: `Couldn't disable Funnel: ${res.error || 'unknown error'}` });
        return;
      }
    } finally {
      setBusy(null);
    }
    // :443 is free now — retry the privileged start that was blocked.
    await onStart();
  };

  const modeLabel = (m: 'default' | 'http80' | 'https443' | null) =>
    m === 'https443' ? 'HTTPS · :443'
    : m === 'http80' ? 'HTTP · :80'
    : m === 'default' ? 'HTTP · :1355 (default)'
    : 'unknown';

  return (
    <>
      <SectionHeader
        title="Portless proxy"
        subtitle="Configure where the local Portless reverse proxy listens. The default port 1355 doesn't need root but forces you to type the port at the end of every URL. HTTPS :443 (or HTTP :80) gives you clean URLs like `https://api.localhost` but requires admin to bind privileged ports."
        action={proxy?.running ? (
          <span className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            {modeLabel(proxy.mode)}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-zinc-500">
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
            stopped
          </span>
        )}
      />

      {cli && !cli.available && (
        <div className="text-[11.5px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2.5 mb-4">
          Portless CLI not found. Install with <code className="font-mono text-amber-200">npm install -g portless</code> and restart taskr.
        </div>
      )}

      <Field label="Current proxy" hint="Detected by probing :443, :80, then :1355.">
        <div className="text-[12px] text-zinc-200">
          {proxy?.running
            ? <>Running on port <code className="font-mono text-violet-300">{proxy.port}</code> · {modeLabel(proxy.mode)}</>
            : <span className="text-zinc-500 italic">Not running</span>}
        </div>
      </Field>

      <Field label="TLD" hint={<>Suffix every action's hostname uses (e.g. <code className="font-mono text-zinc-400">api.{tldDraft || 'localhost'}</code>). Portless serves one TLD at a time, so this is a global setting — not per-project.</> as unknown as string}>
        <div className="flex items-center gap-2">
          <span className="text-zinc-600 font-mono text-[12px]">.</span>
          <input
            value={tldDraft}
            onChange={e => setTldDraft(e.target.value.toLowerCase().replace(/[^a-z]/g, ''))}
            onBlur={() => { if (tldDraft !== tld) onChangeTld(tldDraft || 'localhost'); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
            placeholder="localhost"
            className="w-48 px-2.5 py-1.5 rounded bg-surface-light border border-border focus:border-violet-500 font-mono text-[12px] text-zinc-100 outline-none"
          />
          <span className="text-[11px] text-zinc-500">
            {tldDraft === 'localhost'
              ? '(default — browsers resolve *.localhost automatically)'
              : '(may require dnsmasq or /etc/hosts setup)'}
          </span>
        </div>
      </Field>

      <Field label="Mode" hint="Pick how the proxy listens. Privileged modes prompt for your admin password.">
        <div className="space-y-1.5">
          {[
            { id: 'default' as const,  label: 'Default · port 1355',       caption: 'No sudo. URLs require the :1355 suffix.' },
            { id: 'http80'  as const,  label: 'HTTP · port 80',            caption: 'Requires admin. Clean URLs but no HTTPS.' },
            { id: 'https443' as const, label: 'HTTPS · port 443 (recommended)', caption: 'Requires admin. Clean URLs with HTTPS — pair with "Trust CA" so browsers stop warning.' },
          ].map(opt => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setPickedMode(opt.id)}
              className={`w-full flex items-start gap-3 px-3 py-2 rounded-md border text-left transition-colors ${
                pickedMode === opt.id
                  ? 'border-violet-500/50 bg-violet-500/10'
                  : 'border-border bg-surface-light hover:border-border-light'
              }`}
            >
              <span className={`mt-1 w-3 h-3 rounded-full border ${pickedMode === opt.id ? 'bg-violet-500 border-violet-500' : 'border-zinc-600'}`} />
              <span className="min-w-0">
                <span className="block text-[12.5px] text-zinc-100">{opt.label}</span>
                <span className="block text-[11px] text-zinc-500 mt-0.5">{opt.caption}</span>
              </span>
              {proxy?.mode === opt.id && proxy.running && (
                <span className="ml-auto text-[10px] uppercase tracking-wider text-emerald-400 shrink-0 mt-1">active</span>
              )}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Actions" hint="Start applies the picked mode. Trust CA adds the Portless root CA to your system keychain so HTTPS works without browser warnings.">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onStart}
            disabled={busy !== null || !cli?.available}
            className="h-8 px-3 rounded-md text-[12px] text-white bg-violet-600 hover:bg-violet-500 border border-violet-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === 'start' ? 'Starting…' : (proxy?.running && proxy.mode === pickedMode ? 'Restart with this mode' : `Start with ${modeLabel(pickedMode)}`)}
          </button>
          <button
            type="button"
            onClick={onStop}
            disabled={busy !== null || !cli?.available || !proxy?.running}
            className="h-8 px-3 rounded-md text-[12px] text-zinc-200 bg-surface-light hover:bg-surface-lighter border border-border disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === 'stop' ? 'Stopping…' : 'Stop proxy'}
          </button>
          <button
            type="button"
            onClick={onTrust}
            disabled={busy !== null || !cli?.available}
            className="h-8 px-3 rounded-md text-[12px] text-zinc-200 bg-surface-light hover:bg-surface-lighter border border-border disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
            title="Adds the Portless local CA to your keychain (sudo)"
          >
            <ShieldCheck className="w-3 h-3" />
            {busy === 'trust' ? 'Trusting…' : 'Trust local CA'}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={busy !== null}
            className="h-8 w-8 rounded-md inline-flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-surface-light disabled:opacity-50"
            title="Refresh status"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </Field>

      {lastResult && (
        <div className={`mt-4 text-[11.5px] rounded-md px-3 py-2 border ${lastResult.ok ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' : 'text-red-300 bg-red-500/10 border-red-500/30'}`}>
          <div className="font-medium">
            {lastResult.ok ? '✓ Done' : '✗ Failed'}
          </div>
          {lastResult.error && (
            <pre className="mt-1 font-mono text-[10.5px] whitespace-pre-wrap text-red-200/90">{lastResult.error}</pre>
          )}
          {lastResult.output && (
            <pre className="mt-1 font-mono text-[10.5px] whitespace-pre-wrap text-zinc-400">{lastResult.output}</pre>
          )}
          {lastResult.conflict?.funnelConflict && (
            <button
              type="button"
              onClick={onDisableFunnelAndRetry}
              disabled={busy !== null}
              className="mt-2 h-7 px-2.5 rounded-md text-[11px] font-medium text-white bg-red-600/80 hover:bg-red-500 border border-red-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === 'funnel' ? 'Disabling Funnel…' : busy === 'start' ? 'Retrying…' : 'Disable Funnel & retry'}
            </button>
          )}
        </div>
      )}

      {cli?.available && (
        <div className="mt-5 text-[11px] text-zinc-500 inline-flex items-center gap-2">
          <Check className="w-3 h-3 text-emerald-400" />
          portless {cli.version} · <span className="font-mono">{cli.bin}</span>
        </div>
      )}
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

/* ============================================================
 *  Actions — named server commands, each can optionally route through
 *  Portless to get a stable hostname.
 * ============================================================ */

function genActionId(): string {
  try { return crypto.randomUUID(); } catch { return Math.random().toString(36).slice(2); }
}

/** Slug the row's name into a hostname prefix. Lowercased,
 *  non-alphanumeric collapsed to dashes. */
function slugHost(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Resolve the hostname to use for an action — explicit override, or
 *  derived from the action name + project TLD. */
function resolveHost(action: PortlessAction, tld: string): string {
  if (action.hostname && action.hostname.includes('.')) return action.hostname;
  const slug = slugHost(action.name) || 'app';
  return `${slug}.${tld}`;
}

function ProjectPortlessPane({ group, onPatch, client, tld, activeSessionCwd, activeSessionGroupId }: { group: TabGroupInfo; onPatch: (patch: Partial<TabGroupInfo>) => void; client: ClaudeClient | null; tld: string; activeSessionCwd?: string; activeSessionGroupId?: string }) {
  const cfg: PortlessConfig = group.portless || {};
  const tls = cfg.tls !== false;
  const worktreeSubs = cfg.worktreeSubdomains !== false;
  const actions = cfg.actions || [];
  const enabled = cfg.enabled !== false;

  const [cli, setCli] = useState<PortlessCliStatus | null>(null);
  const [running, setRunning] = useState<Map<string, PortlessActionStatus>>(new Map());
  const [resolvedUrls, setResolvedUrls] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Local edit buffer so typing doesn't fire a patch (and a re-render)
  // on every keystroke — we commit on blur.
  const [draft, setDraft] = useState<PortlessAction[]>(actions);
  useEffect(() => { setDraft(actions); }, [group.id]);

  // CLI status + currently-running set on mount.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    (async () => {
      const [s, list] = await Promise.all([
        client.getPortlessCliStatus(),
        client.listPortlessRunning(),
      ]);
      if (cancelled) return;
      setCli(s);
      const map = new Map<string, PortlessActionStatus>();
      for (const a of list) if (a.groupId === group.id) map.set(a.actionId, a);
      setRunning(map);
    })();
    return () => { cancelled = true; };
  }, [client, group.id]);

  // Subscribe to status + URL-resolved events the ChatApp re-emits as
  // window events. Status maintains the live/idle dot per row; the
  // resolved URL is the actual reachable URL (with the real proxy port,
  // not the optimistic :443).
  useEffect(() => {
    const onStatus = (e: Event) => {
      const status = (e as CustomEvent<PortlessActionStatus>).detail;
      if (!status || status.groupId !== group.id) return;
      setRunning(prev => {
        const next = new Map(prev);
        if (status.state === 'exited' || status.state === 'failed') {
          next.delete(status.actionId);
          setResolvedUrls(urls => {
            if (!urls.has(status.actionId)) return urls;
            const m = new Map(urls);
            m.delete(status.actionId);
            return m;
          });
        } else {
          next.set(status.actionId, status);
        }
        return next;
      });
    };
    const onUrl = (e: Event) => {
      const detail = (e as CustomEvent<{ groupId: string; actionId: string; url: string }>).detail;
      if (!detail || detail.groupId !== group.id) return;
      setResolvedUrls(prev => {
        const next = new Map(prev);
        next.set(detail.actionId, detail.url);
        return next;
      });
    };
    window.addEventListener('portless_status', onStatus);
    window.addEventListener('portless_url_resolved', onUrl);
    return () => {
      window.removeEventListener('portless_status', onStatus);
      window.removeEventListener('portless_url_resolved', onUrl);
    };
  }, [group.id]);

  const persist = (next: PortlessConfig) => {
    onPatch({ portless: cleanCfg(next) });
  };
  const setActions = (nextActions: PortlessAction[]) => {
    setDraft(nextActions);
    persist({ ...cfg, actions: nextActions });
  };

  const patchAction = (id: string, patch: Partial<PortlessAction>) => {
    setDraft(prev => prev.map(a => a.id === id ? { ...a, ...patch } : a));
  };
  const commitAction = (id: string) => {
    const merged = draft.map(a => a.id === id ? a : a);
    setActions(merged);
  };
  const addAction = () => {
    const fresh: PortlessAction = { id: genActionId(), name: '', command: '', hostname: '', portless: true };
    setActions([...draft, fresh]);
  };
  const removeAction = (id: string) => {
    setActions(draft.filter(a => a.id !== id));
    if (client) void client.forgetPortlessAction(group.id, id);
  };

  const run = async (a: PortlessAction) => {
    // Run from the focused session's cwd when that session belongs to this
    // project — that's the directory the user actually opened (a git worktree,
    // say), so the action serves the right branch. Fall back to the group's
    // root checkout when no matching session is focused.
    const sessionCwd = activeSessionGroupId === group.id ? (activeSessionCwd || '').trim() : '';
    const runCwd = sessionCwd || group.cwd;
    if (!client || !runCwd) { setError('Set a working directory on this project first.'); return; }
    const host = resolveHost(a, tld);
    const name = (a.name.trim() || slugHost(host.split('.')[0]!) || 'app');
    if (!a.command.trim()) { setError('Add a command to run.'); return; }
    setBusy(prev => new Set(prev).add(a.id));
    setError(null);
    try {
      const status = await client.runPortlessAction({
        groupId: group.id,
        actionId: a.id,
        name,
        command: a.command.trim(),
        hostname: host,
        cwd: runCwd,
        noTls: !tls,
        source: 'user',
      });
      setRunning(prev => { const m = new Map(prev); m.set(a.id, status); return m; });
    } catch (e: any) {
      setError(e?.message || 'Failed to start action');
    } finally {
      setBusy(prev => { const s = new Set(prev); s.delete(a.id); return s; });
    }
  };

  const stop = async (a: PortlessAction) => {
    if (!client) return;
    setBusy(prev => new Set(prev).add(a.id));
    try { await client.stopPortlessAction(group.id, a.id); }
    finally { setBusy(prev => { const s = new Set(prev); s.delete(a.id); return s; }); }
  };

  const startAll = async () => {
    for (const a of draft) {
      if (!running.has(a.id) && a.name.trim() && a.command.trim()) {
        // eslint-disable-next-line no-await-in-loop
        await run(a);
      }
    }
  };
  const stopAllLocal = async () => {
    for (const a of draft) {
      if (running.has(a.id)) {
        // eslint-disable-next-line no-await-in-loop
        await stop(a);
      }
    }
  };

  const detect = async () => {
    if (!client || !group.cwd) return;
    setError(null);
    const res = await client.detectPortlessScripts(group.cwd);
    if (res.suggested.length === 0) { setError('No dev-server scripts found in package.json.'); return; }
    const existingNames = new Set(draft.map(a => a.name));
    const additions: PortlessAction[] = [];
    for (const s of res.suggested) {
      if (existingNames.has(s.name)) continue;
      additions.push({ id: genActionId(), name: s.name, command: s.command, hostname: `${slugHost(s.name)}.${tld}`, portless: true });
    }
    if (additions.length > 0) setActions([...draft, ...additions]);
    else setError('All detected scripts already have actions.');
  };

  const runningCount = running.size;
  const totalRunnable = draft.filter(a => a.name.trim() && a.command.trim()).length;

  return (
    <>
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h3 className="text-[13px] font-semibold text-zinc-200">Actions</h3>
          <p className="mt-1 text-[12px] text-zinc-500 max-w-[68ch]">
            Named server commands taskr can run. Toggle the globe per row to
            route through{' '}
            <a href="https://portless.sh" target="_blank" rel="noreferrer" className="text-zinc-300 underline">Portless</a>{' '}
            — when on, the command serves at a stable hostname (no port). Off
            runs the command as-is.
          </p>
        </div>
        {runningCount > 0 && (
          <span className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-emerald-400 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            {runningCount} of {totalRunnable} running
          </span>
        )}
      </div>

      {cli && !cli.available && draft.some(a => a.portless !== false) && (
        <div className="text-[11.5px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2.5 mb-4">
          Portless CLI not found. Install with <code className="font-mono text-amber-200">npm install -g portless</code> and restart taskr — or disable the globe on rows that don't need it.
        </div>
      )}

      <button
        onClick={() => persist({ ...cfg, enabled: !enabled })}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md bg-surface-light border border-border hover:border-border-light text-left mb-5"
      >
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px] text-zinc-100">Enable actions for this project</div>
          <div className="text-[11px] text-zinc-500 mt-0.5">Off: actions still appear in this list but the agent's `actions_*` MCP tools won't see this project.</div>
        </div>
        <span className={`w-8 h-[18px] rounded-full relative transition-colors ${enabled ? 'bg-violet-600' : 'bg-zinc-700'}`}>
          <span className={`absolute top-[2px] left-[2px] w-3.5 h-3.5 rounded-full bg-white transition-transform ${enabled ? 'translate-x-[14px]' : ''}`} />
        </span>
      </button>

      {/* Actions grid */}
      <div className="rounded-lg border border-border bg-surface-light/30 overflow-hidden">
        <div className="grid grid-cols-[14px_180px_1.6fr_22px_1fr_32px] gap-2.5 px-3 py-2 bg-surface-light border-b border-border text-[10px] uppercase tracking-[0.12em] text-zinc-500 font-medium items-center">
          <div />
          <div>Name</div>
          <div>Command</div>
          <div title="Portless on/off"><Globe className="w-3 h-3 mx-auto" /></div>
          <div>Hostname</div>
          <div />
        </div>

        {draft.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-zinc-500">
            No actions yet. Add one below to define a named server command.
          </div>
        ) : (
          draft.map(a => {
            const status = running.get(a.id);
            const live = status && (status.state === 'running' || status.state === 'starting');
            const failed = status && status.state === 'failed';
            const isBusy = busy.has(a.id);
            const usePortless = a.portless !== false;
            const dotClass =
              status?.state === 'running' ? 'bg-emerald-400 animate-pulse' :
              status?.state === 'starting' ? 'bg-amber-400 animate-pulse' :
              status?.state === 'stopping' ? 'bg-amber-400' :
              failed ? 'bg-red-400' :
              'bg-zinc-700';
            const title =
              status?.state === 'running' ? 'Running — click to stop' :
              status?.state === 'starting' ? 'Starting…' :
              status?.state === 'stopping' ? 'Stopping…' :
              failed ? (status?.lastError || 'Failed — click to retry') :
              'Idle — click to run';
            // Hostname always derives from name + project TLD now — surface the
            // resolved URL as a sub-line under the name when the action is running.
            const derivedHost = `${slugHost(a.name) || 'app'}.${tld}`;
            const liveUrl = resolvedUrls.get(a.id);
            return (
              <div key={a.id} className="grid grid-cols-[14px_180px_1.6fr_22px_1fr_32px] gap-2.5 px-3 py-2 items-center hover:bg-violet-500/[0.04]">
                <button
                  type="button"
                  onClick={() => (live ? stop(a) : run(a))}
                  disabled={isBusy || (usePortless && !cli?.available) || !group.cwd}
                  title={title}
                  className="w-3.5 h-3.5 inline-flex items-center justify-center rounded-full disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span className={`w-2 h-2 rounded-full ${dotClass}`} />
                </button>
                <div className="min-w-0">
                  <input
                    value={a.name}
                    onChange={e => patchAction(a.id, { name: e.target.value })}
                    onBlur={() => commitAction(a.id)}
                    placeholder="action-name"
                    className="w-full px-2.5 py-1.5 rounded bg-surface-light border border-border focus:border-violet-500 focus:bg-surface-lighter font-mono text-[12px] text-violet-200 outline-none"
                  />
                  {usePortless && (
                    liveUrl ? (
                      <a
                        href={liveUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={`Open ${liveUrl}`}
                        className="mt-1 inline-flex items-center gap-1 text-[10px] font-mono text-emerald-400/90 hover:text-emerald-300 truncate"
                      >
                        <span className="w-1 h-1 rounded-full bg-emerald-400" />
                        {liveUrl.replace(/^https?:\/\//, '')}
                      </a>
                    ) : (
                      <div className="mt-1 text-[10px] font-mono text-zinc-600 truncate" title={`https://${derivedHost}`}>
                        {derivedHost}
                      </div>
                    )
                  )}
                </div>
                <input
                  value={a.command}
                  onChange={e => patchAction(a.id, { command: e.target.value })}
                  onBlur={() => commitAction(a.id)}
                  placeholder="bun run dev"
                  className="w-full px-2.5 py-1.5 rounded bg-surface-light border border-border focus:border-violet-500 focus:bg-surface-lighter font-mono text-[11.5px] text-zinc-100 outline-none"
                />
                <button
                  type="button"
                  onClick={() => { patchAction(a.id, { portless: !usePortless }); setActions(draft.map(x => x.id === a.id ? { ...x, portless: !usePortless } : x)); }}
                  title={usePortless ? 'Portless on — click to run command raw' : 'Portless off — click to wrap with portless'}
                  className={`w-[22px] h-[22px] inline-flex items-center justify-center rounded transition-colors ${usePortless ? 'text-violet-300 bg-violet-500/15 border border-violet-500/35' : 'text-zinc-600 hover:text-zinc-300 border border-transparent hover:bg-surface-lighter'}`}
                >
                  <Globe className="w-3 h-3" strokeWidth={2} />
                </button>
                <button
                  type="button"
                  onClick={() => removeAction(a.id)}
                  title="Remove"
                  className="w-7 h-7 inline-flex items-center justify-center rounded-md text-zinc-500 hover:text-red-300 hover:bg-red-500/10"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })
        )}

        <div className="px-3 py-2 flex items-center gap-2 bg-surface-light/40 border-t border-border">
          <button
            type="button"
            onClick={addAction}
            className="text-[11.5px] px-2.5 py-1.5 rounded-md text-zinc-200 bg-surface-light hover:bg-surface-lighter border border-border hover:border-border-light inline-flex items-center gap-1.5"
          >
            <Plus className="w-3 h-3" />
            Add action
          </button>
          <button
            type="button"
            onClick={detect}
            disabled={!client || !group.cwd}
            className="text-[11.5px] px-2.5 py-1.5 rounded-md text-zinc-300 bg-surface-light hover:bg-surface-lighter border border-border hover:border-border-light inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ScanLine className="w-3 h-3" />
            Detect from package.json
          </button>
          <div className="ml-auto inline-flex items-center gap-1.5">
            <button
              type="button"
              onClick={startAll}
              disabled={!cli?.available || draft.length === 0}
              className="text-[11.5px] px-2.5 py-1.5 rounded-md text-white bg-violet-600 hover:bg-violet-500 border border-violet-500/50 inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Play className="w-3 h-3" />
              Start all
            </button>
            <button
              type="button"
              onClick={stopAllLocal}
              disabled={runningCount === 0}
              className="text-[11.5px] px-2.5 py-1.5 rounded-md text-zinc-300 bg-surface-light hover:bg-surface-lighter border border-border inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Square className="w-3 h-3" />
              Stop all
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-3 text-[11.5px] text-red-300 bg-red-500/10 border border-red-500/25 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      {/* Defaults strip — only apply to portless-enabled rows.
          TLD lives in Settings → Portless Proxy now (one TLD per system). */}
      <div className="mt-6">
        <div className="text-[11px] uppercase tracking-[0.14em] text-zinc-500 mb-2.5">
          Portless defaults
          <span className="text-zinc-700 normal-case tracking-normal text-[10.5px] ml-1.5">
            · TLD <code className="font-mono text-zinc-400">.{tld}</code> (global)
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => persist({ ...cfg, tls: !tls })}
            className="flex items-center gap-3 px-3 py-2.5 rounded-md bg-surface-light border border-border text-left"
          >
            <div className="flex-1 min-w-0">
              <div className="text-[12px] text-zinc-200">HTTPS</div>
              <div className="text-[10.5px] text-zinc-500">local CA-signed certs</div>
            </div>
            <span className={`w-8 h-[18px] rounded-full relative transition-colors ${tls ? 'bg-violet-600' : 'bg-zinc-700'}`}>
              <span className={`absolute top-[2px] left-[2px] w-3.5 h-3.5 rounded-full bg-white transition-transform ${tls ? 'translate-x-[14px]' : ''}`} />
            </span>
          </button>
          <button
            type="button"
            onClick={() => persist({ ...cfg, worktreeSubdomains: !worktreeSubs })}
            className="flex items-center gap-3 px-3 py-2.5 rounded-md bg-surface-light border border-border text-left"
          >
            <div className="flex-1 min-w-0">
              <div className="text-[12px] text-zinc-200">Worktree subdomains</div>
              <div className="text-[10.5px] text-zinc-500">prefix branch → hostname</div>
            </div>
            <span className={`w-8 h-[18px] rounded-full relative transition-colors ${worktreeSubs ? 'bg-violet-600' : 'bg-zinc-700'}`}>
              <span className={`absolute top-[2px] left-[2px] w-3.5 h-3.5 rounded-full bg-white transition-transform ${worktreeSubs ? 'translate-x-[14px]' : ''}`} />
            </span>
          </button>
        </div>
      </div>

      {/* CLI status footer */}
      <div className="mt-5 text-[11px] text-zinc-500 inline-flex items-center gap-2">
        {cli?.available ? (
          <>
            <Check className="w-3 h-3 text-emerald-400" />
            portless {cli.version} · <span className="font-mono">{cli.bin}</span>
          </>
        ) : (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
            Portless CLI not detected
          </>
        )}
      </div>
    </>
  );
}

/** Strip undefined-equivalent fields so the persisted blob stays small.
 *  Keeps `actions` even when empty so removal of the last row sticks. */
function cleanCfg(cfg: PortlessConfig): PortlessConfig | undefined {
  const out: PortlessConfig = {};
  if (cfg.enabled === false) out.enabled = false;
  if (cfg.tld && cfg.tld !== 'localhost') out.tld = cfg.tld;
  if (cfg.tls === false) out.tls = false;
  if (cfg.worktreeSubdomains === false) out.worktreeSubdomains = false;
  if (cfg.actions && cfg.actions.length > 0) out.actions = cfg.actions;
  if (cfg.exports && cfg.exports.length > 0) out.exports = cfg.exports;
  return Object.keys(out).length === 0 ? undefined : out;
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
  const hex = GROUP_HEX_COLOR[group.color ?? ''] || '#a78bfa';
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
  autoGroupSessions, onToggleAutoGroup, groupSessionsByWorktree, onToggleGroupByWorktree,
  autoFocusBrowserOnAction, onToggleAutoFocusBrowserOnAction,
  interruptOnSend, onToggleInterruptOnSend,
  colorChatBySession, onToggleColorChatBySession,
  tintChatBackground, onToggleTintChatBackground,
  showTelegramSession, onToggleShowTelegramSession,
  globalEnvVars, onChangeGlobalEnvVars,
  portlessTld, onChangePortlessTld,
  client, claudeModels,
  onDeleteGroup, onPatchGroup,
  activeSessionCwd, activeSessionGroupId,
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
            <NavItem icon={<Globe className="w-3.5 h-3.5" strokeWidth={1.75} />} label="Portless Proxy" active={selected.kind === 'global' && selected.id === 'portless'} onClick={() => setSelected({ kind: 'global', id: 'portless' })} />
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
                  claudeModels={claudeModels}
                  portlessTld={portlessTld}
                  activeSessionCwd={activeSessionCwd}
                  activeSessionGroupId={activeSessionGroupId}
                />
              )
              : (
                <GlobalContent
                  section={selected.kind === 'global' ? selected.id : 'general'}
                  serverUrl={serverUrl}
                  tabGroups={tabGroups}
                  tabGroupMap={tabGroupMap}
                  autoGroupSessions={autoGroupSessions}
                  groupSessionsByWorktree={groupSessionsByWorktree}
                  onToggleGroupByWorktree={onToggleGroupByWorktree}
                  onToggleAutoGroup={onToggleAutoGroup}
                  autoFocusBrowserOnAction={autoFocusBrowserOnAction}
                  onToggleAutoFocusBrowserOnAction={onToggleAutoFocusBrowserOnAction}
                  interruptOnSend={interruptOnSend}
                  onToggleInterruptOnSend={onToggleInterruptOnSend}
                  colorChatBySession={colorChatBySession}
                  onToggleColorChatBySession={onToggleColorChatBySession}
                  tintChatBackground={tintChatBackground}
                  onToggleTintChatBackground={onToggleTintChatBackground}
                  showTelegramSession={showTelegramSession}
                  onToggleShowTelegramSession={onToggleShowTelegramSession}
                  globalEnvVars={globalEnvVars}
                  onChangeGlobalEnvVars={onChangeGlobalEnvVars}
                  portlessTld={portlessTld}
                  onChangePortlessTld={onChangePortlessTld}
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
function GlobalContent({ section, serverUrl, tabGroups, tabGroupMap, autoGroupSessions, onToggleAutoGroup, groupSessionsByWorktree, onToggleGroupByWorktree, autoFocusBrowserOnAction, onToggleAutoFocusBrowserOnAction, interruptOnSend, onToggleInterruptOnSend, colorChatBySession, onToggleColorChatBySession, tintChatBackground, onToggleTintChatBackground, showTelegramSession, onToggleShowTelegramSession, globalEnvVars, onChangeGlobalEnvVars, portlessTld, onChangePortlessTld, client, onDeleteGroup, onSelectGroup }: {
  section: GlobalSection;
  serverUrl: string | null;
  tabGroups: Record<string, TabGroupInfo>;
  tabGroupMap: Record<string, string>;
  autoGroupSessions: boolean;
  onToggleAutoGroup: (v: boolean) => void;
  groupSessionsByWorktree: boolean;
  onToggleGroupByWorktree: (v: boolean) => void;
  autoFocusBrowserOnAction: boolean;
  onToggleAutoFocusBrowserOnAction: (v: boolean) => void;
  interruptOnSend: boolean;
  onToggleInterruptOnSend: (v: boolean) => void;
  colorChatBySession: boolean;
  onToggleColorChatBySession: (v: boolean) => void;
  tintChatBackground: boolean;
  onToggleTintChatBackground: (v: boolean) => void;
  showTelegramSession: boolean;
  onToggleShowTelegramSession: (v: boolean) => void;
  globalEnvVars: ProjectEnvVar[];
  onChangeGlobalEnvVars: (next: ProjectEnvVar[]) => void;
  portlessTld: string;
  onChangePortlessTld: (next: string) => void;
  client: ClaudeClient | null;
  onDeleteGroup: (id: string) => void;
  onSelectGroup: (id: string) => void;
}) {
  return (
    <div className="px-8 pt-6 pb-8">
      {section === 'general'     && <GeneralSection autoGroupSessions={autoGroupSessions} onToggleAutoGroup={onToggleAutoGroup} groupSessionsByWorktree={groupSessionsByWorktree} onToggleGroupByWorktree={onToggleGroupByWorktree} autoFocusBrowserOnAction={autoFocusBrowserOnAction} onToggleAutoFocusBrowserOnAction={onToggleAutoFocusBrowserOnAction} interruptOnSend={interruptOnSend} onToggleInterruptOnSend={onToggleInterruptOnSend} colorChatBySession={colorChatBySession} onToggleColorChatBySession={onToggleColorChatBySession} tintChatBackground={tintChatBackground} onToggleTintChatBackground={onToggleTintChatBackground} />}
      {section === 'telegram'    && <TelegramSection serverUrl={serverUrl} showTelegramSession={showTelegramSession} onToggleShowTelegramSession={onToggleShowTelegramSession} />}
      {section === 'deepgram'    && <DeepgramSection serverUrl={serverUrl} />}
      {section === 'tailscale'   && <TailscaleSection serverUrl={serverUrl} />}
      {section === 'portless'    && <PortlessProxySection client={client} tld={portlessTld} onChangeTld={onChangePortlessTld} />}
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
function ProjectContent({ group, tab, onTabChange, onPatch, onDelete, tabGroupMap, memberCount, client, claudeModels, portlessTld, activeSessionCwd, activeSessionGroupId }: {
  group: TabGroupInfo;
  tab: ProjectTab;
  onTabChange: (t: ProjectTab) => void;
  onPatch: (patch: Partial<TabGroupInfo>) => void;
  onDelete: () => void;
  tabGroupMap: Record<string, string>;
  memberCount: number;
  client: ClaudeClient | null;
  claudeModels: { id: string; label: string }[];
  portlessTld: string;
  activeSessionCwd?: string;
  activeSessionGroupId?: string;
}) {
  const hex = GROUP_HEX_COLOR[group.color ?? ''] || '#a78bfa';
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
      {tab === 'defaults'    && <ProjectDefaultsPane group={group} onPatch={onPatch} claudeModels={claudeModels} />}
      {tab === 'permissions' && <ProjectPermissionsPane group={group} onPatch={onPatch} />}
      {tab === 'environment' && <ProjectEnvironmentPane group={group} onPatch={onPatch} />}
      {tab === 'mcp'         && <ProjectMcpPane group={group} onPatch={onPatch} />}
      {tab === 'hooks'       && <ProjectHooksPane group={group} client={client} />}
      {tab === 'portless'    && <ProjectPortlessPane group={group} onPatch={onPatch} client={client} tld={portlessTld} activeSessionCwd={activeSessionCwd} activeSessionGroupId={activeSessionGroupId} />}
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
/** Render a configured URL/host/port for an action — mirrors the
 *  server-side `renderExportValue` in `server/action-env.ts` so the UI
 *  preview matches what the bridge will inject. */
function previewExportValue(
  format: PortlessExportFormat,
  action: PortlessAction | undefined,
  tld: string,
  tls: boolean,
  customTemplate?: string,
): string {
  if (!action) return '—';
  const slug = action.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
  const host = (action.hostname && action.hostname.includes('.')) ? action.hostname : `${slug}.${tld}`;
  const scheme = tls ? 'https' : 'http';
  const port = tls ? '443' : '80';
  const url = `${scheme}://${host}`;
  if (format === 'host') return host;
  if (format === 'port') return port;
  if (format === 'url') return url;
  const template = customTemplate || url;
  return template
    .replace(/\$\{host\}|\{host\}/g, host)
    .replace(/\$\{url\}|\{url\}/g, url)
    .replace(/\$\{port\}|\{port\}/g, port)
    .replace(/\$\{scheme\}|\{scheme\}/g, scheme);
}

/** A single row in the project-level Env exports section. Layout:
 *  [name input] [format dropdown] [template input · disabled unless custom]
 *  [source action picker] [×]. A live preview of the value sits underneath
 *  the template field so the user knows what the consumer will see. */
function ExportRow({
  exp,
  actions,
  tld,
  tls,
  onPatch,
  onRemove,
}: {
  exp: PortlessExport;
  actions: PortlessAction[];
  tld: string;
  tls: boolean;
  onPatch: (patch: Partial<PortlessExport>) => void;
  onRemove: () => void;
}) {
  const sourceAction = actions.find(a => a.id === exp.sourceActionId);
  const presetTemplate = (format: PortlessExportFormat): string => {
    if (format === 'host') return '{host}';
    if (format === 'port') return '{port}';
    if (format === 'url') return `${tls ? 'https' : 'http'}://{host}`;
    return exp.template || `${tls ? 'https' : 'http'}://{host}`;
  };
  const displayedTemplate = exp.format === 'custom'
    ? (exp.template || `${tls ? 'https' : 'http'}://{host}`)
    : presetTemplate(exp.format);
  const preview = previewExportValue(exp.format, sourceAction, tld, tls, exp.template);

  return (
    <div className="grid grid-cols-[1fr_100px_1.4fr_160px_28px] gap-2 px-3 py-2 items-center border-t border-border/60 first:border-t-0 hover:bg-violet-500/[0.04]">
      <input
        value={exp.name}
        onChange={e => onPatch({ name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })}
        placeholder="API_URL"
        className="w-full px-2.5 py-1.5 rounded bg-surface-light border border-border focus:border-violet-500 font-mono text-[11.5px] text-zinc-100 outline-none"
      />
      <select
        value={exp.format}
        onChange={e => {
          const next = e.target.value as PortlessExportFormat;
          // Picking a preset overwrites the persisted custom template so
          // switching back to `custom` later starts from the preset's value.
          onPatch({ format: next, template: next === 'custom' ? (exp.template || presetTemplate(exp.format)) : undefined });
        }}
        className="bg-surface-lighter border border-border rounded px-2 py-1.5 text-[11px] text-zinc-200 font-mono"
      >
        <option value="url">url</option>
        <option value="host">host</option>
        <option value="port">port</option>
        <option value="custom">custom</option>
      </select>
      <div className="min-w-0">
        <input
          value={displayedTemplate}
          onChange={e => onPatch({ template: e.target.value })}
          disabled={exp.format !== 'custom'}
          placeholder={`${tls ? 'https' : 'http'}://{host}/api`}
          className={`w-full px-2.5 py-1.5 rounded font-mono text-[11.5px] outline-none border focus:border-violet-500 ${
            exp.format === 'custom'
              ? 'bg-surface-light border-border focus:bg-surface-lighter text-zinc-100'
              : 'bg-transparent border-transparent text-zinc-500 cursor-default'
          }`}
          title="Placeholders: {host} {url} {port} {scheme}"
        />
        <div className="mt-0.5 px-1 text-[10.5px] text-emerald-400/90 font-mono truncate" title={preview}>
          → {preview}
        </div>
      </div>
      <select
        value={exp.sourceActionId}
        onChange={e => onPatch({ sourceActionId: e.target.value })}
        className={`bg-surface-lighter border rounded px-2 py-1.5 text-[11px] font-mono ${
          sourceAction ? 'text-zinc-200 border-border' : 'text-amber-300 border-amber-500/40'
        }`}
        title="Which action's URL drives this export"
      >
        <option value="">— pick source —</option>
        {actions.filter(a => a.portless !== false && a.name.trim()).map(a => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={onRemove}
        title="Remove export"
        className="w-7 h-7 inline-flex items-center justify-center rounded-md text-zinc-500 hover:text-red-300 hover:bg-red-500/10"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}


/** Modal listing env-var candidates the bridge found in the project's
 *  .env files. Each row maps a detected KEY=URL into an action's
 *  `exports` entry (via the suggested action). Bulk-apply with the
 *  checkboxes; ambiguous mappings require manual pick. */
function ScanEnvModal({
  candidates,
  scanned,
  actionNames,
  onCancel,
  onApply,
  onUpdateCandidate,
}: {
  candidates: { var: string; value: string; file: string; line: number; suggestedAction: string | null; ambiguous: boolean; format: PortlessExportFormat }[];
  scanned: string[];
  actionNames: string[];
  onCancel: () => void;
  onApply: (selected: Set<number>) => void;
  onUpdateCandidate: (i: number, patch: { suggestedAction?: string | null; format?: PortlessExportFormat }) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(() => {
    // Default: select everything that has a non-ambiguous match
    const s = new Set<number>();
    candidates.forEach((c, i) => { if (c.suggestedAction && !c.ambiguous) s.add(i); });
    return s;
  });
  const toggle = (i: number) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });
  const allMatched = candidates.filter(c => c.suggestedAction).map((_, i) => i);
  const allSelected = allMatched.every(i => selected.has(i));

  return (
    <div className="fixed inset-0 z-[9000] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6" onClick={onCancel}>
      <div className="w-[820px] max-w-full max-h-[80vh] rounded-xl border border-border-light bg-surface shadow-2xl overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-border flex items-center gap-3 shrink-0">
          <ScanLine className="w-4 h-4 text-violet-300" />
          <span className="text-[13px] text-zinc-200 font-medium">Detected env vars · {candidates.length} candidates</span>
          <button onClick={onCancel} className="ml-auto w-7 h-7 rounded-md hover:bg-surface-light text-zinc-500 hover:text-zinc-200 inline-flex items-center justify-center">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="px-4 py-2 text-[10.5px] text-zinc-500 font-mono border-b border-border bg-surface-light/30 shrink-0">
          scanned {scanned.length} file{scanned.length === 1 ? '' : 's'}: <span className="text-zinc-400">{scanned.map(f => f.split('/').slice(-2).join('/')).join(', ') || '(none)'}</span>
        </div>
        {candidates.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-[12px] text-zinc-500 italic p-8">
            No URL-shaped env vars found in this project.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[28px_1.4fr_110px_1fr_1fr] gap-2 px-4 py-2 text-[10px] uppercase tracking-wider text-zinc-600 border-b border-border bg-surface-light/40 shrink-0">
              <div></div>
              <div>Detected var · file:line</div>
              <div>Format</div>
              <div>Source action</div>
              <div>Will become</div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {candidates.map((c, i) => {
                const isSelected = selected.has(i);
                const sourceOk = !!c.suggestedAction;
                const preview = c.suggestedAction
                  ? (() => {
                      // We don't know the cfg here, so render a placeholder.
                      // Real value lands when the export is applied — at
                      // export-time we compute from the action's hostname.
                      return c.format === 'host'
                        ? `<${c.suggestedAction}>.localhost`
                        : c.format === 'port' ? '443'
                        : `https://<${c.suggestedAction}>.localhost`;
                    })()
                  : '— pick a source first —';
                return (
                  <div key={i} className={`grid grid-cols-[28px_1.4fr_110px_1fr_1fr] gap-2 px-4 py-2.5 items-center border-b border-border/40 hover:bg-violet-500/[0.04] ${isSelected ? 'bg-violet-500/[0.03]' : ''}`}>
                    <div className="flex items-center justify-center">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggle(i)}
                        disabled={!sourceOk}
                        className="accent-violet-500"
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="text-[12px] font-mono text-zinc-100">{c.var}</div>
                      <div className="text-[10.5px] text-zinc-500 font-mono truncate">
                        {c.file}:{c.line} <span className="text-zinc-700">·</span> {c.value}
                        {c.ambiguous && <span className="text-amber-400 ml-1.5">⚠ ambiguous</span>}
                      </div>
                    </div>
                    <select
                      value={c.format}
                      onChange={e => onUpdateCandidate(i, { format: e.target.value as PortlessExportFormat })}
                      className="bg-surface-lighter border border-border rounded px-2 py-1.5 text-[11px] text-zinc-200 font-mono"
                    >
                      <option value="url">url</option>
                      <option value="host">host</option>
                      <option value="port">port</option>
                      <option value="custom">custom</option>
                    </select>
                    <select
                      value={c.suggestedAction || ''}
                      onChange={e => onUpdateCandidate(i, { suggestedAction: e.target.value || null })}
                      className={`bg-surface-lighter border border-border rounded px-2 py-1.5 text-[11px] font-mono ${sourceOk ? 'text-zinc-200' : 'text-zinc-500'}`}
                    >
                      <option value="">— pick —</option>
                      {actionNames.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                    <code className={`text-[11px] font-mono px-2 py-1 rounded truncate ${sourceOk ? 'text-emerald-300 bg-emerald-500/[0.06] border border-emerald-500/20' : 'text-zinc-500 italic'}`}>
                      {preview}
                    </code>
                  </div>
                );
              })}
            </div>
            <div className="px-4 py-2.5 border-t border-border bg-surface-light/40 flex items-center gap-2 shrink-0">
              <label className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(allMatched))}
                  className="accent-violet-500"
                />
                select all matched
              </label>
              <span className="text-[10.5px] text-zinc-500 ml-1">{selected.size} of {candidates.length} selected</span>
              <span className="ml-auto inline-flex items-center gap-1.5">
                <button onClick={onCancel} className="h-7 px-3 rounded-md text-[11.5px] text-zinc-300 hover:bg-surface-light border border-border">Cancel</button>
                <button
                  onClick={() => onApply(selected)}
                  disabled={selected.size === 0}
                  className="h-7 px-3 rounded-md text-[11.5px] text-white bg-violet-600 hover:bg-violet-500 border border-violet-500/50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Apply {selected.size > 0 ? selected.size : ''} mapping{selected.size === 1 ? '' : 's'}
                </button>
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
