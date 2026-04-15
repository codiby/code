import { useState, useEffect } from 'react';

interface ArchitectUser {
  role: string;
  githubUsername: string;
  displayName: string | null;
  email: string;
  avatarUrl: string;
}

async function resolveServerUrl(): Promise<string> {
  if ((window as any).__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import(/* @vite-ignore */ '@tauri-apps/api/core');
      const port = await invoke<number>('get_bridge_port');
      return `http://localhost:${port}`;
    } catch {}
  }
  return (import.meta as any).env?.PUBLIC_CLAUDE_SERVER_URL || 'http://localhost:3100';
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [user, setUser] = useState<ArchitectUser | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState<string | null>(null);

  useEffect(() => { resolveServerUrl().then(setServerUrl); }, []);

  const fetchStatus = async () => {
    if (!serverUrl) return;
    setLoading(true);
    setError(null);
    try {
      const credRes = await fetch(`${serverUrl}/architect/credentials`);
      if (!credRes.ok) {
        setIsLoggedIn(false);
        setUser(null);
        return;
      }
      const creds = await credRes.json();
      const loggedIn = creds.sessionToken != null;
      setIsLoggedIn(loggedIn);

      if (loggedIn) {
        try {
          const userRes = await fetch(`${serverUrl}/architect/me`);
          if (userRes.ok) {
            setUser(await userRes.json());
          } else {
            setUser(null);
          }
        } catch {
          setUser(null);
        }
      } else {
        setUser(null);
      }
    } catch {
      // Bridge server might not support architect endpoints yet
      setIsLoggedIn(false);
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (serverUrl) fetchStatus(); }, [serverUrl]);

  const isTauri = !!(window as any).__TAURI_INTERNALS__;

  const handleLogin = async () => {
    if (!isTauri) {
      setError('Login requires the Tauri desktop app');
      return;
    }
    setLoggingIn(true);
    setError(null);
    try {
      const { invoke } = await import(/* @vite-ignore */ '@tauri-apps/api/core');
      await invoke<string>('architect_login');
      await fetchStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    if (!serverUrl) return;
    try {
      await fetch(`${serverUrl}/architect/credentials`, { method: 'DELETE' });
      setIsLoggedIn(false);
      setUser(null);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="h-full flex flex-col bg-surface border-r border-border" style={{ width: 280 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-9 border-b border-border shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Settings</span>
        <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300 text-sm">×</button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* Architect Section */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
            <span className="text-[12px] font-medium text-zinc-300">The Architect</span>
          </div>

          {loading ? (
            <div className="text-[12px] text-zinc-600 px-1">Loading...</div>
          ) : isLoggedIn ? (
            <div className="space-y-3">
              {/* User Info */}
              <div className="flex items-center gap-3 p-2.5 rounded-lg bg-surface-light border border-border">
                {user?.avatarUrl ? (
                  <img src={user.avatarUrl} alt="" className="w-8 h-8 rounded-full shrink-0" />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-zinc-700 flex items-center justify-center shrink-0">
                    <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
                      <circle cx="12" cy="7" r="4" />
                    </svg>
                  </div>
                )}
                <div className="min-w-0">
                  <div className="text-[12px] text-zinc-200 font-medium truncate">
                    {user?.githubUsername || 'Connected'}
                  </div>
                  {user?.email && (
                    <div className="text-[11px] text-zinc-500 truncate">{user.email}</div>
                  )}
                  {user?.role && (
                    <div className="text-[10px] text-zinc-600 uppercase tracking-wider mt-0.5">{user.role}</div>
                  )}
                </div>
              </div>

              {/* Connection Status */}
              <div className="flex items-center gap-2 px-1">
                <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                <span className="text-[11px] text-zinc-500">Session active</span>
              </div>

              {/* Logout */}
              <button
                onClick={handleLogout}
                className="w-full text-[12px] px-3 py-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 transition-colors"
              >
                Sign out
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-[12px] text-zinc-500 px-1">
                Connect to The Architect to access engineering boards, signals, and AI features.
              </p>
              <button
                onClick={handleLogin}
                disabled={loggingIn}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-[12px] font-medium text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-border hover:border-border-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loggingIn ? (
                  <>
                    <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round" />
                    </svg>
                    Signing in...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                    </svg>
                    Sign in with GitHub
                  </>
                )}
              </button>
            </div>
          )}

          {error && (
            <div className="mt-2 text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
