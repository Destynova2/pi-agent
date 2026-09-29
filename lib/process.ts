import { spawn } from "node:child_process";

interface Options {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  graceMs?: number;
  env?: NodeJS.ProcessEnv;
  /** When supplied, stdout chunks stream here instead of being buffered; the resolved value is then empty. */
  onStdout?: (chunk: Buffer) => void;
}

/** Executes without a shell and stops the POSIX group before honoring a cancellation. */
export function runProcess(program: string, args: string[], options: Options): Promise<string> {
  if (process.platform === "win32") return Promise.reject(new Error("POSIX supervision required"));
  if (options.signal?.aborted) return Promise.reject(new Error("Operation canceled"));
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.env, NO_COLOR: "1" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let stopping = false;
    let closed = false;
    let killSent = false;
    let stopError: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let reapDeadline: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => stop(new Error(`${program}: deadline exceeded`)), options.timeoutMs ?? 180_000);
    const abort = () => stop(new Error(`${program}: operation canceled`));
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(escalation);
      clearTimeout(reapDeadline);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(Buffer.concat(stdout).toString("utf8").trim());
    };
    const killGroup = (signal: NodeJS.Signals | 0): boolean => {
      if (child.pid === undefined) return false;
      try { process.kill(-child.pid, signal); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        return false;
      }
    };
    function stop(error: Error) {
      if (stopping || settled) return;
      stopping = true;
      stopError = error;
      try {
        if (!killGroup("SIGTERM") && closed) { finish(error); return; }
      } catch (failure) { finish(failure as Error); return; }
      // Do not cancel the escalation if the parent exits before its descendants.
      escalation = setTimeout(() => {
        try {
          killGroup("SIGKILL");
          killSent = true;
          if (closed) finish(error);
          else reapDeadline = setTimeout(() => finish(new Error(`${program}: close not confirmed after SIGKILL`)), 5000);
        } catch (failure) { finish(failure as Error); }
      }, options.graceMs ?? 1500);
    }
    const collect = (chunk: Buffer, sink: (chunk: Buffer) => void) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 4 * 1024 * 1024)) {
        stop(new Error(`${program}: output too large`));
        return;
      }
      try { sink(chunk); } catch (error) { stop(error as Error); }
    };
    const onStdout = options.onStdout;
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, onStdout ?? ((c) => stdout.push(c))));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, (c) => stderr.push(c)));
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      closed = true;
      if (stopping) { if (killSent) finish(stopError); return; }
      if (code === 0) {
        try {
          if (killGroup(0)) stop(new Error(`${program}: parent exited with descendants still alive`));
          else finish();
        } catch (error) { finish(error as Error); }
      } else stop(new Error(`${program}: code ${code}, signal ${signal ?? "none"}\n${Buffer.concat(stderr).toString("utf8").slice(-2000)}`));
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
