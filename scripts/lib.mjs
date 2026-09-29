// Helpers shared by the install/doctor scripts. Node stdlib only.
import { lstat, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative } from "node:path";

export async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function isSymlink(path) {
  try {
    const st = await lstat(path);
    return st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Is `child` strictly under `parent`? (paths already resolved) */
export function isSubPath(parent, child) {
  if (parent === child) return false;
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Looks for an executable on PATH without ever running it. */
export function commandExists(cmd, env = process.env) {
  const pathVar = env.PATH ?? env.Path ?? "";
  const isWin = process.platform === "win32";
  const exts = isWin ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      try {
        const st = statSync(candidate);
        if (st.isFile() && (isWin || (st.mode & 0o111) !== 0)) return true;
      } catch {
        // not found at this location, keep looking
      }
    }
  }
  return false;
}
