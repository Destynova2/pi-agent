// Linux seccomp denies socket inspection on Node's child stdio socket pairs.
// Give language servers real pipes without changing their confinement policy.
import { spawn as nativeSpawn } from "node:child_process";
import { LINUX_STDIO_RELAY } from "../../scripts/codex-shell.mjs";

export function spawn(command, args, options) {
  if (process.platform !== "linux") return nativeSpawn(command, args, options);
  return nativeSpawn("/bin/bash", ["--noprofile", "--norc", "-c",
    LINUX_STDIO_RELAY,
    "pi-lsp-stdio", command, ...args], options);
}

export default spawn;
