/**
 * Errors from the memory and people stores. Routes map them to HTTP status
 * codes and tools to `isError` results, so the stores never depend on either.
 */

export type MemoryErrorCode = 'invalid' | 'not_found' | 'secret' | 'conflict';

const STATUS: Record<MemoryErrorCode, number> = { invalid: 400, not_found: 404, secret: 422, conflict: 409 };

export class MemoryError extends Error {
  constructor(readonly code: MemoryErrorCode, message: string) {
    super(message);
  }

  get status(): number {
    return STATUS[this.code];
  }
}
