import { useState, useEffect } from 'react';
import { Switch, SwitchControl, SwitchThumb } from '@heroui/react';
import { resolveServerUrl } from '../lib/claude-client';
import { PairPhoneModal } from './PairPhoneModal';
import { PluginSettingsSections } from './PluginExtensionPoints';
import { ICON_MAP } from '../lib/group-icons';

interface TabGroupInfo {
  id: string;
  name: string;
  color: string;
  cwd?: string;
  icon?: string;
}

const GROUP_DOT_COLOR: Record<string, string> = {
  blue:   'bg-blue-400',
  green:  'bg-green-400',
  amber:  'bg-amber-400',
  violet: 'bg-violet-400',
  red:    'bg-red-400',
  pink:   'bg-pink-400',
};

interface SettingsPanelProps {
  onClose: () => void;
  tabGroups: Record<string, TabGroupInfo>;
  tabGroupMap: Record<string, string>;
  onDeleteGroup: (groupId: string) => void;
  autoGroupSessions: boolean;
  onToggleAutoGroup: (next: boolean) => void;
}

export function SettingsPanel({ onClose, tabGroups, tabGroupMap, onDeleteGroup, autoGroupSessions, onToggleAutoGroup }: SettingsPanelProps) {
  const [serverUrl, setServerUrl] = useState<string | null>(null);

  // Telegram settings
  const [tgBotToken, setTgBotToken] = useState('');
  const [tgChatId, setTgChatId] = useState('');
  const [tgRunning, setTgRunning] = useState(false);
  const [tgSaving, setTgSaving] = useState(false);
  const [tgLoaded, setTgLoaded] = useState(false);
  const [tgShowToken, setTgShowToken] = useState(false);
  const [tgSaved, setTgSaved] = useState(false);
  const [tgError, setTgError] = useState<string | null>(null);

  // Deepgram settings (voice transcription for Telegram voice notes)
  const [dgApiKey, setDgApiKey] = useState('');
  const [dgModel, setDgModel] = useState('nova-3');
  const [dgLanguage, setDgLanguage] = useState('multi');
  const [dgConfigured, setDgConfigured] = useState(false);
  const [dgLoaded, setDgLoaded] = useState(false);
  const [dgSaving, setDgSaving] = useState(false);
  const [dgShowKey, setDgShowKey] = useState(false);
  const [dgSaved, setDgSaved] = useState(false);
  const [dgError, setDgError] = useState<string | null>(null);

  // Tailscale Funnel
  const [tsLoaded, setTsLoaded] = useState(false);
  const [tsAvailable, setTsAvailable] = useState(false);
  const [tsFunnelEnabled, setTsFunnelEnabled] = useState(false);
  const [tsHostname, setTsHostname] = useState<string | null>(null);
  const [tsToggling, setTsToggling] = useState(false);
  const [tsError, setTsError] = useState<string | null>(null);

  // Mobile pairing
  const [pairOpen, setPairOpen] = useState(false);

  // Tab group delete confirm (inline, per-row)
  const [confirmingGroupId, setConfirmingGroupId] = useState<string | null>(null);

  const groupEntries = Object.values(tabGroups);
  const memberCountByGroup: Record<string, number> = {};
  for (const gid of Object.values(tabGroupMap)) {
    memberCountByGroup[gid] = (memberCountByGroup[gid] || 0) + 1;
  }

  useEffect(() => { resolveServerUrl().then(setServerUrl); }, []);

  useEffect(() => {
    if (!serverUrl) return;
    (async () => {
      try {
        const res = await fetch(`${serverUrl}/telegram/settings`);
        if (res.ok) {
          const data = await res.json();
          setTgBotToken(data.botToken || '');
          setTgChatId(data.chatId || '');
          setTgRunning(!!data.running);
        }
      } catch {}
      setTgLoaded(true);
    })();
  }, [serverUrl]);

  useEffect(() => {
    if (!serverUrl) return;
    (async () => {
      try {
        const res = await fetch(`${serverUrl}/deepgram/settings`);
        if (res.ok) {
          const data = await res.json();
          setDgApiKey(data.apiKey || '');
          setDgModel(data.model || 'nova-3');
          setDgLanguage(data.language || 'multi');
          setDgConfigured(!!data.configured);
        }
      } catch {}
      setDgLoaded(true);
    })();
  }, [serverUrl]);

  useEffect(() => {
    if (!serverUrl) return;
    (async () => {
      try {
        const res = await fetch(`${serverUrl}/tailscale/settings`);
        if (res.ok) {
          const data = await res.json();
          setTsAvailable(!!data.available);
          setTsFunnelEnabled(!!data.funnelEnabled);
          setTsHostname(data.hostname || null);
        }
      } catch {}
      setTsLoaded(true);
    })();
  }, [serverUrl]);

  const handleTailscaleToggle = async (next: boolean) => {
    if (!serverUrl) return;
    setTsToggling(true);
    setTsError(null);
    try {
      const res = await fetch(`${serverUrl}/tailscale/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ funnelEnabled: next }),
      });
      const data = await res.json();
      setTsFunnelEnabled(!!data.funnelEnabled);
      setTsHostname(data.hostname || null);
      setTsAvailable(!!data.available);
      if (!res.ok || data.error) setTsError(data.error || `Failed (${res.status})`);
    } catch (e) {
      setTsError(String(e));
    } finally {
      setTsToggling(false);
    }
  };

  const handleDeepgramSave = async () => {
    if (!serverUrl) return;
    setDgSaving(true);
    setDgError(null);
    setDgSaved(false);
    try {
      const res = await fetch(`${serverUrl}/deepgram/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: dgApiKey.trim(),
          model: dgModel.trim() || 'nova-3',
          language: dgLanguage.trim() || 'multi',
        }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      const data = await res.json();
      setDgConfigured(!!data.configured);
      setDgSaved(true);
      setTimeout(() => setDgSaved(false), 2000);
    } catch (e) {
      setDgError(String(e));
    } finally {
      setDgSaving(false);
    }
  };

  const handleTelegramSave = async () => {
    if (!serverUrl) return;
    setTgSaving(true);
    setTgError(null);
    setTgSaved(false);
    try {
      const res = await fetch(`${serverUrl}/telegram/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken: tgBotToken.trim(), chatId: tgChatId.trim() }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      const data = await res.json();
      setTgRunning(!!data.running);
      setTgSaved(true);
      setTimeout(() => setTgSaved(false), 2000);
    } catch (e) {
      setTgError(String(e));
    } finally {
      setTgSaving(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-surface border-r border-border" style={{ width: 280 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-9 border-b border-border shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Settings</span>
        <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300 text-sm">×</button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4 relative">
        {/* Telegram Section */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="currentColor">
              <path d="M9.04 16.62l-.39 4.33c.56 0 .8-.24 1.1-.53l2.63-2.5 5.46 4c1 .55 1.72.26 1.98-.93l3.59-16.84.01-.01c.31-1.48-.54-2.06-1.52-1.7L1.4 9.6c-1.46.57-1.44 1.38-.25 1.75l5.1 1.59L18.1 5.68c.55-.37 1.06-.17.64.2L9.04 16.62z" />
            </svg>
            <span className="text-[12px] font-medium text-zinc-300">Telegram Bot</span>
            {tgRunning && (
              <span className="ml-auto flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Running</span>
              </span>
            )}
          </div>

          <p className="text-[12px] text-zinc-500 px-1 mb-3">
            Chat with Claude from Telegram. Create a bot with{' '}
            <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-zinc-300 hover:text-white underline">
              @BotFather
            </a>{' '}
            to get a token.
          </p>

          {!tgLoaded ? (
            <div className="text-[12px] text-zinc-600 px-1">Loading...</div>
          ) : (
            <div className="space-y-2.5">
              <div>
                <label className="block text-[11px] text-zinc-500 mb-1 px-1">Bot Token</label>
                <div className="relative">
                  <input
                    type={tgShowToken ? 'text' : 'password'}
                    value={tgBotToken}
                    onChange={(e) => setTgBotToken(e.target.value)}
                    placeholder="123456:ABC-DEF..."
                    className="w-full text-[12px] px-2.5 py-1.5 pr-14 rounded-md bg-surface-light border border-border focus:border-border-light focus:outline-none text-zinc-200 placeholder:text-zinc-600 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setTgShowToken((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
                  >
                    {tgShowToken ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-zinc-500 mb-1 px-1">Chat ID (optional)</label>
                <input
                  type="text"
                  value={tgChatId}
                  onChange={(e) => setTgChatId(e.target.value)}
                  placeholder="Restrict to a single chat"
                  className="w-full text-[12px] px-2.5 py-1.5 rounded-md bg-surface-light border border-border focus:border-border-light focus:outline-none text-zinc-200 placeholder:text-zinc-600 font-mono"
                />
                <p className="mt-1 text-[10px] text-zinc-600 px-1">
                  Leave blank to accept any chat. Send /start to the bot to see your chat ID.
                </p>
              </div>

              <button
                onClick={handleTelegramSave}
                disabled={tgSaving}
                className="w-full text-[12px] px-3 py-1.5 rounded-md font-medium text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-border hover:border-border-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {tgSaving ? 'Saving...' : tgSaved ? 'Saved' : 'Save & Restart Bot'}
              </button>

              {tgError && (
                <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5">
                  {tgError}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Deepgram Section */}
        <div className="pt-4 border-t border-border">
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 2a3 3 0 00-3 3v7a3 3 0 006 0V5a3 3 0 00-3-3z" />
              <path d="M19 10v2a7 7 0 01-14 0v-2" />
              <path d="M12 19v3M8 22h8" strokeLinecap="round" />
            </svg>
            <span className="text-[12px] font-medium text-zinc-300">Deepgram (Voice)</span>
            {dgConfigured && (
              <span className="ml-auto flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Configured</span>
              </span>
            )}
          </div>

          <p className="text-[12px] text-zinc-500 px-1 mb-3">
            Transcribe Telegram voice notes with Deepgram and forward the text to Claude. Get an API key at{' '}
            <a href="https://console.deepgram.com/signup" target="_blank" rel="noreferrer" className="text-zinc-300 hover:text-white underline">
              console.deepgram.com
            </a>
            .
          </p>

          {!dgLoaded ? (
            <div className="text-[12px] text-zinc-600 px-1">Loading...</div>
          ) : (
            <div className="space-y-2.5">
              <div>
                <label className="block text-[11px] text-zinc-500 mb-1 px-1">API Key</label>
                <div className="relative">
                  <input
                    type={dgShowKey ? 'text' : 'password'}
                    value={dgApiKey}
                    onChange={(e) => setDgApiKey(e.target.value)}
                    placeholder="Your Deepgram API key"
                    className="w-full text-[12px] px-2.5 py-1.5 pr-14 rounded-md bg-surface-light border border-border focus:border-border-light focus:outline-none text-zinc-200 placeholder:text-zinc-600 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setDgShowKey((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
                  >
                    {dgShowKey ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-zinc-500 mb-1 px-1">Model</label>
                <input
                  type="text"
                  value={dgModel}
                  onChange={(e) => setDgModel(e.target.value)}
                  placeholder="nova-3"
                  className="w-full text-[12px] px-2.5 py-1.5 rounded-md bg-surface-light border border-border focus:border-border-light focus:outline-none text-zinc-200 placeholder:text-zinc-600 font-mono"
                />
              </div>

              <div>
                <label className="block text-[11px] text-zinc-500 mb-1 px-1">Language</label>
                <input
                  type="text"
                  value={dgLanguage}
                  onChange={(e) => setDgLanguage(e.target.value)}
                  placeholder="multi"
                  className="w-full text-[12px] px-2.5 py-1.5 rounded-md bg-surface-light border border-border focus:border-border-light focus:outline-none text-zinc-200 placeholder:text-zinc-600 font-mono"
                />
                <p className="mt-1 text-[10px] text-zinc-600 px-1">
                  Use <code className="text-zinc-400">multi</code> to auto-detect, or a BCP-47 code (e.g. <code className="text-zinc-400">en</code>, <code className="text-zinc-400">es</code>).
                </p>
              </div>

              <button
                onClick={handleDeepgramSave}
                disabled={dgSaving}
                className="w-full text-[12px] px-3 py-1.5 rounded-md font-medium text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-border hover:border-border-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {dgSaving ? 'Saving...' : dgSaved ? 'Saved' : 'Save'}
              </button>

              {dgError && (
                <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5">
                  {dgError}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sessions Section */}
        <div className="pt-4 border-t border-border">
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            <span className="text-[12px] font-medium text-zinc-300">Sessions</span>
          </div>
          <Switch
            isSelected={autoGroupSessions}
            onChange={onToggleAutoGroup}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-md bg-surface-light border border-border hover:border-border-light transition-colors cursor-pointer"
          >
            <div className="flex-1 min-w-0 text-left">
              <div className="text-[12px] text-zinc-200">Auto-group new sessions</div>
              <div className="text-[10px] text-zinc-500 mt-0.5">
                Bucket new sessions into a tab group named after the project folder.
              </div>
            </div>
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
          </Switch>
        </div>

        {/* Tab Groups Section */}
        <div className="pt-4 border-t border-border">
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="7" height="7" rx="1" />
              <rect x="14" y="4" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            <span className="text-[12px] font-medium text-zinc-300">Tab Groups</span>
            {groupEntries.length > 0 && (
              <span className="ml-auto text-[10px] text-zinc-600 uppercase tracking-wider">
                {groupEntries.length}
              </span>
            )}
          </div>

          {groupEntries.length === 0 ? (
            <p className="text-[12px] text-zinc-500 px-1">
              No tab groups yet. Drag a tab onto another in the sidebar to create one.
            </p>
          ) : (
            <div className="space-y-1.5">
              {groupEntries.map((g) => {
                const memberCount = memberCountByGroup[g.id] || 0;
                const dotClass = GROUP_DOT_COLOR[g.color] || 'bg-zinc-400';
                const isConfirming = confirmingGroupId === g.id;
                const Icon = g.icon ? ICON_MAP[g.icon] : null;
                return (
                  <div
                    key={g.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-surface-light border border-border"
                  >
                    {Icon ? (
                      <Icon className="w-3.5 h-3.5 shrink-0 text-zinc-400" strokeWidth={1.75} aria-hidden />
                    ) : (
                      <span className={`w-2 h-2 rounded-full shrink-0 ${dotClass}`} />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] text-zinc-200 truncate">{g.name}</div>
                      <div className="text-[10px] text-zinc-600">
                        {memberCount} session{memberCount === 1 ? '' : 's'}
                      </div>
                    </div>
                    {isConfirming ? (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => setConfirmingGroupId(null)}
                          className="text-[11px] px-2 py-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => {
                            onDeleteGroup(g.id);
                            setConfirmingGroupId(null);
                          }}
                          className="text-[11px] px-2 py-1 rounded font-medium text-red-300 bg-red-500/15 hover:bg-red-500/25 border border-red-500/30"
                        >
                          Delete
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmingGroupId(g.id)}
                        title={memberCount > 0 ? `Delete group (${memberCount} session${memberCount === 1 ? '' : 's'} will be ungrouped)` : 'Delete group'}
                        className="shrink-0 p-1 rounded text-zinc-500 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                    )}
                  </div>
                );
              })}
              <p className="text-[10px] text-zinc-600 px-1 pt-1">
                Deleting a group ungroups its sessions — the sessions themselves are kept.
              </p>
            </div>
          )}
        </div>

        {/* Tailscale Funnel Section */}
        <div className="pt-4 border-t border-border">
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="5" cy="5" r="1.5" />
              <circle cx="12" cy="5" r="1.5" />
              <circle cx="19" cy="5" r="1.5" />
              <circle cx="5" cy="12" r="1.5" />
              <circle cx="12" cy="12" r="1.5" fill="currentColor" />
              <circle cx="19" cy="12" r="1.5" />
              <circle cx="5" cy="19" r="1.5" />
              <circle cx="12" cy="19" r="1.5" />
              <circle cx="19" cy="19" r="1.5" />
            </svg>
            <span className="text-[12px] font-medium text-zinc-300">Tailscale Funnel</span>
            {tsFunnelEnabled && (
              <span className="ml-auto flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                <span className="text-[10px] text-zinc-500 uppercase tracking-wider">On</span>
              </span>
            )}
          </div>

          <p className="text-[12px] text-zinc-500 px-1 mb-3">
            Expose this UI publicly via{' '}
            <a href="https://tailscale.com/kb/1223/funnel" target="_blank" rel="noreferrer" className="text-zinc-300 hover:text-white underline">
              Tailscale Funnel
            </a>
            {' '}so your phone can connect from any network. Pairing still requires the bearer token.
          </p>

          {!tsLoaded ? (
            <div className="text-[12px] text-zinc-600 px-1">Loading...</div>
          ) : !tsAvailable ? (
            <div className="text-[11px] text-zinc-500 bg-surface-light border border-border rounded px-2.5 py-2">
              Tailscale CLI not found. Install Tailscale and sign in to enable Funnel.
            </div>
          ) : (
            <div className="space-y-2.5">
              <Switch
                isSelected={tsFunnelEnabled}
                onChange={(next) => handleTailscaleToggle(next)}
                isDisabled={tsToggling}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-md bg-surface-light border border-border hover:border-border-light transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="flex-1 text-left text-[12px] text-zinc-200">
                  {tsToggling ? 'Updating…' : tsFunnelEnabled ? 'Funnel enabled' : 'Enable Funnel'}
                </span>
                <SwitchControl>
                  <SwitchThumb />
                </SwitchControl>
              </Switch>

              {tsHostname && (
                <div className="text-[10px] text-zinc-600 px-1">
                  Host: <span className="font-mono text-zinc-500">{tsHostname}</span>
                </div>
              )}

              {tsError && (
                <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5 whitespace-pre-wrap">
                  {tsError}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Mobile Section */}
        <div className="pt-4 border-t border-border">
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="6" y="2" width="12" height="20" rx="2" />
              <path d="M11 18h2" />
            </svg>
            <span className="text-[12px] font-medium text-zinc-300">Mobile</span>
          </div>
          <p className="text-[12px] text-zinc-500 px-1 mb-3">
            Open this UI on your phone to approve permission requests remotely.
          </p>
          <button
            onClick={() => setPairOpen(true)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-[12px] font-medium text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-border hover:border-border-light transition-colors"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <path d="M14 14h3v3M21 14v3h-3M14 21v-3h3M21 21h-3" strokeLinecap="round" />
            </svg>
            Pair Phone
          </button>
        </div>

        {/* Plugin-contributed settings sections (sideloaded from ~/.codiby/plugins/) */}
        <div className="pt-4 border-t border-border space-y-4">
          <PluginSettingsSections />
        </div>
      </div>

      {pairOpen && <PairPhoneModal onClose={() => setPairOpen(false)} />}
    </div>
  );
}
