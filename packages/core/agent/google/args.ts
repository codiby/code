/**
 * Argument readers for the Google tools. The model fills these in, so every
 * value is checked for type and size before it reaches a URL or a header, and
 * a mistake comes back as a message it can fix on the next call.
 */

/** A problem with the tool call itself (bad input, level too low): shown to the model verbatim. */
export class ToolInputError extends Error {}

type Args = Record<string, unknown>;

export function optString(args: Args, key: string, opts: { max?: number; trim?: boolean } = {}): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolInputError(`${key} must be a string`);
  const s = opts.trim === false ? v : v.trim();
  const max = opts.max ?? 1000;
  if (s.length > max) throw new ToolInputError(`${key} is too long (max ${max} characters)`);
  return s;
}

export function reqString(args: Args, key: string, opts: { max?: number; trim?: boolean } = {}): string {
  const s = optString(args, key, opts);
  if (s === undefined || s === '') throw new ToolInputError(`${key} is required`);
  return s;
}

export function optBool(args: Args, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ToolInputError(`${key} must be true or false`);
  return v;
}

export function optInt(args: Args, key: string, opts: { min: number; max: number; fallback: number }): number {
  const v = args[key];
  if (v === undefined || v === null) return opts.fallback;
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new ToolInputError(`${key} must be a whole number`);
  if (n < opts.min || n > opts.max) throw new ToolInputError(`${key} must be between ${opts.min} and ${opts.max}`);
  return n;
}

/** A string or a list of strings (labels, calendar ids). */
export function optStringList(args: Args, key: string, opts: { maxItems?: number; maxLength?: number } = {}): string[] {
  const v = args[key];
  if (v === undefined || v === null || v === '') return [];
  const list = Array.isArray(v) ? v : [v];
  const maxItems = opts.maxItems ?? 20;
  if (list.length > maxItems) throw new ToolInputError(`${key}: at most ${maxItems} items`);
  return list.map(item => {
    if (typeof item !== 'string' || !item.trim()) throw new ToolInputError(`${key} must be a list of non-empty strings`);
    const s = item.trim();
    if (s.length > (opts.maxLength ?? 200)) throw new ToolInputError(`${key}: "${s.slice(0, 30)}…" is too long`);
    return s;
  });
}

export function optEnum<T extends string>(args: Args, key: string, values: readonly T[]): T | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    throw new ToolInputError(`${key} must be one of: ${values.join(', ')}`);
  }
  return v as T;
}

/** Gmail message / Calendar event ids: opaque, but never anything that could change the URL's shape. */
export function reqId(args: Args, key: string): string {
  const id = reqString(args, key, { max: 1024 });
  if (!/^[A-Za-z0-9_.@-]+$/.test(id)) throw new ToolInputError(`${key} doesn't look like a valid id`);
  return id;
}
