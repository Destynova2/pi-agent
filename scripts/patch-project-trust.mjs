// Pinned Pi runtimes: personal trust handlers must also run in resource-free projects.
// Validates all known artifacts before writing; does not touch the paste patch.
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const TRUST_TARGETS = [
  {
    path: "dist/core/project-trust.js",
    sha256: "be5428398a12124730790095e8ba9b0ecf67b1dde464c717970cf58a5af11f56",
    changes: [
      ["    if (!hasTrustRequiringProjectResources(options.cwd)) {\n        return true;\n    }\n    if (options.extensionsResult) {", "    // pi-agent: honor personal trust handlers before the empty-project fast path.\n    if (options.extensionsResult) {"],
      ["    const decision = options.trustStore.get(options.cwd);", "    if (!hasTrustRequiringProjectResources(options.cwd)) {\n        return true;\n    }\n    const decision = options.trustStore.get(options.cwd);"],
    ],
  },
  {
    path: "dist/bundle/chunks/chunk-GUORCHFS.js",
    sha256: "b858ce2c4ddbfa1594142e39d7b6ebce328010e116c08db9663602cd26171425",
    changes: [
      ["if(!hasTrustRequiringProjectResources(options.cwd))return!0;if(options.extensionsResult)", "/* pi-agent: honor personal trust handlers before the empty-project fast path. */if(options.extensionsResult)"],
      ["trusted}}let decision=options.trustStore.get(options.cwd);", "trusted}}if(!hasTrustRequiringProjectResources(options.cwd))return!0;let decision=options.trustStore.get(options.cwd);"],
      ["shouldResolveProjectTrust=parsed.projectTrustOverride===void 0&&cachedProjectTrust===void 0&&hasTrustRequiringResources,", "shouldResolveProjectTrust=parsed.projectTrustOverride===void 0&&cachedProjectTrust===void 0,"],
    ],
  },
  {
    path: "dist/main.js",
    sha256: "bb36969572097bc657b85b42954a78f4be42afc5dfd63453a7d97d53165657b2",
    changes: [
      ["const shouldResolveProjectTrust = parsed.projectTrustOverride === undefined && cachedProjectTrust === undefined && hasTrustRequiringResources;", "const shouldResolveProjectTrust = parsed.projectTrustOverride === undefined && cachedProjectTrust === undefined;"],
    ],
  },
];

// Verified byte-for-byte against registry tarballs; transforms have unchanged anchors.
export const TRUST_TARGETS_BY_VERSION = {
  "0.99.1": TRUST_TARGETS,
  "1.0.4": TRUST_TARGETS.map((target, index) => ({
    ...target,
    ...(index === 1 ? { path: "dist/bundle/chunks/chunk-H33F2TZD.js", sha256: "ffefe09d06cc357cade211d8123c971f0327e04f627c08f37e4e97c79da4dd11" } : {}),
    ...(index === 2 ? { sha256: "866d65f2d42f74d2bb72ed4a755c8ace1b8a2c497a32cb57cc4db594a4fcb2bf" } : {}),
  })),
  "1.0.3": TRUST_TARGETS.map((target, index) => ({
    ...target,
    ...(index === 1 ? { path: "dist/bundle/chunks/chunk-BFNE7BHG.js", sha256: "d8e4b8827fc70a6192967db26adf024d7c4672ca533068c09069717b0b9faad7" } : {}),
    ...(index === 2 ? { sha256: "060521b0b81f91948d8ded9139e423e5d0c9e6808a45c81750cc30519de4d2db" } : {}),
  })),
  "1.0.1": TRUST_TARGETS.map((target, index) => ({
    ...target,
    ...(index === 1 ? { path: "dist/bundle/chunks/chunk-5OEJBNHG.js", sha256: "a760f30e4768230e7ed248fbbe97840a9039123aac093178476341fafa60d741" } : {}),
    ...(index === 2 ? { sha256: "060521b0b81f91948d8ded9139e423e5d0c9e6808a45c81750cc30519de4d2db" } : {}),
  })),
  "1.0.2": TRUST_TARGETS.map((target, index) => ({
    ...target,
    ...(index === 1 ? { path: "dist/bundle/chunks/chunk-ZSBPJAJ2.js", sha256: "bc5a8273cca467e8f76e313c7a77016f2dc81d3629b8e7f0c9e202110c231541" } : {}),
    ...(index === 2 ? { sha256: "060521b0b81f91948d8ded9139e423e5d0c9e6808a45c81750cc30519de4d2db" } : {}),
  })),
};

export function transformTrust(source, target, reverse = false) {
  for (const pair of reverse ? [...target.changes].reverse() : target.changes) {
    const [search, replacement] = reverse ? [...pair].reverse() : pair;
    const parts = source.split(search);
    if (parts.length !== 2) throw new Error(`Unknown trust patch input: ${target.path}`);
    source = parts.join(replacement);
  }
  return source;
}

export async function patchProjectTrust(packageRoot) {
  const root = resolve(packageRoot);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (manifest.name !== "@earendil-works/pi-coding-agent" || !Object.hasOwn(TRUST_TARGETS_BY_VERSION, manifest.version)) {
    throw new Error(`Project-trust patch requires @earendil-works/pi-coding-agent ${Object.keys(TRUST_TARGETS_BY_VERSION).join(" or ")}; unknown versions refused`);
  }
  const targets = TRUST_TARGETS_BY_VERSION[manifest.version];
  const digest = text => createHash("sha256").update(text).digest("hex");
  const plan = [];
  for (const target of targets) {
    const path = join(root, target.path);
    const source = await readFile(path, "utf8");
    if (digest(source) === target.sha256) {
      plan.push({ path, content: transformTrust(source, target), mode: (await stat(path)).mode });
    } else if (digest(transformTrust(source, target, true)) !== target.sha256) {
      throw new Error(`Unknown trust patch content: ${target.path}`);
    }
  }
  for (const entry of plan) {
    const temporary = `${entry.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, entry.content, { mode: entry.mode, flag: "wx" });
      await rename(temporary, entry.path);
    } finally { await rm(temporary, { force: true }); }
  }
  return { root, patched: plan.map(entry => entry.path), alreadyPatched: targets.length - plan.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/patch-project-trust.mjs <backed-up Pi package root>");
  console.log(JSON.stringify(await patchProjectTrust(process.argv[2]), null, 2));
}
