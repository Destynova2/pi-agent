import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Use the public TUI terminal and component lifecycle. Pi owns mode teardown.
export default function terminalPaste(pi: ExtensionAPI) {
  let dispose: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    dispose?.();
    if (ctx.mode !== "tui" || !process.stdout.isTTY || !process.stdin.isTTY) return;
    ctx.ui.setWidget("terminal-paste", tui => {
      dispose?.();
      const refresh = () => {
        // A child program or suspended Pi owns the terminal outside raw mode.
        if (process.stdout.isTTY && process.stdin.isTTY && process.stdin.isRaw) tui.terminal.write("\x1b[?2004h");
      };
      const timer = setInterval(refresh, 1000);
      timer.unref();
      refresh();
      const stop = () => clearInterval(timer);
      dispose = stop;
      return { render: () => [], invalidate() {}, dispose: stop };
    });
  });
  pi.on("session_shutdown", (_event, ctx) => {
    dispose?.();
    dispose = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget("terminal-paste", undefined);
  });
}
