import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

// /reload calls this same loader.reload(); the loader imports TypeScript extensions without a module
// cache, so an installed harness is live after /reload. A .mjs module imported by the extension is cached
// by Node for the life of the process: harness_update asks for a restart when one changed.
test("reloading the resource loader picks up changed extension code but not cached .mjs dependencies", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-reload-"));
  const agent = join(root, "agent"), cwd = join(root, "project"), extension = join(root, "ext.ts");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  const dependency = join(root, "dep.mjs");
  const write = version => {
    writeFileSync(dependency, `export const version = "${version}";\n`);
    writeFileSync(extension, `import { version } from "./dep.mjs";\nexport default function (pi) { pi.registerTool({ name: "probe", label: "probe", description: "${version}", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: version }], details: undefined }; } }); }\n`);
  };
  try {
    mkdirSync(agent); mkdirSync(cwd);
    write("v1");
    const loader = new DefaultResourceLoader({
      cwd, agentDir: agent, settingsManager: SettingsManager.inMemory({}),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [extension],
    });
    await loader.reload();
    const description = () => loader.getExtensions().extensions[0].tools.get("probe").definition.description;
    assert.equal(description(), "v1");
    write("v2");
    await loader.reload();
    assert.equal(description(), "v2", "extension code reloads");
    const probe = await loader.getExtensions().extensions[0].tools.get("probe").definition.execute("1", {});
    assert.equal(probe.content[0].text, "v1", "known limit: an imported .mjs stays cached, so harness_update asks for a restart when one changed");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
