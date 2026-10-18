import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, realpathSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PermissionAudit } from "../../lib/permission-audit.ts";
import { runProcess } from "../../lib/process.ts";

/**
 * One exact command on the host, outside every sandbox, for what the jail cannot run: a real browser,
 * a service that must outlive the session. The human reads the command and confirms each call in a
 * dialog (never an automatic policy, never remembered); the output goes to a private log.
 */
export const MAX_FOREGROUND_SECONDS = 3600;

/** Resolves once the process exists; a launch failure (vanished cwd, no shell) is a tool error, never an unhandled event. */
export function detachProcess(command: string, cwd: string, log: string): Promise<number> {
  const fd = openSync(log, "a", 0o600);
  return new Promise<number>((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, detached: true, stdio: ["ignore", fd, fd], env: process.env });
    child.once("error", error => { closeSync(fd); reject(error); });
    child.once("spawn", () => { closeSync(fd); child.unref(); resolve(child.pid!); });
  });
}

export function registerHostCommand(pi: ExtensionAPI, agentDir: string, verify: (ctx: ExtensionContext) => void, execute = runProcess, detach: (command: string, cwd: string, log: string) => Promise<number> = detachProcess) {
  const logDir = join(agentDir, "host-commands");
  pi.registerTool({
    name: "request_host_command", label: "Run one command on the host", executionMode: "sequential", exposure: "model-only",
    description: "Run one exact shell command on the host, outside the Codex sandbox, after the human confirms it in a dialog: full host access (files, network, logins), so only for what no confined capability can do, such as a real browser or a service that must outlive the session (background=true detaches it and returns its pid). Never automatic, never remembered; stdout and stderr go to a private log under the agent directory.",
    promptGuidelines: [
      "request_host_command only after a sandbox denial that no confined capability covers, with the exact command, cwd and why. Never to bypass a network deny, an anti-bot protection or a policy, never for commands the sandbox can run, and never to install or alter the Pi runtime (that is harness_update). The human sees the command verbatim and decides each time.",
    ],
    parameters: Type.Object({
      command: Type.String({ minLength: 1, maxLength: 2000, description: "Exact POSIX shell command, run with /bin/sh -c" }),
      cwd: Type.String({ minLength: 1, maxLength: 1024, description: "Absolute working directory" }),
      reason: Type.String({ minLength: 1, maxLength: 500 }),
      background: Type.Optional(Type.Boolean({ description: "Detach the process so it outlives this session; returns its pid and log" })),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_FOREGROUND_SECONDS })),
    }, { additionalProperties: false }),
    async execute(id, input, signal, _update, ctx) {
      verify(ctx);
      if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD) throw new Error("request_host_command needs the interactive parent: a human confirms every host command");
      if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(input.command)) throw new Error("Control characters are not allowed in a host command");
      const cwd = realpathSync(input.cwd);
      if (!statSync(cwd).isDirectory()) throw new Error(`${input.cwd} is not a directory`);
      const background = input.background === true;
      const timeoutMs = (input.timeoutSeconds ?? 600) * 1000;
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      const log = join(logDir, `${new Date().toISOString().replaceAll(":", "-")}-${id.replaceAll(/[^A-Za-z0-9_-]/g, "_")}.log`);
      const audit = new PermissionAudit(agentDir, ctx, { resource: "host-command", operation: background ? "background" : "run", toolCallId: id, payload: { command: input.command, cwd, reason: input.reason } });
      try {
        const confirmed = await ctx.ui.confirm(background ? "Lancer ce service sur l'hôte, hors sandbox ?" : "Exécuter cette commande sur l'hôte, hors sandbox ?",
          `Commande : ${input.command}\nDossier : ${cwd}\nRaison : ${input.reason}\n${background ? "Le processus est détaché : il survit à cette session jusqu'à ce que tu l'arrêtes." : `Durée maximale : ${timeoutMs / 1000} s.`}\nAccès complet à la machine : fichiers, réseau, sessions ouvertes. Journal : ${log}`, { signal });
        if (!confirmed) { audit.finish("denied", "human"); throw new Error("Host command refused by the user; nothing executed"); }
        // A cancellation that lands as the dialog resolves must not create a process, least of all one that outlives the session.
        signal?.throwIfAborted();
        verify(ctx);
        audit.finish("granted", "human", "once");
      } catch (error) { audit.finish("cancelled"); throw error; }
      if (background) {
        signal?.throwIfAborted();
        const pid = await detach(input.command, cwd, log);
        return { content: [{ type: "text" as const, text: `Started on the host (pid ${pid}), detached from this session. Log: ${log}. Stop it yourself when done; the harness does not track it.` }], details: undefined };
      }
      let output = "";
      const fd = openSync(log, "a", 0o600);
      // The log keeps everything; the tool result keeps a bounded tail. Exit status stays the command's own.
      const tee = (chunk: Buffer) => { writeSync(fd, chunk); output += chunk.toString("utf8"); if (output.length > 1 << 20) output = output.slice(-(1 << 20)); };
      try {
        await execute("/bin/sh", ["-c", input.command], { cwd, signal, timeoutMs, maxBytes: 8 << 20, onStdout: tee, onStderr: tee });
        return { content: [{ type: "text" as const, text: `Exit 0. Log: ${log}\n${output.trim().split("\n").slice(-40).join("\n")}` }], details: undefined };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Failed: ${(error as Error).message.split("\n")[0]}. Log: ${log}\n${output.trim().split("\n").slice(-40).join("\n")}` }], details: undefined, isError: true };
      } finally { closeSync(fd); }
    },
  });
}
