import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, cp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { patchPaste, PastePatchError } from "../scripts/patch-paste.mjs";
import {
  EXPECTED_PACKAGE_NAME,
  EXPECTED_TUI_PACKAGE_NAME,
  EXPECTED_VERSION,
  PATCHED_MARKER,
  TARGETS,
} from "../patches/paste-keepalive.mjs";
import { makeTmpDir } from "./fixtures/build.mjs";

const PI_TUI_TARGET = TARGETS.find((t) => t.id === "pi-tui-dependency-terminal");

// Verbatim pristine dist/terminal.js of the real npm @earendil-works/pi-tui
// 0.87.1 package (offline-verified via `npm pack --ignore-scripts` during
// development; sha256 checked against PI_TUI_TARGET.pristineSha256 below).
// Embedded as a string constant (rather than a separate fixture file) so
// this test file is the single artifact needed to exercise the real target
// data end to end.
const PI_TUI_PRISTINE_SOURCE = "import * as fs from \"node:fs\";\nimport * as path from \"node:path\";\nimport { setKittyProtocolActive } from \"./keys.js\";\nimport { isNativeModifierPressed } from \"./native-modifiers.js\";\nimport { getNativePlatformHelper } from \"./native-platform.js\";\nimport { StdinBuffer } from \"./stdin-buffer.js\";\nconst TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;\nconst TERMINAL_PROGRESS_ACTIVE_SEQUENCE = \"\\x1b]9;4;3\\x07\";\nconst TERMINAL_PROGRESS_CLEAR_SEQUENCE = \"\\x1b]9;4;0\\x07\";\nconst NATIVE_SHIFT_ENTER_SEQUENCE = \"\\x1b[13;2u\";\nconst DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS = 7;\nconst KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS = 150;\nconst KITTY_KEYBOARD_PROTOCOL_QUERY = `\\x1b[>${DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS}u\\x1b[?u\\x1b[c`;\nexport function parseKeyboardProtocolNegotiationSequence(sequence) {\n    const kittyFlags = sequence.match(/^\\x1b\\[\\?(\\d+)u$/);\n    if (kittyFlags) {\n        return { type: \"kitty-flags\", flags: Number.parseInt(kittyFlags[1], 10) };\n    }\n    if (/^\\x1b\\[\\?[\\d;]*c$/.test(sequence)) {\n        return { type: \"device-attributes\" };\n    }\n    return undefined;\n}\nfunction isKeyboardProtocolNegotiationSequencePrefix(sequence) {\n    return sequence === \"\\x1b[\" || /^\\x1b\\[\\?[\\d;]*$/.test(sequence);\n}\nexport function isAppleTerminalSession() {\n    return process.platform === \"darwin\" && process.env.TERM_PROGRAM === \"Apple_Terminal\";\n}\n/**\n * Refresh terminal dimensions on POSIX platforms by sending SIGWINCH to this process.\n * Best-effort: some environments (restricted seccomp or LSM policies) return EACCES\n * for `kill(2)`; in that case the dimensions refresh is skipped rather than crashing.\n */\nexport function refreshTerminalDimensions() {\n    if (process.platform === \"win32\" || process.pid <= 0)\n        return;\n    try {\n        process.kill(process.pid, \"SIGWINCH\");\n    }\n    catch {\n        // Signal delivery not permitted in this environment; ignore.\n    }\n}\nexport function normalizeNativeShiftEnterInput(data, shouldDetectNativeShiftEnter, isShiftPressed) {\n    if (shouldDetectNativeShiftEnter && data === \"\\r\" && isShiftPressed)\n        return NATIVE_SHIFT_ENTER_SEQUENCE;\n    return data;\n}\nexport function normalizeAppleTerminalInput(data, isAppleTerminal, isShiftPressed) {\n    return normalizeNativeShiftEnterInput(data, isAppleTerminal, isShiftPressed);\n}\nconst DEFAULT_ESCAPE_TIMEOUT_MS = 10;\nconst DEFAULT_SSH_ESCAPE_TIMEOUT_MS = 100;\n/**\n * Resolve how long to wait for the rest of an escape sequence before\n * dispatching a lone ESC as the Escape key. Legacy Alt+key input is ESC plus\n * another byte, so high-latency transports need a longer reassembly window.\n */\nexport function resolveEscapeTimeoutMs(env = process.env) {\n    const configured = Number(env.PI_TUI_ESC_TIMEOUT);\n    if (Number.isFinite(configured) && configured > 0) {\n        return configured;\n    }\n    if (env.SSH_CONNECTION || env.SSH_TTY) {\n        return DEFAULT_SSH_ESCAPE_TIMEOUT_MS;\n    }\n    return DEFAULT_ESCAPE_TIMEOUT_MS;\n}\n/**\n * Real terminal using process.stdin/stdout\n */\nexport class ProcessTerminal {\n    wasRaw = false;\n    inputHandler;\n    resizeHandler;\n    _kittyProtocolActive = false;\n    _modifyOtherKeysActive = false;\n    keyboardProtocolPushed = false;\n    keyboardProtocolNegotiationBuffer = \"\";\n    keyboardProtocolBufferFlushTimer;\n    stdinBuffer;\n    stdinDataHandler;\n    progressInterval;\n    writeLogPath = (() => {\n        const env = process.env.PI_TUI_WRITE_LOG || \"\";\n        if (!env)\n            return \"\";\n        try {\n            if (fs.statSync(env).isDirectory()) {\n                const now = new Date();\n                const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, \"0\")}-${String(now.getDate()).padStart(2, \"0\")}_${String(now.getHours()).padStart(2, \"0\")}-${String(now.getMinutes()).padStart(2, \"0\")}-${String(now.getSeconds()).padStart(2, \"0\")}`;\n                return path.join(env, `tui-${ts}-${process.pid}.log`);\n            }\n        }\n        catch {\n            // Not an existing directory - use as-is (file path)\n        }\n        return env;\n    })();\n    get kittyProtocolActive() {\n        return this._kittyProtocolActive;\n    }\n    get modifyOtherKeysActive() {\n        return this._modifyOtherKeysActive;\n    }\n    start(onInput, onResize) {\n        this.inputHandler = onInput;\n        this.resizeHandler = onResize;\n        // Save previous state and enable raw mode\n        this.wasRaw = process.stdin.isRaw || false;\n        if (process.stdin.setRawMode) {\n            process.stdin.setRawMode(true);\n        }\n        process.stdin.setEncoding(\"utf8\");\n        process.stdin.resume();\n        // Enable bracketed paste mode - terminal will wrap pastes in \\x1b[200~ ... \\x1b[201~\n        process.stdout.write(\"\\x1b[?2004h\");\n        // Set up resize handler immediately\n        process.stdout.on(\"resize\", this.resizeHandler);\n        // Refresh terminal dimensions - they may be stale after suspend/resume\n        // (SIGWINCH is lost while process is stopped). Unix only, best-effort.\n        refreshTerminalDimensions();\n        // On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends\n        // VT escape sequences (e.g. \\x1b[Z for Shift+Tab) instead of raw console\n        // events that lose modifier information. Must run AFTER setRawMode(true)\n        // since that resets console mode flags.\n        this.enableWindowsVTInput();\n        // Query Kitty keyboard protocol and fall back to modifyOtherKeys when DA confirms no Kitty response.\n        // See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/\n        this.queryAndEnableKittyProtocol();\n    }\n    /**\n     * Set up StdinBuffer to split batched input into individual sequences.\n     * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.\n     *\n     * Also watches for Kitty protocol response and enables it when detected.\n     * This is done here (after stdinBuffer parsing) rather than on raw stdin\n     * to handle the case where the response arrives split across multiple events.\n     */\n    setupStdinBuffer() {\n        this.stdinBuffer = new StdinBuffer({ escapeTimeout: resolveEscapeTimeoutMs() });\n        // Forward individual sequences to the input handler\n        this.stdinBuffer.on(\"data\", (sequence) => {\n            const negotiationSequence = this.readKeyboardProtocolNegotiationSequence(sequence);\n            if (negotiationSequence === \"pending\") {\n                this.scheduleKeyboardProtocolNegotiationBufferFlush();\n                return; // Wait briefly for the rest of a split Kitty response.\n            }\n            if (this.handleKeyboardProtocolNegotiationSequence(negotiationSequence)) {\n                return;\n            }\n            this.forwardInputSequence(sequence);\n        });\n        // Re-wrap paste content with bracketed paste markers for existing editor handling\n        this.stdinBuffer.on(\"paste\", (content) => {\n            if (this.inputHandler) {\n                this.inputHandler(`\\x1b[200~${content}\\x1b[201~`);\n            }\n        });\n        // Handler that pipes stdin data through the buffer\n        this.stdinDataHandler = (data) => {\n            this.stdinBuffer.process(data);\n        };\n    }\n    /**\n     * Query terminal for Kitty keyboard protocol support and enable it if available.\n     *\n     * Kitty's progressive enhancement detection requires requesting the desired\n     * flags before querying them. The trailing DA query is a sentinel supported by\n     * terminals that do not know Kitty keyboard protocol; receiving DA before a\n     * Kitty response enables modifyOtherKeys fallback without a startup timeout.\n     *\n     * The requested flags are:\n     * - 1 = disambiguate escape codes\n     * - 2 = report event types (press/repeat/release)\n     * - 4 = report alternate keys (shifted key, base layout key)\n     */\n    queryAndEnableKittyProtocol() {\n        this.setupStdinBuffer();\n        process.stdin.on(\"data\", this.stdinDataHandler);\n        this.keyboardProtocolPushed = true;\n        this.clearKeyboardProtocolNegotiationBuffer();\n        process.stdout.write(KITTY_KEYBOARD_PROTOCOL_QUERY);\n    }\n    handleKeyboardProtocolNegotiationSequence(negotiationSequence) {\n        if (!negotiationSequence)\n            return false;\n        this.clearKeyboardProtocolNegotiationBuffer();\n        if (negotiationSequence.type === \"kitty-flags\") {\n            if (negotiationSequence.flags !== 0) {\n                this.disableModifyOtherKeys();\n                if (!this._kittyProtocolActive) {\n                    this._kittyProtocolActive = true;\n                    setKittyProtocolActive(true);\n                }\n            }\n            else {\n                this.enableModifyOtherKeys();\n            }\n            return true;\n        }\n        if (!this._kittyProtocolActive) {\n            this.enableModifyOtherKeys();\n        }\n        return true;\n    }\n    readKeyboardProtocolNegotiationSequence(sequence) {\n        if (this.keyboardProtocolNegotiationBuffer) {\n            const bufferedSequence = this.keyboardProtocolNegotiationBuffer + sequence;\n            const negotiationSequence = parseKeyboardProtocolNegotiationSequence(bufferedSequence);\n            if (negotiationSequence) {\n                this.clearKeyboardProtocolNegotiationBuffer();\n                return negotiationSequence;\n            }\n            if (isKeyboardProtocolNegotiationSequencePrefix(bufferedSequence)) {\n                this.setKeyboardProtocolNegotiationBuffer(bufferedSequence);\n                return \"pending\";\n            }\n            this.flushKeyboardProtocolNegotiationBufferAsInput();\n        }\n        const negotiationSequence = parseKeyboardProtocolNegotiationSequence(sequence);\n        if (negotiationSequence)\n            return negotiationSequence;\n        if (isKeyboardProtocolNegotiationSequencePrefix(sequence)) {\n            this.setKeyboardProtocolNegotiationBuffer(sequence);\n            return \"pending\";\n        }\n        return undefined;\n    }\n    setKeyboardProtocolNegotiationBuffer(sequence) {\n        this.clearKeyboardProtocolNegotiationBufferFlushTimer();\n        this.keyboardProtocolNegotiationBuffer = sequence;\n    }\n    clearKeyboardProtocolNegotiationBuffer() {\n        this.clearKeyboardProtocolNegotiationBufferFlushTimer();\n        this.keyboardProtocolNegotiationBuffer = \"\";\n    }\n    flushKeyboardProtocolNegotiationBufferAsInput() {\n        if (!this.keyboardProtocolNegotiationBuffer)\n            return;\n        const sequence = this.keyboardProtocolNegotiationBuffer;\n        this.clearKeyboardProtocolNegotiationBuffer();\n        this.forwardInputSequence(sequence);\n    }\n    scheduleKeyboardProtocolNegotiationBufferFlush() {\n        if (!this.keyboardProtocolNegotiationBuffer || this.keyboardProtocolBufferFlushTimer)\n            return;\n        this.keyboardProtocolBufferFlushTimer = setTimeout(() => {\n            this.keyboardProtocolBufferFlushTimer = undefined;\n            this.flushKeyboardProtocolNegotiationBufferAsInput();\n        }, KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS);\n    }\n    clearKeyboardProtocolNegotiationBufferFlushTimer() {\n        if (!this.keyboardProtocolBufferFlushTimer)\n            return;\n        clearTimeout(this.keyboardProtocolBufferFlushTimer);\n        this.keyboardProtocolBufferFlushTimer = undefined;\n    }\n    forwardInputSequence(sequence) {\n        if (!this.inputHandler)\n            return;\n        const shouldDetectNativeShiftEnter = sequence === \"\\r\" && (isAppleTerminalSession() || process.platform === \"win32\");\n        const input = normalizeNativeShiftEnterInput(sequence, shouldDetectNativeShiftEnter, shouldDetectNativeShiftEnter && isNativeModifierPressed(\"shift\"));\n        this.inputHandler(input);\n    }\n    enableModifyOtherKeys() {\n        if (this._kittyProtocolActive || this._modifyOtherKeysActive)\n            return;\n        process.stdout.write(\"\\x1b[>4;2m\");\n        this._modifyOtherKeysActive = true;\n    }\n    disableModifyOtherKeys() {\n        if (!this._modifyOtherKeysActive)\n            return;\n        process.stdout.write(\"\\x1b[>4;0m\");\n        this._modifyOtherKeysActive = false;\n    }\n    /**\n     * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT (0x0200) to the stdin\n     * console handle so the terminal sends VT sequences for modified keys\n     * (e.g. \\x1b[Z for Shift+Tab). Without this, libuv's ReadConsoleInputW\n     * discards modifier state and Shift+Tab arrives as plain \\t.\n     */\n    enableWindowsVTInput() {\n        if (process.platform !== \"win32\")\n            return;\n        try {\n            getNativePlatformHelper()?.enableVirtualTerminalInput?.();\n        }\n        catch {\n            // Native helper not available — Shift+Tab won't be distinguishable from Tab.\n        }\n    }\n    async drainInput(maxMs = 1000, idleMs = 50) {\n        const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;\n        this.clearKeyboardProtocolNegotiationBuffer();\n        if (shouldDisableKittyProtocol) {\n            // Disable Kitty keyboard protocol first so any late key releases\n            // do not generate new Kitty escape sequences.\n            process.stdout.write(\"\\x1b[<u\");\n            this.keyboardProtocolPushed = false;\n            this._kittyProtocolActive = false;\n            setKittyProtocolActive(false);\n        }\n        this.disableModifyOtherKeys();\n        const previousHandler = this.inputHandler;\n        this.inputHandler = undefined;\n        let lastDataTime = Date.now();\n        const onData = () => {\n            lastDataTime = Date.now();\n        };\n        process.stdin.on(\"data\", onData);\n        const endTime = Date.now() + maxMs;\n        try {\n            while (true) {\n                const now = Date.now();\n                const timeLeft = endTime - now;\n                if (timeLeft <= 0)\n                    break;\n                if (now - lastDataTime >= idleMs)\n                    break;\n                await new Promise((resolve) => setTimeout(resolve, Math.min(idleMs, timeLeft)));\n            }\n        }\n        finally {\n            process.stdin.removeListener(\"data\", onData);\n            this.inputHandler = previousHandler;\n        }\n    }\n    stop() {\n        if (this.clearProgressInterval()) {\n            process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);\n        }\n        // Disable bracketed paste mode\n        process.stdout.write(\"\\x1b[?2004l\");\n        const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;\n        this.clearKeyboardProtocolNegotiationBuffer();\n        // Disable Kitty keyboard protocol if not already done by drainInput()\n        if (shouldDisableKittyProtocol) {\n            process.stdout.write(\"\\x1b[<u\");\n            this.keyboardProtocolPushed = false;\n            this._kittyProtocolActive = false;\n            setKittyProtocolActive(false);\n        }\n        this.disableModifyOtherKeys();\n        // Clean up StdinBuffer\n        if (this.stdinBuffer) {\n            this.stdinBuffer.destroy();\n            this.stdinBuffer = undefined;\n        }\n        // Remove event handlers\n        if (this.stdinDataHandler) {\n            process.stdin.removeListener(\"data\", this.stdinDataHandler);\n            this.stdinDataHandler = undefined;\n        }\n        this.inputHandler = undefined;\n        if (this.resizeHandler) {\n            process.stdout.removeListener(\"resize\", this.resizeHandler);\n            this.resizeHandler = undefined;\n        }\n        // Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being\n        // re-interpreted after raw mode is disabled. This fixes a race condition\n        // where Ctrl+D could close the parent shell over SSH.\n        process.stdin.pause();\n        // Restore raw mode state\n        if (process.stdin.setRawMode) {\n            process.stdin.setRawMode(this.wasRaw);\n        }\n    }\n    write(data) {\n        process.stdout.write(data);\n        if (this.writeLogPath) {\n            try {\n                fs.appendFileSync(this.writeLogPath, data, { encoding: \"utf8\" });\n            }\n            catch {\n                // Ignore logging errors\n            }\n        }\n    }\n    get columns() {\n        return process.stdout.columns || Number(process.env.COLUMNS) || 80;\n    }\n    get rows() {\n        return process.stdout.rows || Number(process.env.LINES) || 24;\n    }\n    moveBy(lines) {\n        if (lines > 0) {\n            // Move down\n            process.stdout.write(`\\x1b[${lines}B`);\n        }\n        else if (lines < 0) {\n            // Move up\n            process.stdout.write(`\\x1b[${-lines}A`);\n        }\n        // lines === 0: no movement\n    }\n    hideCursor() {\n        process.stdout.write(\"\\x1b[?25l\");\n    }\n    showCursor() {\n        process.stdout.write(\"\\x1b[?25h\");\n    }\n    clearLine() {\n        process.stdout.write(\"\\x1b[K\");\n    }\n    clearFromCursor() {\n        process.stdout.write(\"\\x1b[J\");\n    }\n    clearScreen() {\n        process.stdout.write(\"\\x1b[2J\\x1b[H\"); // Clear screen and move to home (1,1)\n    }\n    setTitle(title) {\n        // OSC 0;title BEL - set terminal window title\n        process.stdout.write(`\\x1b]0;${title}\\x07`);\n    }\n    setProgress(active) {\n        if (active) {\n            // OSC 9;4;3 - indeterminate progress\n            process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);\n            if (!this.progressInterval) {\n                this.progressInterval = setInterval(() => {\n                    process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);\n                }, TERMINAL_PROGRESS_KEEPALIVE_MS);\n            }\n        }\n        else {\n            this.clearProgressInterval();\n            // OSC 9;4;0 - clear progress\n            process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);\n        }\n    }\n    clearProgressInterval() {\n        if (!this.progressInterval)\n            return false;\n        clearInterval(this.progressInterval);\n        this.progressInterval = undefined;\n        return true;\n    }\n}\n//# sourceMappingURL=terminal.js.map";

// Minimal offline stand-ins for the modules dist/terminal.js imports
// (./keys.js, ./native-modifiers.js, ./native-platform.js,
// ./stdin-buffer.js), just enough to let start()/drainInput()/stop() run
// for real without pulling in the rest of pi-tui.
const STUB_KEYS_SOURCE = "// Minimal offline stub for pi-tui's ./keys.js, used only to satisfy the\n// relative import in the patched dist/terminal.js fixture under test.\nexport function setKittyProtocolActive() {}\n";
const STUB_NATIVE_MODIFIERS_SOURCE = "// Minimal offline stub for pi-tui's ./native-modifiers.js.\nexport function isNativeModifierPressed() {\n\treturn false;\n}\n";
const STUB_NATIVE_PLATFORM_SOURCE = "// Minimal offline stub for pi-tui's ./native-platform.js.\nexport function getNativePlatformHelper() {\n\treturn undefined;\n}\n";
const STUB_STDIN_BUFFER_SOURCE = "// Minimal offline stub for pi-tui's ./stdin-buffer.js. ProcessTerminal only\n// needs an instantiable object with .on()/.process()/.destroy(); it never\n// exercises real sequence parsing in these lifecycle tests.\nexport class StdinBuffer {\n\ton() {\n\t\treturn this;\n\t}\n\tprocess() {}\n\tdestroy() {}\n}\n";

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Coding-agent package root with only the (optional) pi-tui target wired in,
 * so tests don't need the multi-megabyte real bundled CLI chunk to exercise
 * the real pi-tui-dependency-terminal replacement data end to end. */
async function buildCodingAgentRootWithPiTui({ tuiVersion = EXPECTED_VERSION } = {}) {
  const root = join(await makeTmpDir("pi-agent-paste-patch-"), "pkg");
  await mkdir(root, { recursive: true });
  await writeJson(join(root, "package.json"), { name: EXPECTED_PACKAGE_NAME, version: EXPECTED_VERSION });
  const tuiRoot = join(root, "node_modules", "@earendil-works", "pi-tui");
  const tuiDist = join(tuiRoot, "dist");
  await mkdir(tuiDist, { recursive: true });
  await writeJson(join(tuiRoot, "package.json"), { name: EXPECTED_TUI_PACKAGE_NAME, version: tuiVersion });
  await writeFile(join(tuiDist, "terminal.js"), PI_TUI_PRISTINE_SOURCE);
  await writeFile(join(tuiDist, "keys.js"), STUB_KEYS_SOURCE);
  await writeFile(join(tuiDist, "native-modifiers.js"), STUB_NATIVE_MODIFIERS_SOURCE);
  await writeFile(join(tuiDist, "native-platform.js"), STUB_NATIVE_PLATFORM_SOURCE);
  await writeFile(join(tuiDist, "stdin-buffer.js"), STUB_STDIN_BUFFER_SOURCE);
  return { root, tuiTerminalPath: join(tuiDist, "terminal.js") };
}

function fakeStdout({ isTTY }) {
  return {
    isTTY,
    written: [],
    listeners: {},
    write(data) {
      this.written.push(data);
      return true;
    },
    on(event, handler) {
      this.listeners[event] = handler;
    },
    removeListener(event) {
      delete this.listeners[event];
    },
  };
}

function fakeStdin() {
  return {
    isRaw: false,
    listeners: {},
    setRawMode() {},
    setEncoding() {},
    resume() {},
    pause() {},
    on(event, handler) {
      this.listeners[event] = handler;
    },
    removeListener(event) {
      delete this.listeners[event];
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Shipped patch data matches the real npm pi-tui 0.87.1 dependency file,
//    and the patched module actually runs (lifecycle behavior, not string).
// ---------------------------------------------------------------------------

test("pi-tui target: pinned sha256 matches the real npm 0.87.1 dist/terminal.js fixture", async () => {
  const digest = createHash("sha256").update(PI_TUI_PRISTINE_SOURCE, "utf8").digest("hex");
  assert.equal(digest, PI_TUI_TARGET.pristineSha256);
  for (const { search } of PI_TUI_TARGET.replacements) {
    assert.equal(
      PI_TUI_PRISTINE_SOURCE.split(search).length - 1,
      1,
      `anchor should occur exactly once: ${search.slice(0, 40)}`,
    );
  }
});

test("patchPaste(): patches the real pi-tui dependency file end to end and it stays runnable", async (t) => {
  const { root, tuiTerminalPath } = await buildCodingAgentRootWithPiTui();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await patchPaste(root, { targets: TARGETS.filter((tg) => tg.id === "pi-tui-dependency-terminal") });
  assert.deepEqual(result.patched, ["pi-tui-dependency-terminal"]);
  assert.deepEqual(result.alreadyPatched, []);

  const patchedSource = await readFile(tuiTerminalPath, "utf8");
  assert.ok(patchedSource.includes(PATCHED_MARKER));

  const mod = await import(pathToFileURL(tuiTerminalPath).href);
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const calls = { setInterval: 0, clearInterval: 0 };
  const liveTimers = new Set();
  globalThis.setInterval = (fn, ms) => {
    calls.setInterval += 1;
    const timer = originalSetInterval(fn, ms);
    timer.unref = () => {
      timer.unrefCalled = true;
      return timer;
    };
    liveTimers.add(timer);
    return timer;
  };
  globalThis.clearInterval = (timer) => {
    calls.clearInterval += 1;
    liveTimers.delete(timer);
    return originalClearInterval(timer);
  };
  const originalStdout = process.stdout;
  const originalStdin = process.stdin;
  try {
    const terminal = new mod.ProcessTerminal();

    // Non-TTY stdout: no keepalive interval should be armed.
    Object.defineProperty(process, "stdout", { value: fakeStdout({ isTTY: false }), configurable: true });
    Object.defineProperty(process, "stdin", { value: fakeStdin(), configurable: true });
    terminal.start(
      () => {},
      () => {},
    );
    assert.equal(terminal.bracketedPasteKeepaliveInterval, undefined, "non-TTY stdout must not get a keepalive interval");
    assert.equal(calls.setInterval, 0);

    // TTY stdout: keepalive interval is armed and unref'd.
    Object.defineProperty(process, "stdout", { value: fakeStdout({ isTTY: true }), configurable: true });
    terminal.start(
      () => {},
      () => {},
    );
    assert.equal(calls.setInterval, 1);
    const firstInterval = terminal.bracketedPasteKeepaliveInterval;
    assert.ok(firstInterval, "TTY stdout must get a keepalive interval");
    assert.ok(firstInterval.unrefCalled, "keepalive interval must be unref'd");
    assert.ok(process.stdout.written.some((chunk) => chunk === "\x1b[?2004h"));

    // Double start(): old interval is cleared before a new one is armed.
    terminal.start(
      () => {},
      () => {},
    );
    assert.equal(calls.clearInterval, 1, "second start() must clear the previous interval");
    assert.equal(calls.setInterval, 2);
    assert.notEqual(terminal.bracketedPasteKeepaliveInterval, firstInterval);

    // drainInput() clears the keepalive interval.
    await terminal.drainInput(1, 1);
    assert.equal(calls.clearInterval, 2);
    assert.equal(terminal.bracketedPasteKeepaliveInterval, undefined);

    // stop() is a no-op on an already-cleared interval, and disables paste mode.
    terminal.start(
      () => {},
      () => {},
    );
    assert.equal(calls.setInterval, 3);
    terminal.stop();
    assert.equal(calls.clearInterval, 3, "stop() clears an armed keepalive interval");
    assert.equal(terminal.bracketedPasteKeepaliveInterval, undefined);
    assert.ok(process.stdout.written.includes("\x1b[?2004l"));
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    for (const timer of liveTimers) originalClearInterval(timer);
    Object.defineProperty(process, "stdout", { value: originalStdout, configurable: true });
    Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Orchestration guards (fail-closed, validate-all-before-write,
//    idempotency) exercised against small synthetic targets — no dependency
//    on any real npm artifact for these.
// ---------------------------------------------------------------------------

function sha256Of(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function makeSyntheticTarget({ id, required, body, badAnchor = false }) {
  const content = `let calls = 0;\n// marker: ${id}\nfunction run() {\n  calls += 1;\n  return "${body}";\n}\nexport { run };\n`;
  return {
    id,
    description: `synthetic target ${id}`,
    relativePath: `${id}.mjs`,
    required,
    pristineSha256: sha256Of(content),
    replacements: badAnchor
      ? [{ search: "does-not-exist-anywhere", replace: "unused" }]
      : [{ search: `return "${body}";`, replace: `return "${body}-${PATCHED_MARKER}";` }],
    __pristineContent: content,
  };
}

async function buildSyntheticRoot(targets, { name = EXPECTED_PACKAGE_NAME, version = EXPECTED_VERSION } = {}) {
  const root = join(await makeTmpDir("pi-agent-paste-patch-synth-"), "pkg");
  await mkdir(root, { recursive: true });
  await writeJson(join(root, "package.json"), { name, version });
  for (const target of targets) {
    if (target.__skipWrite) continue;
    await writeFile(join(root, target.relativePath), target.__pristineContent);
  }
  return root;
}

test("patchPaste(): fails closed on a package.json name mismatch, writes nothing", async (t) => {
  const required = makeSyntheticTarget({ id: "req-a", required: true, body: "hello" });
  const root = await buildSyntheticRoot([required], { name: "not-pi" });
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => patchPaste(root, { targets: [required] }), PastePatchError);
  const untouched = await readFile(join(root, required.relativePath), "utf8");
  assert.equal(untouched, required.__pristineContent);
});

test("patchPaste(): accepts the pinned 0.99.1 version without accepting arbitrary versions", async (t) => {
  const target = makeSyntheticTarget({ id: "new-runtime", required: true, body: "hello" });
  const root = await buildSyntheticRoot([target], { version: "0.99.1" });
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await patchPaste(root, { targets: [target] });
  assert.equal(result.version, "0.99.1");
  assert.deepEqual(result.patched, ["new-runtime"]);
  await assert.rejects(() => patchPaste(root), /chunk-AXPY26X7/);
});

test("patchPaste(): accepts pinned 1.0.1 and selects its own required bundle", async (t) => {
  const target = makeSyntheticTarget({ id: "runtime-101", required: true, body: "hello" });
  const root = await buildSyntheticRoot([target], { version: "1.0.1" });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await patchPaste(root, { targets: [target] })).version, "1.0.1");
  await assert.rejects(() => patchPaste(root), /chunk-6FX7UEPL/);
});

test("patchPaste(): fails closed on a package.json version mismatch", async (t) => {
  const required = makeSyntheticTarget({ id: "req-b", required: true, body: "hello" });
  const root = await buildSyntheticRoot([required], { version: "0.0.1" });
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => patchPaste(root, { targets: [required] }), PastePatchError);
});

test("patchPaste(): fails closed when a required target file is missing", async (t) => {
  const required = makeSyntheticTarget({ id: "req-c", required: true, body: "hello" });
  const root = await buildSyntheticRoot([{ ...required, __skipWrite: true }]);
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => patchPaste(root, { targets: [required] }), PastePatchError);
});

test("patchPaste(): fails closed on tampered (non-pristine, non-marker) content", async (t) => {
  const required = makeSyntheticTarget({ id: "req-d", required: true, body: "hello" });
  const root = await buildSyntheticRoot([required]);
  await writeFile(join(root, required.relativePath), "tampered content, not the pristine original\n");
  try {
    await assert.rejects(() => patchPaste(root, { targets: [required] }), PastePatchError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("patchPaste(): fails closed when a replacement anchor cannot be located exactly once", async (t) => {
  const required = makeSyntheticTarget({ id: "req-e", required: true, body: "hello", badAnchor: true });
  const root = await buildSyntheticRoot([required]);
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => patchPaste(root, { targets: [required] }), PastePatchError);
});

test("patchPaste(): validates every target before writing any — one bad optional target blocks a good required one", async (t) => {
  const required = makeSyntheticTarget({ id: "req-f", required: true, body: "hello" });
  const optionalBad = makeSyntheticTarget({ id: "opt-bad", required: false, badAnchor: true, body: "world" });
  const root = await buildSyntheticRoot([required, optionalBad]);
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => patchPaste(root, { targets: [required, optionalBad] }), PastePatchError);
  const untouched = await readFile(join(root, required.relativePath), "utf8");
  assert.equal(untouched, required.__pristineContent, "the good required target must stay untouched when another target fails validation");
});

test("patchPaste(): patches required + present optional targets, idempotent on replay", async (t) => {
  const required = makeSyntheticTarget({ id: "req-g", required: true, body: "hello" });
  const optional = makeSyntheticTarget({ id: "opt-g", required: false, body: "world" });
  const root = await buildSyntheticRoot([required, optional]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await patchPaste(root, { targets: [required, optional] });
  assert.deepEqual(first.patched.sort(), ["opt-g", "req-g"]);
  assert.deepEqual(first.alreadyPatched, []);
  assert.deepEqual(first.skipped, []);
  const patchedRequired = await readFile(join(root, required.relativePath), "utf8");
  assert.ok(patchedRequired.includes(PATCHED_MARKER));

  const second = await patchPaste(root, { targets: [required, optional] });
  assert.deepEqual(second.patched, []);
  assert.deepEqual(second.alreadyPatched.sort(), ["opt-g", "req-g"]);
  const stillPatched = await readFile(join(root, required.relativePath), "utf8");
  assert.equal(stillPatched, patchedRequired, "replay must not rewrite an already-patched file");
  await writeFile(join(root, required.relativePath), `${stillPatched}\n// tampered after patch\n`);
  await assert.rejects(() => patchPaste(root, { targets: [required, optional] }), /modified patched artifact/);
});

test("patchPaste(): missing optional target is skipped without error", async (t) => {
  const required = makeSyntheticTarget({ id: "req-h", required: true, body: "hello" });
  const optional = makeSyntheticTarget({ id: "opt-h", required: false, body: "world" });
  const root = await buildSyntheticRoot([required, { ...optional, __skipWrite: true }]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await patchPaste(root, { targets: [required, optional] });
  assert.deepEqual(result.patched, ["req-h"]);
  assert.deepEqual(result.skipped, ["opt-h"]);
});

test("patchPaste(): rejects an unknown/empty packageRoot before touching anything", async () => {
  await assert.rejects(() => patchPaste(""), PastePatchError);
  const missingParent = await makeTmpDir("pi-agent-paste-patch-missing-");
  await assert.rejects(() => patchPaste(join(missingParent, "does-not-exist")), PastePatchError);
});

test("patchPaste(): pi-tui optional target found via an ancestor node_modules (non-nested layout)", async (t) => {
  const { root: nestedRoot } = await buildCodingAgentRootWithPiTui();
  // Re-home the pi-tui package one level above a nested "app" packageRoot to
  // simulate a flattened/hoisted node_modules layout instead of the default
  // packageRoot/node_modules nesting used by the other tests.
  const outer = join(await makeTmpDir("pi-agent-paste-patch-hoisted-"), "outer");
  await mkdir(outer, { recursive: true });
  await cp(join(nestedRoot, "node_modules"), join(outer, "node_modules"), { recursive: true });
  const appRoot = join(outer, "app");
  await mkdir(appRoot, { recursive: true });
  await writeJson(join(appRoot, "package.json"), { name: EXPECTED_PACKAGE_NAME, version: EXPECTED_VERSION });
  t.after(async () => {
    await rm(nestedRoot, { recursive: true, force: true });
    await rm(outer, { recursive: true, force: true });
  });

  const result = await patchPaste(appRoot, { targets: [PI_TUI_TARGET] });
  assert.deepEqual(result.patched, ["pi-tui-dependency-terminal"]);
});
