import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, realpathSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const inside = (root: string, path: string) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"); };
const forbidden = (name: string) => [".git", ".jj", ".pi", ".codex", ".agents", ".ssh", ".aws", ".kube"].includes(name) || /^\.env(?:\.|$)/.test(name) || /(?:\.tfstate(?:\.|$)|\.pem$|\.key$)/.test(name);

/** Private host storage is never mounted into ordinary commands as writable. */
function storage(agentDir: string, cwd: string) {
  const agent = realpathSync(agentDir);
  if (inside(cwd, agent)) throw new Error("Isolated job storage must live outside the workspace");
  const path = join(agent, "isolated-jobs");
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || realpathSync(path) !== path) throw new Error("Unsafe isolated job storage");
  return path;
}

/** A snapshot contains regular files only. Open directory descriptors prevent parent-link races. */
export function snapshotCommand(cwd: string, agentDir: string, inputs: string[], binaries: string[] = []) {
  if (process.platform !== "linux") throw new Error("Private IPC jobs currently require Linux bubblewrap");
  cwd = realpathSync(cwd);
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 16 || !Array.isArray(binaries) || binaries.length > 4) throw new Error("Expected 1–16 project inputs and at most four standalone binaries");
  const paths = [...new Set(inputs)].sort();
  for (const name of paths) {
    if (typeof name !== "string" || name.length > 1024 || isAbsolute(name) || name === "." || /[\u0000-\u001f\u007f]/u.test(name) || name.split("/").some(part => !part || part === "." || part === ".." || forbidden(part))) throw new Error("Inputs must be explicit relative paths without metadata, credentials or state");
  }
  const directory = mkdtempSync(join(storage(agentDir, cwd), "job-"));
  const workspace = join(directory, "work"), bin = join(directory, "bin");
  mkdirSync(workspace, { mode: 0o700 }); mkdirSync(bin, { mode: 0o700 });
  const hash = createHash("sha256");
  let bytes = 0, entries = 0;
  let sourceFd: number | undefined;
  const copy = (source: string, destination: string, name: string, executable = false, depth = 0) => {
    if (++entries > 20_000 || depth > 64) throw new Error("Isolated inputs exceed the entry/depth limit");
    const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (stat.isDirectory() && !executable) {
        mkdirSync(destination, { recursive: true, mode: 0o700 });
        hash.update(JSON.stringify([name, "directory"]));
        for (const entry of readdirSync(`/proc/self/fd/${fd}`).sort()) {
          if (forbidden(entry)) continue;
          copy(`/proc/self/fd/${fd}/${entry}`, join(destination, entry), `${name}/${entry}`, false, depth + 1);
        }
      } else {
        if (!stat.isFile() || stat.nlink !== 1 || (bytes += stat.size) > 512 * 1024 ** 2) throw new Error("Inputs must be regular files without hardlinks, totaling at most 512 MiB");
        if (executable && (!(stat.mode & 0o111) || stat.size < 4)) throw new Error("Standalone binary is not executable");
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        const out = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, stat.mode & 0o111 ? 0o700 : 0o600);
        try {
          hash.update(JSON.stringify([name, stat.size, !!(stat.mode & 0o111)]));
          const buffer = Buffer.alloc(1024 * 1024);
          let offset = 0;
          while (offset < stat.size) {
            const count = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
            if (!count) throw new Error("Input changed during snapshot");
            if (executable && offset === 0 && !buffer.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) throw new Error("Only standalone ELF binaries may be imported; put project scripts in inputs");
            hash.update(buffer.subarray(0, count));
            let written = 0;
            while (written < count) written += writeSync(out, buffer, written, count - written);
            offset += count;
          }
          const after = fstatSync(fd);
          if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("Input changed during snapshot");
        } finally { closeSync(out); }
      }
    } finally { closeSync(fd); }
  };
  try {
    sourceFd = openSync(cwd, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const selected: string[] = [];
    for (const name of paths) {
      if (selected.some(parent => name.startsWith(`${parent}/`))) continue;
      // Pin every intermediate directory; O_NOFOLLOW on the final file alone is insufficient.
      const parents: number[] = [];
      try {
        let parent = sourceFd;
        const parts = name.split("/");
        for (const part of parts.slice(0, -1)) {
          parent = openSync(`/proc/self/fd/${parent}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          parents.push(parent);
        }
        copy(`/proc/self/fd/${parent}/${parts.at(-1)}`, join(workspace, name), name);
        selected.push(name);
      } finally { parents.reverse().forEach(closeSync); }
    }
    const imported: { path: string; name: string }[] = [];
    for (const path of binaries) {
      if (typeof path !== "string" || !isAbsolute(path) || path !== resolve(path) || /[\u0000-\u001f\u007f]/u.test(path)) throw new Error("Binary paths must be absolute");
      const canonical = realpathSync(path), name = basename(path);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name) || inside(cwd, canonical) || inside(realpathSync(agentDir), canonical)) throw new Error("Import only installed standalone binaries outside the project and Pi storage");
      copy(canonical, join(bin, name), `bin/${name}`, true);
      imported.push({ path: canonical, name });
    }
    return { directory, workspace, bin, inputs: selected, binaries: imported, sha256: hash.digest("hex"), bytes, entries,
      dispose: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
  finally { if (sourceFd !== undefined) closeSync(sourceFd); }
}

/** Uninspectable administrator directories are hidden, never trusted implicitly. */
export function inspectRuntimeTrees(roots: string[], inspect = { stat: lstatSync, list: (path: string) => readdirSync(path) }) {
  let entries = 0;
  const masked: string[] = [];
  const check = (path: string) => {
    if (++entries > 300_000) throw new Error("OS runtime exceeds inspection limit");
    const stat = inspect.stat(path);
    if (stat.uid !== 0 || (!stat.isSymbolicLink() && stat.mode & 0o022) || !(stat.isFile() || stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`OS runtime is not an immutable administrator-owned tree: ${path}`);
    if (stat.isDirectory()) {
      let children: string[];
      try { children = inspect.list(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EACCES" || roots.includes(path)) throw error;
        masked.push(path);
        return;
      }
      for (const entry of children) check(join(path, entry));
    }
  };
  for (const root of roots) check(root);
  return masked;
}

/** Only administrator-owned OS runtime trees are shared; home, /run and host /tmp are absent. */
export function isolatedRuntime() {
  const roots = ["/usr/bin", "/usr/lib", "/usr/lib64"].filter(path => { try { return lstatSync(path).isDirectory(); } catch { return false; } });
  const masked = inspectRuntimeTrees(roots);
  const backend = "/usr/bin/bwrap";
  const stat = lstatSync(backend);
  if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022 || !(stat.mode & 0o111)) throw new Error("A protected /usr/bin/bwrap is required");
  const aliases = ["/bin", "/sbin", "/lib", "/lib64"].flatMap(path => {
    try {
      const target = realpathSync(path);
      if (!roots.some(root => inside(root, target))) return [];
      // Use the final mounted target, not an intermediate alias absent from the jail.
      return [[path, target]];
    } catch { return []; }
  });
  return { backend, roots, aliases, masked };
}

export function isolatedArgs(snapshot: ReturnType<typeof snapshotCommand>, command: string, runtime = isolatedRuntime()) {
  if (typeof command !== "string" || !command.trim() || command.length > 8000 || command.includes("\0")) throw new Error("Expected a bounded command");
  return ["--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--seccomp", "0",
    ...runtime.roots.flatMap(path => ["--ro-bind", path, path]),
    ...(runtime.masked ?? []).flatMap(path => ["--size", "4096", "--tmpfs", path, "--remount-ro", path]),
    ...runtime.aliases.flatMap(([path, target]) => ["--symlink", target, path]),
    "--proc", "/proc", "--dev", "/dev", "--size", "268435456", "--tmpfs", "/tmp", "--size", "16777216", "--tmpfs", "/home", "--dir", "/home/job", "--dir", "/run",
    "--ro-bind", snapshot.workspace, "/input", "--ro-bind", snapshot.bin, "/job-bin", "--size", "1073741824", "--tmpfs", "/work", "--remount-ro", "/", "--chdir", "/work", "--clearenv",
    ...Object.entries({ HOME: "/home/job", PATH: "/job-bin:/usr/bin:/bin", TMPDIR: "/tmp", PLUGIN_UNIX_SOCKET_DIR: "/tmp", LANG: "C.UTF-8", CHECKPOINT_DISABLE: "1", PI_CONFINED: "1" }).flatMap(([key, value]) => ["--setenv", key, value]),
    // Both shells run inside the jail. The reviewed program stays one literal argv value.
    "--", "/bin/bash", "--noprofile", "--norc", "-c", 'exec </dev/null; /usr/bin/cp -R -- /input/. /work/ && exec /bin/bash --noprofile --norc -c "$1"', "pi-private-job", command];
}
