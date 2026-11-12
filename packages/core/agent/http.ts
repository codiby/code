/** Response helpers shared by agent routes. */

import { timingSafeEqual } from 'crypto';
import { corsHeaders } from '../config/config';

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders });
}

export function errorJson(message: string, status = 400): Response {
  return json({ error: message }, status);
}

export async function readBody<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    const text = await req.text();
    if (!text.trim()) return {} as T;
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'Request body must be JSON');
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Constant-time string comparison for shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}
