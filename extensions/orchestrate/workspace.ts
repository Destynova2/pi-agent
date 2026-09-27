import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { command, projectRoot } from "../graphify/core.ts";

/** Proposition personnelle, jamais de conversion, de checkout ou de copie implicite. */
export async function recommendedWorkspace(cwd: string, home = homedir()): Promise<string | undefined> {
  try {
    const source = await realpath(join(home, "workspace/reti"));
    const current = await projectRoot(cwd);
    if (current !== source) return undefined;
    const target = await realpath(join(home, "workspace/reti-orchestrate-jj"));
    if (!(await stat(join(target, ".jj"))).isDirectory() || !(await stat(join(target, ".git"))).isDirectory()) return undefined;
    if (await realpath(await command("jj", ["--ignore-working-copy", "root"], target)) !== target) return undefined;
    if (await projectRoot(target) !== target) return undefined;
    return target;
  } catch {
    // Une suggestion absente ne doit jamais empêcher Pi de démarrer.
    return undefined;
  }
}

export function workspaceHint(target: string): string {
  const quoted = `'${target.replace(/'/g, "'\\''")}'`;
  return `Copie jj/Git isolée proposée : ${target}\nPour travailler dessus : cd ${quoted} && pi\nAttention : les changements non commités de reti ne sont pas transférés et la copie peut être en retard. Aucune bascule automatique.`;
}
