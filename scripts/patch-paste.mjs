// Bounded, portable bracketed-paste keepalive patch for the PRIVATE npm
// runtime @earendil-works/pi-coding-agent versions pinned in the patch data.
//
// Reproduces textually (no rebuild, no esbuild) the terminal.ts fix already
// merged in the private source tree: a periodic, TTY-gated, unref'd resend of
// the bracketed-paste enable sequence (DEC private mode 2004), cleared on
// drainInput()/stop() and re-armed cleanly on every start() (a second start()
// clears any previous interval first, so it never leaks or doubles up).
//
// Stdlib only. Never touches a running/global Pi install directly: the
// caller passes the root of a package tree already staged on disk (e.g. an
// `npm pack --ignore-scripts` extraction, or a private mirror), and this
// module only reads/writes inside that tree.
import { createHash, randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
	EXPECTED_PACKAGE_NAME,
	EXPECTED_TUI_PACKAGE_NAME,
	PATCHED_MARKER,
	TARGETS,
	TARGETS_BY_VERSION,
} from "../patches/paste-keepalive.mjs";

export class PastePatchError extends Error {
	constructor(message) {
		super(message);
		this.name = "PastePatchError";
	}
}

function sha256(content) {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

async function readPackageManifest(packageDir) {
	const manifestPath = join(packageDir, "package.json");
	let raw;
	try {
		raw = await readFile(manifestPath, "utf8");
	} catch {
		throw new PastePatchError(`patch-paste: no readable package.json under ${packageDir}`);
	}
	let manifest;
	try {
		manifest = JSON.parse(raw);
	} catch {
		throw new PastePatchError(`patch-paste: malformed package.json at ${manifestPath}`);
	}
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
		throw new PastePatchError(`patch-paste: package.json at ${manifestPath} is not an object`);
	}
	return manifest;
}

function assertExpectedManifest(manifest, expectedName, manifestPath, expectedVersion) {
	if (manifest.name !== expectedName) {
		throw new PastePatchError(
			`patch-paste: ${manifestPath} declares name "${manifest.name}", expected "${expectedName}" — refusing (unknown input)`,
		);
	}
	if (manifest.version !== expectedVersion || !Object.hasOwn(TARGETS_BY_VERSION, manifest.version)) {
		throw new PastePatchError(
			`patch-paste: ${manifestPath} declares version "${manifest.version}", this patch only targets ${Object.keys(TARGETS_BY_VERSION).join(", ")} — refusing (unknown input)`,
		);
	}
}

/**
 * Node-resolution-style upward walk for `node_modules/@earendil-works/pi-tui`,
 * starting at (and including) packageRoot itself, then each ancestor
 * directory up to the filesystem root. Bounded by the filesystem depth.
 */
function findPiTuiPackageRoot(packageRoot) {
	let dir = packageRoot;
	for (;;) {
		const candidate = join(dir, "node_modules", "@earendil-works", "pi-tui");
		if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Apply every replacement of a target to `content`, requiring each search
 * string to occur exactly once. Throws PastePatchError otherwise (unknown/
 * modified content — fail closed instead of guessing).
 */
function applyReplacements(content, target, filePath, reverse = false) {
	let next = content;
	const replacements = reverse ? [...target.replacements].reverse().map(({ search, replace }) => ({ search: replace, replace: search })) : target.replacements;
	for (const { search, replace } of replacements) {
		const parts = next.split(search);
		if (parts.length !== 2) {
			throw new PastePatchError(
				`patch-paste: expected exactly one occurrence of a known anchor in ${filePath} ` +
					`(target "${target.id}"), found ${parts.length - 1} — refusing (unknown/modified content)`,
			);
		}
		next = parts.join(replace);
	}
	return next;
}

/**
 * Build the full write plan for every applicable target, validating
 * everything up front. Throws on any unexpected condition without writing
 * anything. Returns an array of plan entries:
 *   { target, filePath, action: "patch" | "already-patched" | "not-found", newContent? }
 */
async function planPatches(packageRoot, targets) {
	const manifest = await readPackageManifest(packageRoot);
	assertExpectedManifest(manifest, EXPECTED_PACKAGE_NAME, join(packageRoot, "package.json"), manifest.version);

	const plan = [];
	for (const target of targets ?? TARGETS_BY_VERSION[manifest.version]) {
		let baseDir = packageRoot;
		if (target.id === "pi-tui-dependency-terminal") {
			const tuiRoot = findPiTuiPackageRoot(packageRoot);
			if (!tuiRoot) {
				plan.push({ target, filePath: undefined, action: "not-found" });
				continue;
			}
			const tuiManifest = await readPackageManifest(tuiRoot);
			assertExpectedManifest(tuiManifest, EXPECTED_TUI_PACKAGE_NAME, join(tuiRoot, "package.json"), manifest.version);
			baseDir = tuiRoot;
		}

		const filePath = join(baseDir, target.relativePath);
		let content;
		try {
			content = await readFile(filePath, "utf8");
		} catch {
			if (target.required) {
				throw new PastePatchError(
					`patch-paste: required file missing for target "${target.id}": ${filePath}`,
				);
			}
			plan.push({ target, filePath, action: "not-found" });
			continue;
		}

		if (content.includes(PATCHED_MARKER)) {
			if (sha256(applyReplacements(content, target, filePath, true)) !== target.pristineSha256) {
				throw new PastePatchError(`patch-paste: modified patched artifact ${filePath} — refusing (unknown input)`);
			}
			plan.push({ target, filePath, action: "already-patched" });
			continue;
		}

		const digest = sha256(content);
		if (digest !== target.pristineSha256) {
			throw new PastePatchError(
				`patch-paste: ${filePath} does not match the known pristine content for ` +
					`${EXPECTED_PACKAGE_NAME}@${manifest.version} (sha256 ${digest}) — refusing (unknown input)`,
			);
		}

		const newContent = applyReplacements(content, target, filePath);
		plan.push({ target, filePath, action: "patch", newContent });
	}
	return { manifest, plan };
}

async function writeAtomic(filePath, content) {
	const tmpPath = join(dirname(filePath), `.paste-patch-${randomBytes(6).toString("hex")}.tmp`);
	await writeFile(tmpPath, content, "utf8");
	await rename(tmpPath, filePath);
}

/**
 * Patch a supported npm @earendil-works/pi-coding-agent version in place under
 * `packageRoot` so bracketed paste survives a mode-2004 reset (dropped
 * terminal state, nested reattach, etc.). Idempotent: already-patched files
 * are left untouched. Validates every target before writing any of them;
 * any unexpected content (wrong version, modified file, missing required
 * file) throws PastePatchError and writes nothing.
 *
 * @param {string} packageRoot absolute or relative path to the root of an
 *   installed/staged @earendil-works/pi-coding-agent package (the directory
 *   containing its package.json).
 * @param {{ targets?: typeof TARGETS, checkOnly?: boolean }} [options] `targets`
 *   overrides the version-specific target list for tests. `checkOnly` requires
 *   existing patches and refuses unpatched content without writing.
 * @returns {Promise<{ root: string, version: string, patched: string[], alreadyPatched: string[], skipped: string[] }>}
 */
export async function patchPaste(packageRoot, options = {}) {
	if (typeof packageRoot !== "string" || packageRoot.trim() === "") {
		throw new PastePatchError("patch-paste: packageRoot must be a non-empty string");
	}
	const root = resolvePath(packageRoot);
	if (!existsSync(root) || !statSync(root).isDirectory()) {
		throw new PastePatchError(`patch-paste: packageRoot is not a directory: ${root}`);
	}
	const targets = options.targets;

	const { manifest, plan } = await planPatches(root, targets);
	if (options.checkOnly && plan.some(entry => entry.action === "patch")) {
		throw new PastePatchError("Paste patch is missing; validate a patched runtime before activation");
	}

	const patched = [];
	const alreadyPatched = [];
	const skipped = [];
	for (const entry of plan) {
		if (entry.action === "patch") {
			await writeAtomic(entry.filePath, entry.newContent);
			patched.push(entry.target.id);
		} else if (entry.action === "already-patched") {
			alreadyPatched.push(entry.target.id);
		} else {
			skipped.push(entry.target.id);
		}
	}

	return { root, version: manifest.version, patched, alreadyPatched, skipped };
}

function printHelp() {
	console.log(
		"Usage: node scripts/patch-paste.mjs <packageRoot>\n\n" +
			`Applies the bracketed-paste keepalive patch to a staged copy of ` +
			`${EXPECTED_PACKAGE_NAME} (${Object.keys(TARGETS_BY_VERSION).join(", ")}). Never touches a running ` +
			"or global Pi install directly; point it at a package tree on disk.",
	);
}

async function main() {
	const [arg] = process.argv.slice(2);
	if (!arg || arg === "--help" || arg === "-h") {
		printHelp();
		process.exitCode = arg ? 0 : 1;
		return;
	}
	try {
		const result = await patchPaste(arg);
		console.log(`patch-paste: root=${result.root} version=${result.version}`);
		console.log(`patch-paste: patched=${result.patched.join(",") || "(none)"}`);
		console.log(`patch-paste: already-patched=${result.alreadyPatched.join(",") || "(none)"}`);
		console.log(`patch-paste: skipped(not-found)=${result.skipped.join(",") || "(none)"}`);
	} catch (err) {
		console.error(err instanceof PastePatchError ? err.message : `patch-paste: ${err.message}`);
		process.exitCode = 1;
	}
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
