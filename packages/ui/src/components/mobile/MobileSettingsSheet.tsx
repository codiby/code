import { useEffect, useState } from 'react';
import { Button, Switch, SwitchControl, SwitchThumb } from '@heroui/react';
import { BottomSheet } from './BottomSheet';
import { resolveServerUrl, getAuthToken, setAuthToken } from '../../lib/claude-client';

interface Props {
  open: boolean;
  onClose: () => void;
  /** A newer build is installed and waiting. The app never applies it by
   *  itself — "Force refresh" is the only thing that swaps it in. */
  updateReady?: boolean;
  refreshing?: boolean;
  onForceRefresh?: () => void;
}

export function MobileSettingsSheet({ open, onClose, updateReady, refreshing, onForceRefresh }: Props) {
  const [token, setToken] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [tgRunning, setTgRunning] = useState<boolean | null>(null);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [autoGroupSessions, setAutoGroupSessions] = useState(false);

  useEffect(() => {
    if (!open) return;
    setToken(getAuthToken());
    resolveServerUrl().then(setServerUrl);
  }, [open]);

  useEffect(() => {
    if (!serverUrl || !open) return;
    fetch(`${serverUrl}/telegram/settings`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setTgRunning(!!d.running); })
      .catch(() => {});
  }, [serverUrl, token, open]);

  useEffect(() => {
    if (!serverUrl || !open) return;
    fetch(`${serverUrl}/preferences`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && typeof d.autoGroupSessions === 'boolean') setAutoGroupSessions(d.autoGroupSessions); })
      .catch(() => {});
  }, [serverUrl, token, open]);

  const toggleAutoGroup = (next: boolean) => {
    setAutoGroupSessions(next);
    if (!serverUrl) return;
    fetch(`${serverUrl}/preferences`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ autoGroupSessions: next }),
    }).catch(() => {});
  };

  const sendTest = async () => {
    if (!serverUrl) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch(`${serverUrl}/mobile/notify-test`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ message: 'Test notification from Claude Mobile' }),
      });
      setTestResult(r.ok ? 'Sent — check Telegram.' : `Failed (HTTP ${r.status})`);
    } catch (e) {
      setTestResult(String(e));
    } finally {
      setTesting(false);
    }
  };

  const copyToken = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const forgetToken = () => {
    if (!confirm('Forget pairing token on this device? You will need to scan the QR code again.')) return;
    try { localStorage.removeItem('mobileToken'); } catch {}
    setAuthToken(null);
    location.reload();
  };

  const isStandalone =
    typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
      // iOS Safari
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window.navigator as any).standalone === true);

  return (
    <BottomSheet open={open} onClose={onClose} title="Settings">
      <div className="space-y-5">
        {/* Sessions */}
        <section>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2 px-1">
            Sessions
          </div>
          <Switch
            isSelected={autoGroupSessions}
            onChange={toggleAutoGroup}
            className="w-full flex items-center gap-3 p-3 rounded-xl bg-white/5 border border-white/10 active:bg-white/10 cursor-pointer"
          >
            <div className="flex-1 min-w-0 text-left">
              <div className="text-sm font-medium text-zinc-100">Auto-group new sessions</div>
              <div className="text-[11px] text-zinc-500 mt-0.5">
                Bucket new sessions into a tab group named after the project folder.
              </div>
            </div>
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
          </Switch>
        </section>

        {/* Notifications */}
        <section>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2 px-1">
            Notifications
          </div>
          <div className="rounded-xl bg-white/5 border border-white/10 p-3">
            <div className="flex items-center gap-2 text-sm text-zinc-200">
              Telegram bot
              <span className="ml-auto flex items-center gap-1.5 text-[11px]">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    tgRunning ? 'bg-green-400' : tgRunning === false ? 'bg-zinc-600' : 'bg-amber-400'
                  }`}
                />
                <span className="text-zinc-400">
                  {tgRunning ? 'Running' : tgRunning === false ? 'Off' : 'Checking…'}
                </span>
              </span>
            </div>
            <p className="text-[11px] text-zinc-500 mt-1.5 leading-relaxed">
              Configure the bot from the desktop app to receive permission alerts and turn-complete pings.
            </p>
            <Button
              variant="ghost"
              fullWidth
              onPress={sendTest}
              isDisabled={testing}
              className="mt-3 h-auto min-w-0 min-h-12 rounded-xl bg-white/5 border border-white/10 text-sm text-zinc-200 font-medium active:bg-white/10 disabled:opacity-50"
            >
              {testing ? 'Sending…' : 'Send test notification'}
            </Button>
            {testResult && <div className="text-[11px] text-zinc-400 mt-2 px-1">{testResult}</div>}
          </div>
        </section>

        {/* App / updates */}
        {onForceRefresh && (
          <section>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2 px-1">
              App
            </div>
            <div className="rounded-xl bg-white/5 border border-white/10 p-3">
              <div className="flex items-center gap-2 text-sm text-zinc-200">
                Version
                <span className="ml-auto flex items-center gap-1.5 text-[11px]">
                  <span className={`w-1.5 h-1.5 rounded-full ${updateReady ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                  <span className="text-zinc-400">{updateReady ? 'Update ready' : 'Up to date'}</span>
                </span>
              </div>
              <p className="text-[11px] text-zinc-500 mt-1.5 leading-relaxed">
                New builds install in the background but never reload the app on their own.
                Tap below to drop the cached bundle and load the latest one.
              </p>
              <Button
                variant="ghost"
                fullWidth
                onPress={onForceRefresh}
                isDisabled={refreshing}
                className={`mt-3 h-auto min-w-0 min-h-12 rounded-xl border text-sm font-medium disabled:opacity-50 ${
                  updateReady
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200 active:bg-emerald-500/25'
                    : 'bg-white/5 border-white/10 text-zinc-200 active:bg-white/10'
                }`}
              >
                {refreshing ? 'Refreshing…' : 'Force refresh'}
              </Button>
            </div>
          </section>
        )}

        {/* Pairing / token */}
        <section>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2 px-1">
            This device
          </div>
          <div className="rounded-xl bg-white/5 border border-white/10 p-3 space-y-3">
            <div>
              <div className="text-[11px] text-zinc-500 mb-1">Pairing token</div>
              <div className="font-mono text-[11px] text-zinc-300 break-all bg-black/30 rounded-lg p-2">
                {token ? (showToken ? token : token.slice(0, 8) + '…' + token.slice(-4)) : '(none)'}
              </div>
              <div className="flex gap-2 mt-2">
                <Button
                  variant="ghost"
                  onPress={() => setShowToken((v) => !v)}
                  className="flex-1 h-auto min-w-0 min-h-10 rounded-lg bg-white/5 border border-white/10 text-[12px] text-zinc-200 active:bg-white/10"
                >
                  {showToken ? 'Hide' : 'Show'}
                </Button>
                <Button
                  variant="ghost"
                  onPress={copyToken}
                  isDisabled={!token}
                  className="flex-1 h-auto min-w-0 min-h-10 rounded-lg bg-white/5 border border-white/10 text-[12px] text-zinc-200 active:bg-white/10 disabled:opacity-50"
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
                <Button
                  variant="ghost"
                  onPress={forgetToken}
                  isDisabled={!token}
                  className="flex-1 h-auto min-w-0 min-h-10 rounded-lg bg-red-500/10 border border-red-500/30 text-[12px] text-red-300 active:bg-red-500/20 disabled:opacity-50"
                >
                  Forget
                </Button>
              </div>
            </div>
            <div className="text-[11px] text-zinc-500">
              Server: <span className="font-mono text-zinc-300">{serverUrl || '…'}</span>
            </div>
          </div>
        </section>

        {/* Install hint */}
        {!isStandalone && (
          <section>
            <div className="rounded-xl bg-indigo-500/10 border border-indigo-500/30 p-3 text-[12px] text-indigo-100 leading-relaxed">
              <div className="font-medium mb-1">Install as an app</div>
              <ul className="list-disc list-inside text-indigo-200/80 space-y-0.5">
                <li>iOS Safari: Share → Add to Home Screen</li>
                <li>Android Chrome: ⋮ menu → Install app</li>
              </ul>
            </div>
          </section>
        )}
      </div>
    </BottomSheet>
  );
}
