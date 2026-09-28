import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { command, projectRoot } from "../graphify/core.ts";

/**
 * Suggère une copie jj/Git isolée quand le dépôt courant est un "dépôt source" personnel
 * configuré par l'utilisateur. Désactivé par défaut (aucun chemin personnel codé en dur) :
 * n'agit que si PI_ORCHESTRATE_SOURCE_DIR et PI_ORCHESTRATE_WORKSPACE_DIR sont définis, tous deux
 * relatifs à `home`. Proposition personnelle, jamais de conversion, de checkout ou de copie implicite.
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
    // Une suggestion absente ne doit jamais empêcher Pi de démarrer.
    return undefined;
  }
}

export function workspaceHint(target: string): string {
  const quoted = `'${target.replace(/'/g, "'\\''")}'`;
  return `Copie jj/Git isolée proposée : ${target}\nPour travailler dessus : cd ${quoted} && pi\nAttention : les changements non commités de la source configurée (PI_ORCHESTRATE_SOURCE_DIR) ne sont pas transférés et la copie peut être en retard. Aucune bascule automatique.`;
}
