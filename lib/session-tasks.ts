/** Ownership of a session's operations, including commands without ctx.signal. */
export class SessionTasks {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();

  async run<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const combined = signal ? AbortSignal.any([this.controller.signal, signal]) : this.controller.signal;
    combined.throwIfAborted();
    const task = work(combined);
    this.pending.add(task);
    try { return await task; }
    finally { this.pending.delete(task); }
  }

  async close(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled([...this.pending]);
  }
}
