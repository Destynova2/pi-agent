import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const EXCLUDED = new Set(["node_modules", "bin", "git", "npm", "sessions", "skills", "downloads", "__pycache__"]);

// Code/config identity, not a cache of tests or external-service availability.
export function validationInputs(root, env = process.env) {
  root = resolve(root);
  const source = createHash("sha256");
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || EXCLUDED.has(entry.name)) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(mjs|js|ts|json|sh|py)$/.test(entry.name)) {
        source.update(JSON.stringify([relative(root, file), readFileSync(file).toString("base64")]));
      }
    }
  };
  walk(root);
  const sdkPath = env.PI_PACKAGE_JSON ? resolve(env.PI_PACKAGE_JSON) : null;
  const digest = file => {
    try { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
    catch (error) { if (error.code === "ENOENT") return "missing"; throw error; }
  };
  const inputs = {
    root, source: source.digest("hex"),
    node: { path: process.execPath, version: process.version, options: env.NODE_OPTIONS ?? "", args: process.execArgv },
    sdk: sdkPath ? { path: sdkPath, manifest: digest(sdkPath), cli: digest(join(dirname(sdkPath), "dist/bundle/cli.js")) } : null,
  };
  return { ...inputs, fingerprint: createHash("sha256").update(JSON.stringify(inputs)).digest("hex") };
}
