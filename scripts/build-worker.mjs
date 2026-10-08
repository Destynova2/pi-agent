#!/usr/bin/env node
// Fixed build entry point, invoked only inside the dedicated Linux mount namespace.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { buildSourceIdentity } from "../lib/build-sandbox.ts";

const [program, sourceSha256, ...extra] = process.argv.slice(2);
if (process.platform !== "linux" || process.env.PI_BUILD_CONFINED !== "1" || extra.length || !program?.startsWith("/") || !/^[a-f0-9]{64}$/.test(sourceSha256 ?? "")) throw new Error("Invalid confined build invocation");
if (!/^NoNewPrivs:\s+1$/m.test(readFileSync("/proc/self/status", "utf8"))) throw new Error("Build sandbox requires no_new_privs");
if (buildSourceIdentity(process.cwd()) !== sourceSha256) throw new Error("Build sources changed after approval");
const probe = spawnSync("/usr/bin/python3", ["-I", "-S", "-c", `import os, fcntl
fd = os.open('/dev/kvm', os.O_RDWR | os.O_CLOEXEC)
try:
    if fcntl.ioctl(fd, 0xAE00, 0) != 12:
        raise RuntimeError('unsupported KVM API')
    vm = fcntl.ioctl(fd, 0xAE01, 0)
    os.close(vm)
finally:
    os.close(fd)
`], { encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
if (probe.error || probe.status !== 0) {
  console.error(`KVM_UNAVAILABLE inside build sandbox: ${probe.error?.message ?? probe.stderr}`);
  process.exit(1);
}
// The argv is fixed; neither model input nor project configuration replaces this command.
process.execve(program, [program, "-i", "localhost,", "ansible/build.yml"], process.env);
