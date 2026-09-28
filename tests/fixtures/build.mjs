// Aides de fixtures pour les tests d'install/doctor : dépôt source jetable et faux `pi` CLI.
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export async function makeTmpDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Construit un dépôt source minimal avec les répertoires/fichiers gérés par l'installeur. */
export async function buildFixtureSource(overrides = {}) {
  const root = await makeTmpDir("pi-agent-source-");
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
 * Écrit un faux exécutable `pi` (Node) dans un répertoire dédié et renvoie un PATH
 * qui le fait passer en premier. Journalise chaque `install <source>` dans FAKE_PI_LOG.
 * `failSource`, s'il est fourni, fait échouer cette source précise avec le code 1.
 */
export async function makeFakePi({ failSource } = {}) {
  const binDir = await makeTmpDir("pi-agent-fakebin-");
  const script = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "install") {
  const source = args[1];
  const logPath = process.env.FAKE_PI_LOG;
  if (logPath) appendFileSync(logPath, \`install \${source} \${process.env.PI_CODING_AGENT_DIR}\\n\`);
  if (process.env.FAKE_PI_FAIL_SOURCE && source === process.env.FAKE_PI_FAIL_SOURCE) process.exit(1);
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

/** Répertoire de bin factice contenant un exécutable vide pour chacun des noms donnés. */
export async function makeFakeToolchain(names) {
  const binDir = await makeTmpDir("pi-agent-fake-tools-");
  for (const name of names) {
    const p = join(binDir, name);
    await writeFile(p, "#!/bin/sh\nexit 0\n");
    await chmod(p, 0o755);
  }
  return binDir;
}
