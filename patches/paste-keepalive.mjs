// Data-only description of the bracketed-paste keepalive patch for npm
// @earendil-works/pi-coding-agent 0.87.1 and 0.99.1 (private runtime paste fix).
// No logic here on purpose: scripts/patch-paste.mjs owns validation/writes,
// this file only pins the exact byte-for-byte transform for one known version.
//
// Every `search`/`replace` string below is matched against the *source text*
// of the target file, not against an executed/evaluated version of it. The
// target files themselves are JS source containing string literals such as
// `"\x1b[?2004h"`; on disk that is the literal 4-character sequence
// backslash, x, 1, b (plus the bracket digits), not an actual ESC byte. To
// match that literal text, every backslash below is written doubled
// (`\\x1b`) so the *string value* we build here contains the same literal
// 4-character sequence as the file on disk — NOT a real ESC/BEL control
// byte. Do not "simplify" these to single backslashes: that would make the
// search/replace strings match real control bytes and never match the
// pristine source, causing every target to be rejected as unknown content.
//
// Origin: this reproduces, textually, the terminal.ts change already merged
// in the private source tree (see packages/tui/src/terminal.ts) that re-sends
// the bracketed-paste enable sequence (DEC private mode 2004) on a periodic,
// TTY-gated, unref'd interval, and clears that interval on drainInput()/stop()
// and on every call to start() (double-start clears the old interval first).

export const EXPECTED_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const EXPECTED_TUI_PACKAGE_NAME = "@earendil-works/pi-tui";
export const EXPECTED_VERSION = "0.87.1";

// Substring present only in an already-patched file. Used for idempotency:
// if a target file already contains it, patchPaste treats that file as done
// and skips it (no write), rather than re-applying or failing.
export const PATCHED_MARKER = "startBracketedPasteKeepalive";

/**
 * @typedef {{ search: string, replace: string }} Replacement
 * @typedef {{
 *   id: string,
 *   description: string,
 *   relativePath: string,
 *   required: boolean,
 *   pristineSha256: string,
 *   replacements: Replacement[],
 * }} PatchTarget
 */

/** @type {PatchTarget[]} */
export const TARGETS = [
	{
		id: "bundled-cli-chunk",
		description:
			"Minified terminal.ts code inlined into the esbuild chunk shipped inside " +
			"dist/bundle/chunks of the pi-coding-agent bundle (the code path the `pi` " +
			"bin actually runs).",
		relativePath: "dist/bundle/chunks/chunk-OJP47DM6.js",
		required: true,
		pristineSha256: "81c81a21ec81e84200205f561687408ff5e3738fbbbb3c2a6c186b348d376020",
		replacements: [
			{
				search: "stdinDataHandler;progressInterval;writeLogPath=",
				replace: "stdinDataHandler;progressInterval;bracketedPasteKeepaliveInterval;writeLogPath=",
			},
			{
				search:
					'process.stdout.write("\\x1B[?2004h"),process.stdout.on("resize",this.resizeHandler)',
				replace:
					'process.stdout.write("\\x1B[?2004h"),this.startBracketedPasteKeepalive(),process.stdout.on("resize",this.resizeHandler)',
			},
			{
				search: "async drainInput(maxMs=1e3,idleMs=50){let shouldDisableKittyProtocol=",
				replace:
					"async drainInput(maxMs=1e3,idleMs=50){this.clearBracketedPasteKeepalive();let shouldDisableKittyProtocol=",
			},
			{
				search:
					'stop(){this.clearProgressInterval()&&process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE),process.stdout.write("\\x1B[?2004l");let shouldDisableKittyProtocol=',
				replace:
					'stop(){this.clearProgressInterval()&&process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE),this.clearBracketedPasteKeepalive(),process.stdout.write("\\x1B[?2004l");let shouldDisableKittyProtocol=',
			},
			{
				search: "this.progressInterval=void 0,!0):!1}}",
				replace:
					'this.progressInterval=void 0,!0):!1}startBracketedPasteKeepalive(){this.clearBracketedPasteKeepalive(),process.stdout.isTTY&&(this.bracketedPasteKeepaliveInterval=setInterval(()=>{process.stdout.write("\\x1B[?2004h")},1e3),this.bracketedPasteKeepaliveInterval.unref?.())}clearBracketedPasteKeepalive(){this.bracketedPasteKeepaliveInterval&&(clearInterval(this.bracketedPasteKeepaliveInterval),this.bracketedPasteKeepaliveInterval=void 0)}}',
			},
		],
	},
	{
		id: "pi-tui-dependency-terminal",
		description:
			"Unbundled dist/terminal.js of the @earendil-works/pi-tui dependency, " +
			"present only when that package is resolvable on disk next to (or above) " +
			"the coding-agent package root (e.g. a non-flattened node_modules layout " +
			"or direct programmatic use of pi-tui). Optional: the bundled CLI chunk " +
			"above is the code path that actually runs the `pi` binary.",
		relativePath: "dist/terminal.js",
		required: false,
		pristineSha256: "d9636fd679aed23830be7c8d248d9725883efd43469392228275dac6a85fcc68",
		replacements: [
			{
				search:
					'const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\\x1b]9;4;0\\x07";\nconst NATIVE_SHIFT_ENTER_SEQUENCE = "\\x1b[13;2u";',
				replace:
					'const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\\x1b]9;4;0\\x07";\nconst TERMINAL_BRACKETED_PASTE_KEEPALIVE_MS = 1000;\nconst TERMINAL_BRACKETED_PASTE_ENABLE_SEQUENCE = "\\x1b[?2004h";\nconst TERMINAL_BRACKETED_PASTE_DISABLE_SEQUENCE = "\\x1b[?2004l";\nconst NATIVE_SHIFT_ENTER_SEQUENCE = "\\x1b[13;2u";',
			},
			{
				search: "    progressInterval;\n    writeLogPath = (() => {",
				replace:
					"    progressInterval;\n    bracketedPasteKeepaliveInterval;\n    writeLogPath = (() => {",
			},
			{
				search:
					'        process.stdout.write("\\x1b[?2004h");\n        // Set up resize handler immediately',
				replace:
					"        process.stdout.write(TERMINAL_BRACKETED_PASTE_ENABLE_SEQUENCE);\n        this.startBracketedPasteKeepalive();\n        // Set up resize handler immediately",
			},
			{
				search:
					"    async drainInput(maxMs = 1000, idleMs = 50) {\n        const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;",
				replace:
					"    startBracketedPasteKeepalive() {\n        this.clearBracketedPasteKeepalive();\n        if (!process.stdout.isTTY)\n            return;\n        this.bracketedPasteKeepaliveInterval = setInterval(() => {\n            process.stdout.write(TERMINAL_BRACKETED_PASTE_ENABLE_SEQUENCE);\n        }, TERMINAL_BRACKETED_PASTE_KEEPALIVE_MS);\n        this.bracketedPasteKeepaliveInterval.unref?.();\n    }\n    clearBracketedPasteKeepalive() {\n        if (!this.bracketedPasteKeepaliveInterval)\n            return;\n        clearInterval(this.bracketedPasteKeepaliveInterval);\n        this.bracketedPasteKeepaliveInterval = undefined;\n    }\n    async drainInput(maxMs = 1000, idleMs = 50) {\n        this.clearBracketedPasteKeepalive();\n        const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;",
			},
			{
				search:
					'        if (this.clearProgressInterval()) {\n            process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);\n        }\n        // Disable bracketed paste mode\n        process.stdout.write("\\x1b[?2004l");',
				replace:
					"        if (this.clearProgressInterval()) {\n            process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);\n        }\n        this.clearBracketedPasteKeepalive();\n        // Disable bracketed paste mode\n        process.stdout.write(TERMINAL_BRACKETED_PASTE_DISABLE_SEQUENCE);",
			},
		],
	},
];

// Verified against the published 0.99.1 artifacts; all replacement anchors are unchanged.
export const TARGETS_BY_VERSION = {
	[EXPECTED_VERSION]: TARGETS,
	"0.99.1": TARGETS.map((target) => ({
		...target,
		...(target.id === "bundled-cli-chunk"
			? { relativePath: "dist/bundle/chunks/chunk-AXPY26X7.js", pristineSha256: "39b67e80c6926e6c7cbbcb23c4a8c0bd7b43ea159ad4853bd5b9bc236237f2d6" }
			: { pristineSha256: "e3a594cb638d57da4e195bee6a4ad10e4ebeb3335dbf2bd9990d913ef03ee4fb" }),
	})),
};
