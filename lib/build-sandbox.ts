import { runtimeRoot } from "./runtime-paths.mjs";
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { serverIdentity } from "./mcp-approvals.ts";

export function inside(parent: string, path: string) {
  const rel = relative(parent, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

/** Metadata/access check only. The confined worker must also create a KVM VM. */
export function kvmStatus() {
  const device = "/dev/kvm";
  if (process.platform !== "linux") return { device, available: false, reason: "KVM builds require Linux" };
  try {
    const stat = lstatSync(device);
    if (!stat.isCharacterDevice() || stat.rdev !== 10 * 256 + 232 || realpathSync(device) !== device) throw new Error("unexpected device identity");
    accessSync(device, constants.R_OK | constants.W_OK);
    return { device, available: true };
  } catch (error) {
    return { device, available: false, reason: (error as NodeJS.ErrnoException).code ?? (error as Error).message };
  }
}

export function buildDirectory(path: string, allowMissing = false) {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error("Build directory must be canonical and contain no links");
  } catch (error) { if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Bind approval to project sources, never print configuration or secret values. */
export function buildSourceIdentity(cwd: string) {
  const hash = createHash("sha256");
  let entriesSeen = 0, bytes = 0;
  const visit = (path: string) => {
    if (++entriesSeen > 10000 || relative(cwd, path).split("/").length > 64) throw new Error("Too many build source entries or excessive nesting");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error("Build sources must contain no links");
    const name = relative(cwd, path);
    hash.update(JSON.stringify([name, stat.isDirectory() ? "directory" : stat.size]));
    if (stat.isDirectory()) {
      const entries = readdirSync(path).sort();
      if (entries.length > 10000) throw new Error("Too many build source entries");
      for (const entry of entries) visit(join(path, entry));
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1 || (bytes += stat.size) > 16 * 1024 * 1024) throw new Error("Build sources must be bounded regular files without links");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const current = fstatSync(fd);
      if (!current.isFile() || current.nlink !== 1 || current.size !== stat.size || current.ino !== stat.ino || current.dev !== stat.dev) throw new Error("Build source changed while reading");
      // Bound the read even if another process is appending to the file.
      const content = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < content.length) {
        const count = readSync(fd, content, offset, content.length - offset, null);
        if (!count) break;
        offset += count;
      }
      if (offset !== stat.size || fstatSync(fd).mtimeMs !== current.mtimeMs) throw new Error("Build source changed while reading");
      hash.update(content.subarray(0, offset));
    } finally { closeSync(fd); }
  };
  for (const path of ["ansible", "packer", "config", "ansible.cfg"]) visit(join(cwd, path));
  const playbook = lstatSync(join(cwd, "ansible/build.yml"));
  if (!playbook.isFile() || playbook.isSymbolicLink() || playbook.nlink !== 1) throw new Error("Expected a regular ansible/build.yml");
  return hash.digest("hex");
}

export function prepareBuild(cwd: string, agentDir: string) {
  if (process.platform !== "linux") throw new Error("KVM builds require Linux");
  cwd = realpathSync(cwd);
  const path = [join(homedir(), ".local/bin"), "/home/linuxbrew/.linuxbrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  const executable = serverIdentity("ansible-playbook", [], cwd, { PATH: path });
  const backend = serverIdentity("/usr/bin/bwrap", [], cwd, { PATH: path });
  const worker = realpathSync(join(runtimeRoot, "scripts/build-worker.mjs"));
  for (const protectedPath of [realpathSync(agentDir), worker, realpathSync(process.execPath), executable.command, backend.command]) {
    if (inside(cwd, protectedPath)) throw new Error("Build runtime must live outside the project");
  }
  for (const name of [".cache", "output"]) buildDirectory(join(cwd, name), true);
  const sourceSha256 = buildSourceIdentity(cwd);
  return { cwd, path, executable, backend, worker, sourceSha256,
    workerSha256: createHash("sha256").update(readFileSync(worker)).digest("hex") };
}

export type BuildPlan = ReturnType<typeof prepareBuild>;

/** Dedicated mount policy: only cache/output/scratch writable, one device, native network. */
export function buildSandboxArgs(plan: BuildPlan, scratch: string) {
  const { cwd, path, worker, executable, sourceSha256 } = plan;
  buildDirectory(scratch);
  return [
    // --unshare-all only implies --unshare-user-try; --disable-userns requires the strict option.
    "--unshare-all", "--unshare-user", "--share-net", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--disable-userns",
    "--ro-bind", "/", "/", "--dev", "/dev", "--dev-bind", "/dev/kvm", "/dev/kvm", "--proc", "/proc", "--tmpfs", "/dev/shm",
    "--bind", join(cwd, ".cache"), join(cwd, ".cache"),
    "--bind", join(cwd, "output"), join(cwd, "output"),
    "--bind", scratch, scratch,
    "--chdir", cwd, "--clearenv",
    ...Object.entries({ HOME: homedir(), PATH: path, TMPDIR: scratch, LANG: "C.UTF-8", NO_COLOR: "1",
      ANSIBLE_CONFIG: join(cwd, "ansible.cfg"), ANSIBLE_LOCAL_TEMP: join(cwd, ".cache/ansible/tmp"),
      ANSIBLE_HOST_KEY_CHECKING: "True", PI_BUILD_CONFINED: "1" }).flatMap(([key, value]) => ["--setenv", key, value]),
    "--", process.execPath, worker, executable.command, sourceSha256,
  ];
}
