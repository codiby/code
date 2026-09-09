import { CodexAppServer, listCodexModels } from '../provider/codex-app-server';

export type CodexInfo = {
  available: boolean;
  models: { id: string; label: string; isDefault: boolean; efforts: string[] }[];
  error?: string;
};
let cached: { info: CodexInfo; expires: number } | null = null;
let inflight: Promise<CodexInfo> | null = null;

export async function getCodexInfo(): Promise<CodexInfo> {
  if (cached && cached.expires > Date.now()) return cached.info;
  if (inflight) return inflight;
  inflight = (async () => {
    let rpc: CodexAppServer | null = null;
    try {
      rpc = new CodexAppServer({ notification() {}, async request(method) { throw new Error(`Unexpected catalog request: ${method}`); }, exit() {} });
      const models = await listCodexModels(rpc);
      return { available: true, models: models.map(m => ({ id: m.model, label: m.displayName, isDefault: m.isDefault, efforts: m.supportedReasoningEfforts.map(e => e.reasoningEffort) })) };
    } catch (error) {
      return { available: false, models: [], error: error instanceof Error ? error.message : String(error) };
    } finally { await rpc?.close(); }
  })();
  const info = await inflight;
  cached = { info, expires: Date.now() + (info.available ? 60000 : 5000) };
  inflight = null;
  return info;
}
