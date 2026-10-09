import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isolatedArgs, snapshotCommand } from "../lib/isolated-command.ts";
import { CONFINED_TOOLS } from "../lib/confined-tools.ts";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-private-job-"))), cwd = join(root, "project"), agent = join(root, "agent");
  mkdirSync(cwd); mkdirSync(agent); mkdirSync(join(cwd, "config"));
  writeFileSync(join(cwd, "config/main.tf"), "original");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, cwd, agent, snapshot: (inputs = ["config"], binaries) => snapshotCommand(cwd, agent, inputs, binaries) };
}

test("private jobs copy regular inputs, exclude credential/state metadata, and never write back", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  for (const name of [".env", ".env.production", "terraform.tfstate", "private.pem"]) writeFileSync(join(f.cwd, "config", name), "secret");
  mkdirSync(join(f.cwd, "config/.git")); writeFileSync(join(f.cwd, "config/.git/config"), "metadata");
  const one = f.snapshot(["config", "config/main.tf"]), two = f.snapshot();
  try {
    assert.notEqual(one.directory, two.directory); assert.equal(one.sha256, two.sha256);
    assert.deepEqual(readdirSync(join(one.workspace, "config")), ["main.tf"]);
    writeFileSync(join(one.workspace, "config/main.tf"), "discarded edit");
    assert.equal(readFileSync(join(f.cwd, "config/main.tf"), "utf8"), "original");
    writeFileSync(join(f.cwd, "config/main.tf"), "next revision");
    const three = f.snapshot(); try { assert.notEqual(three.sha256, two.sha256); } finally { three.dispose(); }
    assert.equal(readFileSync(join(two.workspace, "config/main.tf"), "utf8"), "original");
  } finally { one.dispose(); two.dispose(); }
  assert.equal(existsSync(one.directory), false);
  assert.equal(CONFINED_TOOLS.has("run_isolated"), false, "private host snapshot preparation is parent-only");
});

test("input traversal, symlinks, hardlinks, metadata and unsafe storage fail closed with cleanup", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  for (const input of [".", "..", "../outside", "/etc/passwd", "config/../other", ".env", ".git/config", "config//main.tf", "config\n"]) assert.throws(() => f.snapshot([input]));
  symlinkSync(f.root, join(f.cwd, "alias"));
  assert.throws(() => f.snapshot(["alias/agent"]));
  symlinkSync("main.tf", join(f.cwd, "config/link")); assert.throws(() => f.snapshot()); rmSync(join(f.cwd, "config/link"));
  linkSync(join(f.cwd, "config/main.tf"), join(f.cwd, "config/hardlink")); assert.throws(() => f.snapshot(), /regular files/); rmSync(join(f.cwd, "config/hardlink"));
  assert.deepEqual(readdirSync(join(f.agent, "isolated-jobs")), []);
  chmodSync(join(f.agent, "isolated-jobs"), 0o755); assert.throws(() => f.snapshot(), /Unsafe/);
  assert.throws(() => snapshotCommand(f.root, f.agent, ["project/config"]), /outside/);
});

test("standalone binaries are snapshotted, scripts and host directory imports are refused", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t), binary = join(f.root, "tofu");
  writeFileSync(binary, Buffer.from([127, 69, 76, 70, 1, 2, 3]), { mode: 0o700 });
  const snapshot = f.snapshot(["config"], [binary]);
  try {
    assert.deepEqual(readFileSync(join(snapshot.bin, "tofu")), readFileSync(binary));
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    assert.throws(() => f.snapshot(["config"], [binary]), /ELF/);
    assert.throws(() => f.snapshot(["config"], [f.root]), /regular files/);
    assert.throws(() => f.snapshot(["config"], [join(f.cwd, "config/main.tf")]), /installed/);
  } finally { snapshot.dispose(); }
});

test("the private profile has no host root, home, network, services, environment or writable runtime", () => {
  const snapshot = { workspace: "/private/job/work", bin: "/private/job/bin" };
  const runtime = { roots: ["/usr/bin", "/usr/lib64"], aliases: [["/bin", "usr/bin"], ["/lib64", "usr/lib64"]] };
  const command = "printf '%s' 'literal $(do-not-expand)'";
  const args = isolatedArgs(snapshot, command, runtime);
  for (const flag of ["--unshare-all", "--unshare-user", "--disable-userns", "--clearenv", "--die-with-parent"]) assert.ok(args.includes(flag));
  assert.equal(args.includes("--share-net"), false); assert.equal(args.includes("--dev-bind"), false);
  assert.equal(args.at(-1), command);
  assert.ok(args.includes("PLUGIN_UNIX_SOCKET_DIR"));
  const grants = args.flatMap((arg, i) => ["--bind", "--ro-bind"].includes(arg) ? [[arg, args[i + 1], args[i + 2]]] : []);
  assert.deepEqual(grants, [["--ro-bind", "/usr/bin", "/usr/bin"], ["--ro-bind", "/usr/lib64", "/usr/lib64"], ["--ro-bind", snapshot.workspace, "/input"], ["--ro-bind", snapshot.bin, "/job-bin"]]);
  assert.equal(args.includes("--bind"), false, "no host path is writable, including the snapshot");
  assert.ok(Buffer.byteLength("/tmp/plugin1234567890") < 108);
});
