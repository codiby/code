import { useState } from 'react';
import { Check, Copy, Hash, Loader2 } from 'lucide-react';
import type { ClaudeClient, SlackStatus } from '../lib/claude-client';

const open = (url: string) => window.open(url, '_blank', 'noopener');

interface Props {
  client: ClaudeClient | null;
  /** The project the connection belongs to. */
  projectId: string;
  status?: SlackStatus;
  /** A connection made before projects had their own, if there is one. */
  legacy?: SlackStatus;
  manifest: string;
}

/**
 * A project's Slack connection: who it's connected as, or how to connect it.
 * Each project gets its own Slack app (Socket Mode); the tokens stay on this
 * machine's bridge.
 */
export function SlackConnect({ client, projectId, status, legacy, manifest }: Props) {
  const [appToken, setAppToken] = useState('');
  const [userToken, setUserToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  // A plain render function, not a component: an inner component would be a
  // new type every render and the inputs would lose focus on each keystroke.
  const form = () => (
      <div className="flex flex-col gap-3 mt-1">
        <ol className="slk-steps">
          <li>
            <b>Create an app from this manifest</b> in <a onClick={() => open('https://api.slack.com/apps?new_app=1')}>api.slack.com/apps</a> (“From a manifest”, pick the workspace):
            <div className="slk-manifest">
              <pre>{manifest || '…'}</pre>
              <button type="button" className="slk-btn" onClick={() => { void navigator.clipboard.writeText(manifest); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </li>
          <li><b>App-level token:</b> Basic Information → App-Level Tokens, scope <code>connections:write</code> (<code>xapp-…</code>).</li>
          <li><b>User token:</b> Install App → Install to Workspace → <i>User OAuth Token</i> (<code>xoxp-…</code>).</li>
        </ol>
        <input className="slk-input" value={appToken} onChange={e => setAppToken(e.target.value)} placeholder="App-level token  xapp-…" spellCheck={false} />
        <input className="slk-input" value={userToken} onChange={e => setUserToken(e.target.value)} placeholder="User OAuth token  xoxp-…" spellCheck={false} />
        <div>
          <button
            type="button" className="slk-btn acc" disabled={busy || !appToken || !userToken || !client}
            onClick={() => run(() => client!.connectSlack(projectId, appToken, userToken))}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Hash size={13} />} Connect
          </button>
        </div>
      </div>
  );

  if (status && status.state !== 'off') {
    const dot = status.state === 'connected' ? 'var(--dot-run)' : status.state === 'error' ? 'var(--dot-err)' : 'var(--dot-wait)';
    return (
      <div className="slk-box">
        <div className="flex items-center gap-2.5">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dot }} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-zinc-200 truncate">{status.team ?? 'Slack'}</div>
            <div className="text-[12px] text-zinc-500 truncate">
              {status.state === 'connected' ? `Connected as ${status.user}` : status.state === 'error' ? status.error : 'Connecting…'}
            </div>
          </div>
          <button type="button" className="slk-btn" disabled={busy} onClick={() => run(() => client!.disconnectSlack(projectId))}>Disconnect</button>
        </div>
        {status.state === 'error' && (
          <button type="button" className="slk-link mt-2" onClick={() => setShowForm(s => !s)}>Replace the tokens</button>
        )}
        {showForm && form()}
        {error && <div className="slk-error">{error}</div>}
      </div>
    );
  }


  return (
    <div className="slk-box">
      <p className="text-[12.5px] text-zinc-400 m-0">
        Mentions, DMs and replies in your threads from this project's workspace land in its Inbox as they happen.
        Each project uses its own Slack app; the tokens stay on this machine.
      </p>
      {legacy && legacy.state !== 'off' && !showForm && (
        <div className="flex items-center gap-2 mt-3">
          <button type="button" className="slk-btn acc" disabled={busy || !client} onClick={() => run(() => client!.moveSlack('default', projectId))}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Hash size={13} />} Use the {legacy.team ?? 'existing'} connection
          </button>
          <span className="text-[12px] text-zinc-500">or</span>
          <button type="button" className="slk-link" onClick={() => setShowForm(true)}>connect another workspace</button>
        </div>
      )}
      {(!legacy || legacy.state === 'off' || showForm) && form()}
      {error && <div className="slk-error">{error}</div>}
    </div>
  );
}
