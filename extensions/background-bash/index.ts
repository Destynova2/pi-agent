import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBackground } from "./core.ts";

export default async function background(pi: ExtensionAPI) {
  // Resolve the installed package's public export. Pi's loader handles TypeScript.
  const require = createRequire(join(getAgentDir(), "npm/package.json"));
  const { backgroundBash } = await import(pathToFileURL(require.resolve("@richardgill/pi-background-bash")).href);
  registerBackground(pi, backgroundBash, join(tmpdir(), "pi-background-bash"));
}
