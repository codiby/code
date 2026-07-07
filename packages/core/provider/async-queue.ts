/**
 * Push/pull async queue that bridges an imperative producer to an
 * `AsyncIterable` consumer.
 *
 * A producer calls `push(item)` whenever an item is ready; a consumer drives it
 * with `for await (const item of queue)`. When there's no buffered item the
 * consumer's `next()` parks on a promise that `push()` resolves, so no polling.
 * `close()` ends the iteration cleanly (the iterator returns `done: true`).
 *
 * This lives in the shared provider layer so any adapter whose SDK consumes an
 * `AsyncIterable` prompt stream (e.g. the Claude Agent SDK's continuous
 * `query()`) can reuse it instead of reimplementing the buffering.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private pendingResolve: ((value: IteratorResult<T>) => void) | null = null;
  private closed = false;

  /** Enqueue an item (or hand it straight to a parked consumer). No-op once closed. */
  push(item: T): void {
    if (this.closed) return;
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  /** End the stream. A parked consumer is resolved with `done: true`. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise((resolve) => {
          this.pendingResolve = resolve;
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined as unknown as T, done: true });
      },
    };
  }
}
