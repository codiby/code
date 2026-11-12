/**
 * Personal Agent (legacy) — superseded by the Codiby Agent's channels
 * (packages/core/agent/channels). Its `~/.codiby/personal-agent.json` is read
 * once, on first boot, by agent/channels/config.ts (migrateLegacyChannels)
 * and left in place.
 *
 * What remains here are the shell-quoting helpers the old `cli_command`
 * outbound used. Channels no longer run shell commands (wacli is spawned
 * with an argv array), but the helpers stay for anything that still builds
 * a command line from model-written text.
 */

/** Quote a value as one POSIX shell word: `it's` → `'it'\''s'`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Substitute `{{text}}`, `{{session_id}}`, … in a command template. Each
 * value becomes a single shell-quoted word: the text is written by the model,
 * and the model reads untrusted content, so splicing it in raw
 * (`wa text 52… {{text}}` with a reply of `hi; rm -rf ~`) would run whatever
 * it said. Unknown placeholders become an empty word.
 */
export function substitutePlaceholders(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? shellQuote(vars[key]!) : "''"));
}
