import { cpSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isSubPath } from "./lib.mjs";

/** Keep the checkout editable while all deployment phases use one private copy. */
export function deploymentSnapshot(source, destination) {
  source = resolve(source);
  destination = resolve(destination);
  if (source === destination || isSubPath(source, destination) || isSubPath(destination, source)) {
    throw new Error("Deployment snapshot must be outside the source checkout");
  }
  if (!lstatSync(join(source, ".git")).isDirectory()) {
    throw new Error("Deployment snapshot requires a standalone Git checkout");
  }
  if (existsSync(destination)) throw new Error("Deployment snapshot destination already exists");
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: source })
    .toString().split("\0").filter(Boolean);
  mkdirSync(destination, { mode: 0o700 });
  // A full private metadata copy preserves diff checks without shared Git writes.
  cpSync(join(source, ".git"), join(destination, ".git"), { recursive: true });
  for (const file of new Set(files)) {
    const path = join(source, file);
    if (!existsSync(path)) continue; // Preserve tracked deletions in the snapshot.
    mkdirSync(dirname(join(destination, file)), { recursive: true });
    cpSync(path, join(destination, file), { recursive: true, verbatimSymlinks: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/deployment-snapshot.mjs <destination>");
  deploymentSnapshot(process.cwd(), process.argv[2]);
}
