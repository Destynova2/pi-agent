import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { command, projectRoot } from "../graphify/core.ts";

/**
 * Suggests an isolated jj/Git copy when the current repository is a personal "source
 * repository" configured by the user. Disabled by default (no hardcoded personal path):
 * only acts if PI_ORCHESTRATE_SOURCE_DIR and PI_ORCHESTRATE_WORKSPACE_DIR are defined, both
 * relative to `home`. Personal suggestion, never an implicit conversion, checkout or copy.
 */
export async function recommendedWorkspace(
  cwd: string,
  home = homedir(),
  env = process.env,
): Promise<string | undefined> {
  const sourceRelative = env.PI_ORCHESTRATE_SOURCE_DIR;
  const workspaceRelative = env.PI_ORCHESTRATE_WORKSPACE_DIR;
  if (!sourceRelative || !workspaceRelative) return undefined;
  try {
    const source = await realpath(join(home, sourceRelative));
    const current = await projectRoot(cwd);
    if (current !== source) return undefined;
    const target = await realpath(join(home, workspaceRelative));
    if (!(await stat(join(target, ".jj"))).isDirectory() || !(await stat(join(target, ".git"))).isDirectory()) return undefined;
    if (await realpath(await command("jj", ["--ignore-working-copy", "root"], target)) !== target) return undefined;
    if (await projectRoot(target) !== target) return undefined;
    return target;
  } catch {
    // A missing suggestion must never prevent Pi from starting.
    return undefined;
  }
}

export function workspaceHint(target: string): string {
  const quoted = `'${target.replace(/'/g, "'\\''")}'`;
  return `Isolated jj/Git copy proposed: ${target}\nTo work on it: cd ${quoted} && pi\nWarning: uncommitted changes from the configured source (PI_ORCHESTRATE_SOURCE_DIR) are not transferred and the copy may be behind. No automatic switch.`;
}
