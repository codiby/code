import { useEffect, useState } from 'react';
import type { ClaudeClient } from './claude-client';

export type CodexInfo = { available: boolean; models: { id: string; label: string; isDefault: boolean; efforts: string[] }[]; error?: string };
const cache = new WeakMap<ClaudeClient, Map<string, { expires: number; promise: Promise<CodexInfo> }>>();
function fetchModels(client: ClaudeClient, remoteId?: string | null) {
  let hosts = cache.get(client);
  if (!hosts) { hosts = new Map(); cache.set(client, hosts); }
  const key = remoteId || '';
  const cached = hosts.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const entry = { expires: Date.now() + 60000, promise: client.getCodexInfo(remoteId) };
  hosts.set(key, entry);
  entry.promise.then(info => { if (!info.available) entry.expires = Date.now() + 5000; }, () => { hosts!.delete(key); });
  return entry.promise;
}
export function useCodexModels(client: ClaudeClient | null, enabled: boolean, remoteId?: string | null) {
  const [result, setResult] = useState<{ client: ClaudeClient; host: string; info: CodexInfo } | null>(null);
  useEffect(() => {
    if (!enabled || !client) return;
    let cancelled = false;
    fetchModels(client, remoteId).then(info => { if (!cancelled) setResult({ client, host: remoteId || '', info }); }, error => {
      if (!cancelled) setResult({ client, host: remoteId || '', info: { available: false, models: [], error: String(error) } });
    });
    return () => { cancelled = true; };
  }, [client, enabled, remoteId]);
  const info = result?.client === client && result?.host === (remoteId || '') ? result.info : null;
  return { info, loading: enabled && !!client && !info };
}
export function codexEfforts(info: CodexInfo | null, model?: string | null) {
  const selected = model ? info?.models.find(m => m.id === model) : info?.models.find(m => m.isDefault);
  return (selected?.efforts || []).map(id => ({ id, label: id === 'xhigh' ? 'X-High' : id.charAt(0).toUpperCase() + id.slice(1) }));
}
