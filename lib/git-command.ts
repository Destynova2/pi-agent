import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) if (/^GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*|TRACE.*|NAMESPACE|CEILING_DIRECTORIES|EXEC_PATH|LITERAL_PATHSPECS|GLOB_PATHSPECS|NOGLOB_PATHSPECS|ICASE_PATHSPECS)$/.test(key) && !["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"].includes(key)) env[key] = undefined;
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "/usr/bin/false", GIT_SEQUENCE_EDITOR: "/usr/bin/false", LC_ALL: "C" };
}

/** Keep configured hooks, but reject changes to the reviewed commit tree or ref. */
export function commitHookOptions(tree: string, head: string, branch: string, originalHooks: string) {
  const hooks = fileURLToPath(new URL("../scripts/git-hooks/", import.meta.url));
  for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-index-change", "reference-transaction"]) {
    const path = join(hooks, name), stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096 || realpathSync(path) !== path) throw new Error("Missing Git hook gate");
    accessSync(path, constants.X_OK);
  }
  return { args: ["-c", `core.hooksPath=${hooks}`], env: {
    PI_GIT_ACCESS_NODE: process.execPath,
    PI_GIT_ACCESS_GUARD: fileURLToPath(new URL("../scripts/git-hook-guard.mjs", import.meta.url)),
    PI_GIT_ACCESS_ORIGINAL_HOOKS: originalHooks,
    PI_GIT_ACCESS_EXPECTED_TREE: tree,
    PI_GIT_ACCESS_EXPECTED_HEAD: head,
    PI_GIT_ACCESS_EXPECTED_REF: `refs/heads/${branch}`,
  } };
}
