import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { installedPackageRoot, RELEASES_DIRECTORY } from "./runtime-paths.mjs";

function digestTrees(roots, accept) {
  const hash = createHash("sha256");
  const walk = (root, path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) { hash.update(JSON.stringify([path, readlinkSync(path)])); return; }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if ([".git", ".cache", "__pycache__"].includes(name)) continue;
        walk(root, join(path, name));
      }
    } else if (stat.isFile() && accept(path)) {
      hash.update(JSON.stringify([relative(root, path), stat.mode & 0o777]));
      hash.update(readFileSync(path));
    }
  };
  for (const root of roots) if (existsSync(root)) { hash.update(root); walk(root, root); }
  return hash.digest("hex");
}

/** Only executable dependency trees are read, never auth, sessions or user policy. */
export function activationState(agentDir) {
  const root = installedPackageRoot(agentDir);
  return {
    root,
    versioned: /^[a-f0-9]{64}$/.test(relative(join(agentDir, RELEASES_DIRECTORY), root)),
    modules: digestTrees([join(root, "lib"), join(root, "scripts"), join(agentDir, "scripts")], path => path.endsWith(".mjs")),
    dependencies: digestTrees([join(agentDir, "npm"), join(agentDir, "git")], path => /\.(?:js|mjs|cjs|ts|json|node|wasm)$/.test(path)),
  };
}

export function requiresRestart(before, after) {
  return before.dependencies !== after.dependencies || (!after.versioned && before.modules !== after.modules);
}
