// Fixture helpers for the install/doctor tests: disposable source repo and fake `pi` CLI.
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export async function makeTmpDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Builds a minimal source repo with the directories/files managed by the installer. */
export async function buildFixtureSource(overrides = {}) {
  const root = await makeTmpDir("pi-agent-source-");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-agent-config", version: "0.1.0", pi: { extensions: ["./extensions/demo/index.ts"] } }));
  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(join(root, "agents", "worker.md"), "# worker\n");
  await mkdir(join(root, "extensions", "demo"), { recursive: true });
  await writeFile(join(root, "extensions", "demo", "index.ts"), "export const demo = 1;\n");
  await mkdir(join(root, "lib"), { recursive: true });
  await writeFile(join(root, "lib", "helper.ts"), "export const helper = 1;\n");
  await mkdir(join(root, "gates"), { recursive: true });
  await writeFile(join(root, "gates", "pi-prek"), "#!/bin/sh\necho fake-pi-prek\n");
  await chmod(join(root, "gates", "pi-prek"), 0o755);
  await writeFile(join(root, "keybindings.json"), `${JSON.stringify({ "app.session.rename": [] }, null, 2)}\n`);
  const settings = {
    defaultProvider: "anthropic",
    packages: ["npm:pkg-a", "npm:pkg-b"],
    ...overrides.settings,
  };
  await writeFile(join(root, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  return root;
}

/**
 * Writes a fake `pi` executable (Node) into a dedicated directory and returns a PATH
 * that puts it first. Logs every `install <source>` to FAKE_PI_LOG.
 * `failSource`, if given, makes that specific source fail with exit code 1.
 */
export async function makeFakePi({ failSource, rewriteSettings = false, requireSafeNpm = false } = {}) {
  const binDir = await makeTmpDir("pi-agent-fakebin-");
  const script = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "install") {
  if (${JSON.stringify(requireSafeNpm)} && (process.env.npm_config_save_exact !== "true" || process.env.npm_config_ignore_scripts !== "true")) process.exit(2);
  const source = args[1];
  const logPath = process.env.FAKE_PI_LOG;
  if (logPath) appendFileSync(logPath, \`install \${source} \${process.env.PI_CODING_AGENT_DIR}\\n\`);
  if (process.env.FAKE_PI_FAIL_SOURCE && source === process.env.FAKE_PI_FAIL_SOURCE) process.exit(1);
  if (${JSON.stringify(rewriteSettings)}) {
    const settingsPath = process.env.PI_CODING_AGENT_DIR + "/settings.json";
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.packages = [source];
    settings.extensions = [];
    writeFileSync(settingsPath, JSON.stringify(settings));
  }
  process.exit(0);
}
if (args[0] === "--version") { console.log("pi 0.0.0-fake"); process.exit(0); }
process.exit(0);
`;
  const piPath = join(binDir, "pi");
  await writeFile(piPath, script);
  await chmod(piPath, 0o755);
  const logPath = join(binDir, "fake-pi.log");
  await writeFile(logPath, "");
  const env = {
    ...process.env,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    FAKE_PI_LOG: logPath,
  };
  if (failSource) env.FAKE_PI_FAIL_SOURCE = failSource;
  return { binDir, logPath, env };
}

/** Fake bin directory containing an empty executable for each given name. */
export async function makeFakeToolchain(names) {
  const binDir = await makeTmpDir("pi-agent-fake-tools-");
  for (const name of names) {
    const p = join(binDir, name);
    await writeFile(p, "#!/bin/sh\nexit 0\n");
    await chmod(p, 0o755);
  }
  return binDir;
}
