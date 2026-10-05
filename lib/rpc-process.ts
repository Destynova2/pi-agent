import { PassThrough } from "node:stream";
import { runProcess } from "./process.ts";

interface Options {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  maxLineBytes?: number;
  onRequest?: (method: string, params: unknown) => unknown | Promise<unknown>;
  onStderr?: (chunk: Buffer) => void;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  clear(): void;
}

/** Bounded JSON-lines transport. A canceled/timed-out request stops the whole process group. */
export class RpcProcess {
  private readonly options: Options;
  private readonly input = new PassThrough();
  private readonly controller = new AbortController();
  private readonly pending = new Map<number, Pending>();
  private completion?: Promise<void>;
  private failure?: Error;
  private stopReason?: Error;
  private buffer = Buffer.alloc(0);
  private nextId = 0;

  constructor(options: Options) { this.options = options; }

  get alive(): boolean { return !!this.completion && !this.failure && !this.controller.signal.aborted; }

  start(): void {
    if (this.completion) return;
    this.completion = runProcess(this.options.command, this.options.args, {
      cwd: this.options.cwd, env: this.options.env, input: this.input,
      signal: this.controller.signal, timeoutMs: 12 * 60 * 60 * 1000,
      maxBytes: 128 * 1024 * 1024, onStdout: chunk => this.receive(chunk), onStderr: this.options.onStderr,
    }).then(() => this.fail(new Error("RPC process exited")), error => {
      const canceled = this.controller.signal.aborted && error.message === `${this.options.command}: operation canceled`;
      this.fail(canceled ? this.stopReason ?? error : error);
      if (!canceled) throw error;
    });
    // Retain the rejected completion for shutdown while avoiding an unhandled rejection.
    void this.completion.catch(() => {});
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const call of this.pending.values()) { call.clear(); call.reject(error); }
    this.pending.clear();
  }

  private receive(chunk: Buffer): void {
    if (this.controller.signal.aborted) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let end: number;
    const limit = this.options.maxLineBytes ?? 8 * 1024 * 1024;
    while ((end = this.buffer.indexOf(10)) !== -1) {
      if (end > limit) throw new Error("RPC response exceeds frame limit");
      const line = this.buffer.subarray(0, end).toString("utf8");
      this.buffer = this.buffer.subarray(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid RPC response");
      if (typeof message.method === "string") {
        void this.respond(message);
      } else {
        const call = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
        if (!call) continue;
        this.pending.delete(message.id as number);
        call.clear();
        if (message.error !== undefined) call.reject(new Error(typeof message.error === "string" ? message.error : JSON.stringify(message.error)));
        else call.resolve(message.result);
      }
    }
    if (this.buffer.length > limit) throw new Error("RPC response exceeds frame limit");
  }

  private async respond(message: Record<string, unknown>): Promise<void> {
    try {
      if (!this.options.onRequest) throw new Error(`Unsupported server request: ${message.method}`);
      const result = await this.options.onRequest(message.method as string, message.params);
      if (message.id !== undefined) this.send({ jsonrpc: "2.0", id: message.id, result: result ?? null });
    } catch (error) {
      if (message.id !== undefined && !this.controller.signal.aborted && !this.failure) {
        this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: String(error) } });
      }
    }
  }

  private send(message: unknown): void {
    if (!this.completion || this.failure || this.controller.signal.aborted) throw this.failure ?? new Error("RPC process is not running");
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > (this.options.maxLineBytes ?? 8 * 1024 * 1024)) throw new Error("RPC request exceeds frame limit");
    this.input.write(line);
  }

  notify(method: string, params: unknown): void { this.send({ jsonrpc: "2.0", method, params }); }

  async request(method: string, params: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    options.signal?.throwIfAborted();
    if (!this.completion || this.failure || this.controller.signal.aborted) throw this.failure ?? new Error("RPC process is not running");
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const cancel = (reason: string) => {
        this.stopReason ??= new Error(reason);
        this.controller.abort();
      };
      const abort = () => cancel("RPC request canceled");
      const timer = setTimeout(() => cancel("RPC request timed out"), options.timeoutMs ?? this.options.requestTimeoutMs ?? 60_000);
      const clear = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { resolve, reject, clear });
      options.signal?.addEventListener("abort", abort, { once: true });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { this.pending.delete(id); clear(); reject(error); }
      if (options.signal?.aborted) abort();
    });
  }

  async shutdown(): Promise<void> {
    this.stopReason ??= new Error("RPC process stopped");
    this.controller.abort();
    this.input.end();
    await this.completion;
  }
}
