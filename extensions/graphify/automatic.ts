import { SessionTasks } from "../../lib/session-tasks.ts";

/** One background indexing task per session, cancelable before any transition. */
export class AutomaticIndex<T> {
  private tasks = new SessionTasks();
  private pending: Promise<T> | undefined;
  private closed = false;

  start(work: (signal: AbortSignal) => Promise<T>, completed: (result: T) => void, failed: (error: unknown) => void): void {
    if (this.pending || this.closed) return;
    const task = this.tasks.run(work);
    this.pending = task;
    void task.then(
      (result) => { if (!this.closed) completed(result); },
      (error) => { if (!this.closed) failed(error); },
    ).catch(() => undefined).finally(() => {
      if (this.pending === task) this.pending = undefined;
    });
  }

  async wait(): Promise<void> {
    await this.pending?.catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tasks.close();
    await this.wait();
  }
}
