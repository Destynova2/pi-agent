import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { RpcProcess } from "../lib/rpc-process.ts";
import { buildConfinedLspWorkerCommand, buildConfinedLspWorkerEnv, resolveConfinedLspAgentPaths } from "../extensions/confined-lsp/jail.ts";

test("pinned TypeScript serves TS and MJS without tsconfig through the real confined LSP adapter", { timeout: 60000 }, async () => {
  const installed = getAgentDir();
  const root = mkdtempSync(join(tmpdir(), "pi-typescript-lsp-"));
  const cwd = join(root, "project"), agent = join(root, "agent");
  let rpc;
  try {
    const manifest = JSON.parse(readFileSync(join(installed, "npm/node_modules/typescript/package.json"), "utf8"));
    assert.equal(manifest.version, "7.0.2", "install the pinned TypeScript server before the full gate");
    mkdirSync(cwd); mkdirSync(agent);
    symlinkSync(join(installed, "npm"), join(agent, "npm"));
    const settings = JSON.parse(readFileSync(new URL("../settings.json", import.meta.url), "utf8"));
    settings.lsp.servers.typescript.command = process.execPath;
    settings.lsp.servers.typescript.args = [join(installed, "npm/node_modules/typescript/bin/tsc"), "--lsp", "--stdio"];
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ lsp: settings.lsp }));
    writeFileSync(join(cwd, "package.json"), '{"type":"module"}\n');
    writeFileSync(join(cwd, "a.ts"), 'export const value: number = "wrong";\n');
    writeFileSync(join(cwd, "b.mjs"), 'export const answer = 42;\n');
    const paths = resolveConfinedLspAgentPaths(agent);
    rpc = new RpcProcess({ command: paths.shellLauncherPath, args: ["--offline", "-c", buildConfinedLspWorkerCommand(paths)],
      cwd, env: buildConfinedLspWorkerEnv(paths), requestTimeoutMs: 20000, onRequest: async () => null });
    rpc.start();
    await rpc.request("session_start", { cwd, projectTrusted: false, hasUI: false, branch: [] });
    const call = input => rpc.request("tool", { toolCallId: "probe", input });
    for (const file_path of ["a.ts", "b.mjs"]) {
      const result = await call({ operation: "hover", file_path, line: 1, character: 15 });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.match(JSON.stringify(result.content), /number|42/);
    }
    const diagnostics = await call({ operation: "diagnostics", file_path: "a.ts" });
    assert.notEqual(diagnostics.isError, true, JSON.stringify(diagnostics));
    assert.match(JSON.stringify(diagnostics.content), /not assignable/);
  } finally { await rpc?.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
