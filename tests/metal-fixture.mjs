// Synthetic transport fixture only. This is not native GPU qualification evidence.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { METAL_CHECKS } from "../scripts/metal-backend.mjs";

export function metalFixture(agent, contents = "#!/bin/sh\nexit 1\n", mutate = () => {}) {
  const directory = join(agent, "backends/metal");
  mkdirSync(directory, { recursive: true });
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const report = { schema: 1, qualified: true, backendSha256: sha256, platform: process.platform, arch: process.arch, osRelease: release(), checks: METAL_CHECKS.map(name => ({ name, pass: true })) };
  mutate(report);
  writeFileSync(join(directory, "codex"), contents, { mode: 0o700 });
  writeFileSync(join(directory, "qualification.json"), JSON.stringify(report), { mode: 0o600 });
  writeFileSync(join(agent, "metal-backend.json"), JSON.stringify({ schema: 1, sha256 }), { mode: 0o600 });
  return sha256;
}
