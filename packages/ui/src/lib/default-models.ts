/**
 * User-chosen default model per provider, set with `/default <model>`.
 *
 * Lives in each bridge's preferences as `defaultModels: { [provider]: modelId }`;
 * the bridge runs every session without a model of its own on it.
 */

export type ModelChoice = { id: string; label: string; description?: string; isDefault?: boolean; providerName?: string };

export function readDefaultModels(prefs: Record<string, unknown>): Record<string, string> {
  const raw = prefs.defaultModels;
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1].trim()),
  );
}

function choiceLabel(m: ModelChoice): string {
  return m.providerName ? `${m.providerName} ${m.label}` : m.label;
}

/** What "Default" resolves to, for the selector's `Default (…)` label: the
 *  user's pick when there is one, else whatever the provider itself reports
 *  as its default (Claude's SDK "default" entry, Codex's `isDefault`). */
export function defaultModelLabel(configured: string | undefined, choices: ModelChoice[]): string | null {
  if (configured) {
    const hit = choices.find(m => m.id === configured);
    return hit ? choiceLabel(hit) : configured;
  }
  const sdkDefault = choices.find(m => m.id === 'default');
  if (sdkDefault?.description) return sdkDefault.description.split(' · ')[0].trim() || null;
  const flagged = choices.find(m => m.isDefault);
  return flagged ? choiceLabel(flagged) : null;
}

/** Match what the user typed after `/default` to a model id: exact id first,
 *  then a case-insensitive id or label match, else the text as-is. */
export function resolveModelArg(arg: string, choices: ModelChoice[]): string {
  const q = arg.trim().toLowerCase();
  return (
    choices.find(m => m.id === arg.trim())
    ?? choices.find(m => m.id.toLowerCase() === q || m.label.toLowerCase() === q || choiceLabel(m).toLowerCase() === q)
  )?.id ?? arg.trim();
}
